import type { DedupConfig, EntityRelation, MatchSignal, NormalizedEntity, PairMatch, Verdict } from './model.js';
import {
  jaccard,
  normalizeName,
  tokenSetRatio,
  tokenSortRatio,
  tokenize,
  versionTokens,
  versionsDisjoint,
} from './signals/text.js';
import { canonicalUrlKey } from './signals/url-key.js';

interface EntityFeatures {
  normName: string;
  tokens: string[];
  versions: Set<string>;
  /** canonical url -> propertyId, split by tier */
  uniqueUrls: Map<string, string>;
  profileUrls: Map<string, string>;
  looseUrls: Map<string, string>;
  relationPairs: Set<string>;
  typeIds: Set<string>;
}

export function extractFeatures(e: NormalizedEntity, config: DedupConfig): EntityFeatures {
  const unique = new Set(config.uniqueUrlPropertyIds);
  const profile = new Set(config.profileUrlPropertyIds);
  const uniqueUrls = new Map<string, string>();
  const profileUrls = new Map<string, string>();
  const looseUrls = new Map<string, string>();
  for (const v of e.values) {
    if (typeof v.text !== 'string') continue;
    const key = canonicalUrlKey(v.text);
    if (!key) continue;
    if (unique.has(v.propertyId)) uniqueUrls.set(key, v.propertyId);
    else if (profile.has(v.propertyId)) profileUrls.set(key, v.propertyId);
    else looseUrls.set(key, v.propertyId);
  }
  const tokens = tokenize(e.name, config.nameStopwords);
  return {
    normName: normalizeName(e.name),
    tokens,
    versions: versionTokens(tokens),
    uniqueUrls,
    profileUrls,
    looseUrls,
    relationPairs: relationPairSet(e.relations),
    typeIds: new Set(e.typeIds),
  };
}

function relationPairSet(relations: readonly EntityRelation[]): Set<string> {
  const s = new Set<string>();
  for (const r of relations) {
    // The system TYPES relation is compared separately (typeIds); keeping it
    // here would inflate similarity between any two entities of the same type.
    if (r.typeId === SYSTEM_TYPES_RELATION) continue;
    s.add(`${r.typeId}->${r.toEntityId}`);
  }
  return s;
}

const SYSTEM_TYPES_RELATION = '8f151ba4de204e3c9cb499ddf96f48f1';

function setIntersects<T>(a: Set<T>, b: Set<T>): boolean {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

function firstSharedKey(a: Map<string, string>, b: Map<string, string>): string | undefined {
  for (const k of a.keys()) if (b.has(k)) return k;
  return undefined;
}

export interface ScoreContext {
  /** corpus document-frequency of canonical URL keys (hub detection) */
  urlDf?: Map<string, number> | undefined;
}

function setJaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Scores a pair of entities.
 *
 * Signal weights:
 *  - url.exact (shared URL, identity property: Report URL)   -> score 1.0, auto-duplicate
 *  - url.profile (shared Website/X/LinkedIn)                  -> +0.75 if types compatible, +0.4 if disjoint
 *  - name.exact (casefold/punctuation-insensitive equality)   -> +0.9
 *  - name.fuzzy >= 0.95                                       -> +0.7
 *  - name.fuzzy >= 0.85                                       -> +0.5
 *  - name.fuzzy >= fuzzyFloor (0.7)                           -> +0.2
 *  - url.loose (shared URL on an undeclared property)         -> +0.5 / +0.3 by type compatibility
 *  - shape.relations (types intersect, relation overlap)      -> +0.35 * jaccard
 *  - version.veto (disjoint version tokens)                   -> cap score at versionVetoCap
 */
export function scorePair(
  a: NormalizedEntity,
  b: NormalizedEntity,
  config: DedupConfig,
  fa?: EntityFeatures,
  fb?: EntityFeatures,
  ctx?: ScoreContext,
): PairMatch {
  const A = fa ?? extractFeatures(a, config);
  const B = fb ?? extractFeatures(b, config);
  const signals: MatchSignal[] = [];
  const dfOf = (key: string): number => ctx?.urlDf?.get(key) ?? 2;

  // Hub guard: a URL shared by many entities (a protocol's audits folder, a
  // project homepage stored in a free-form field) identifies a GROUP, not an
  // entity. Identity power only below the hub threshold.
  const sharedUniqueRaw = firstSharedKey(A.uniqueUrls, B.uniqueUrls);
  const sharedUnique = sharedUniqueRaw !== undefined && dfOf(sharedUniqueRaw) <= 3 ? sharedUniqueRaw : undefined;
  if (sharedUnique !== undefined) {
    signals.push({ kind: 'url.exact', score: 1.0, detail: sharedUnique });
  }

  const vetoed = versionsDisjoint(A.versions, B.versions);
  const typesCompatible =
    A.typeIds.size === 0 || B.typeIds.size === 0 || setIntersects(A.typeIds, B.typeIds);

  let score = 0;
  if (A.normName.length > 0 && A.normName === B.normName) {
    signals.push({ kind: 'name.exact', score: 0.9, detail: A.normName });
    score += 0.9;
  } else {
    const fuzzy =
      0.6 * Math.max(tokenSortRatio(A.tokens, B.tokens), tokenSetRatio(A.tokens, B.tokens)) +
      0.4 * jaccard(A.tokens, B.tokens);
    if (fuzzy >= config.fuzzyFloor) {
      const contribution = fuzzy >= 0.95 ? 0.7 : fuzzy >= 0.85 ? 0.5 : 0.2;
      signals.push({
        kind: 'name.fuzzy',
        score: contribution,
        detail: `similarity=${fuzzy.toFixed(3)} "${A.tokens.join(' ')}" ~ "${B.tokens.join(' ')}"`,
      });
      score += contribution;
    }
  }

  // a hub-grade "identity" URL still counts as profile-strength evidence
  const hubIdentity = sharedUniqueRaw !== undefined && sharedUnique === undefined ? sharedUniqueRaw : undefined;

  const sharedProfileRaw = hubIdentity ?? firstSharedKey(A.profileUrls, B.profileUrls);
  const sharedProfile =
    sharedProfileRaw !== undefined && dfOf(sharedProfileRaw) <= 10 ? sharedProfileRaw : undefined;
  if (sharedProfile !== undefined && sharedUnique === undefined) {
    const contribution = typesCompatible ? 0.75 : 0.4;
    signals.push({
      kind: 'url.profile',
      score: contribution,
      detail: `${sharedProfile}${typesCompatible ? '' : ' (disjoint types)'}${hubIdentity ? ` (hub df=${dfOf(sharedProfile)})` : ''}`,
    });
    score += contribution;
  }

  const sharedLooseRaw = firstSharedKey(A.looseUrls, B.looseUrls);
  const sharedLoose = sharedLooseRaw !== undefined && dfOf(sharedLooseRaw) <= 3 ? sharedLooseRaw : undefined;
  if (sharedLoose !== undefined && sharedUnique === undefined && sharedProfile === undefined) {
    const contribution = typesCompatible ? 0.4 : 0.25;
    signals.push({ kind: 'url.loose', score: contribution, detail: sharedLoose });
    score += contribution;
  }

  if (typesCompatible) {
    const j = setJaccard(A.relationPairs, B.relationPairs);
    if (j > 0) {
      const contribution = 0.35 * j;
      signals.push({ kind: 'shape.relations', score: contribution, detail: `relation-jaccard=${j.toFixed(2)}` });
      score += contribution;
    }
  }

  const conflictType = relationConflict(a, b);
  if (conflictType !== undefined) {
    signals.push({
      kind: 'relation.conflict',
      score: -1,
      detail: `relation type ${conflictType} points at disjoint targets on both sides`,
    });
    if (sharedUnique === undefined) score = Math.min(score, 0.55);
  }

  if (vetoed) {
    signals.push({
      kind: 'version.veto',
      score: -1,
      detail: `versions {${[...A.versions].join(',')}} vs {${[...B.versions].join(',')}}`,
    });
    score = Math.min(score, config.versionVetoCap);
  }

  // A unique-URL match overrides the version veto: the same Report URL is the
  // same report whatever the title says. EXCEPT when a relation conflict
  // contradicts it (same report link, different auditor — observed on
  // EigenLayer where the link is the audits FOLDER): that's a data
  // inconsistency for a human, pinned to 0.85 (top of the review band).
  if (sharedUnique !== undefined) score = conflictType !== undefined ? 0.85 : 1.0;

  score = Math.min(1, score);
  return { a, b, signals, score, verdict: verdictFor(score, config) };
}

const SYSTEM_TYPES_FOR_CONFLICT = '8f151ba4de204e3c9cb499ddf96f48f1';

/** Same relation type with non-overlapping target sets on both sides. */
function relationConflict(a: NormalizedEntity, b: NormalizedEntity): string | undefined {
  const byType = (e: NormalizedEntity): Map<string, Set<string>> => {
    const m = new Map<string, Set<string>>();
    for (const r of e.relations) {
      if (r.typeId === SYSTEM_TYPES_FOR_CONFLICT) continue;
      if (r.toEntityId.startsWith('unresolved:')) continue;
      const set = m.get(r.typeId) ?? new Set<string>();
      set.add(r.toEntityId);
      m.set(r.typeId, set);
    }
    return m;
  };
  const ma = byType(a);
  const mb = byType(b);
  for (const [typeId, ta] of ma) {
    const tb = mb.get(typeId);
    if (!tb || ta.size === 0 || tb.size === 0) continue;
    let intersects = false;
    for (const x of ta) if (tb.has(x)) { intersects = true; break; }
    if (!intersects) return typeId;
  }
  return undefined;
}

export function verdictFor(score: number, config: DedupConfig): Verdict {
  const t = config.thresholds;
  if (score >= t.duplicate) return 'duplicate';
  if (score >= t.likely) return 'likely';
  if (score >= t.weak) return 'weak';
  return 'distinct';
}
