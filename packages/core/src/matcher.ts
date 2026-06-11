import type { DedupConfig, NormalizedEntity, PairMatch } from './model.js';
import { extractFeatures, scorePair, type ScoreContext } from './scoring.js';

export interface MatchOptions {
  /** Skip blocking tokens that occur in more than this many entities. */
  maxTokenDf?: number;
}

interface Indexed {
  entity: NormalizedEntity;
  features: ReturnType<typeof extractFeatures>;
}

/**
 * Candidate generation (blocking): a pair is compared iff the two entities
 * share a canonical URL key or at least one name token. Tokens that occur in
 * more than `maxTokenDf` entities (e.g. the protocol name inside one
 * protocol's space) are skipped when the entity has rarer tokens to offer.
 */
function candidatePairs(left: Indexed[], right: Indexed[] | undefined, maxTokenDf: number): Array<[number, number]> {
  // right === undefined -> self-join over `left` (scan mode).
  const all = right ? [...left, ...right] : left;
  const tokenIndex = new Map<string, number[]>();
  const urlIndex = new Map<string, number[]>();

  all.forEach((item, idx) => {
    for (const t of new Set(item.features.tokens)) {
      const list = tokenIndex.get(t) ?? [];
      list.push(idx);
      tokenIndex.set(t, list);
    }
    for (const key of [
      ...item.features.uniqueUrls.keys(),
      ...item.features.profileUrls.keys(),
      ...item.features.looseUrls.keys(),
    ]) {
      const list = urlIndex.get(key) ?? [];
      list.push(idx);
      urlIndex.set(key, list);
    }
  });

  const leftCount = left.length;
  const isCross = (i: number, j: number): boolean => {
    if (!right) return true;
    const iLeft = i < leftCount;
    const jLeft = j < leftCount;
    return iLeft !== jLeft || (iLeft && jLeft); // drafts x targets, plus drafts x drafts
  };

  const pairs = new Set<string>();
  const out: Array<[number, number]> = [];
  const push = (i: number, j: number): void => {
    const a = Math.min(i, j);
    const b = Math.max(i, j);
    if (a === b) return;
    if (right && a >= leftCount) return; // targets x targets pairs are out of scope in lint mode
    if (!isCross(a, b)) return;
    const key = `${a}:${b}`;
    if (pairs.has(key)) return;
    pairs.add(key);
    out.push([a, b]);
  };

  for (const ids of urlIndex.values()) {
    for (let x = 0; x < ids.length; x++)
      for (let y = x + 1; y < ids.length; y++) push(ids[x] as number, ids[y] as number);
  }
  for (const [token, ids] of tokenIndex) {
    if (ids.length > maxTokenDf) continue;
    void token;
    for (let x = 0; x < ids.length; x++)
      for (let y = x + 1; y < ids.length; y++) push(ids[x] as number, ids[y] as number);
  }
  return out;
}

export interface MatchResult {
  pairs: PairMatch[];
  /** Clusters of indices into the combined entity list (score >= likely). */
  clusters: NormalizedEntity[][];
  pairFor: (aId: string, bId: string) => PairMatch | undefined;
}

class UnionFind {
  private parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(x: number): number {
    let r = x;
    while (this.parent[r] !== r) r = this.parent[r] as number;
    let c = x;
    while (this.parent[c] !== c) {
      const next = this.parent[c] as number;
      this.parent[c] = r;
      c = next;
    }
    return r;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
  }
}

/**
 * Scan mode: find duplicates among existing entities.
 * Lint mode: pass `drafts`; compares drafts vs targets and drafts vs drafts.
 */
export function match(
  targets: NormalizedEntity[],
  config: DedupConfig,
  drafts?: NormalizedEntity[],
  options?: MatchOptions,
): MatchResult {
  const maxTokenDf = options?.maxTokenDf ?? 200;
  const lintMode = drafts !== undefined;

  const leftEntities = lintMode ? drafts : targets;
  const rightEntities = lintMode ? targets : undefined;

  const left: Indexed[] = leftEntities.map(e => ({ entity: e, features: extractFeatures(e, config) }));
  const right: Indexed[] | undefined = rightEntities?.map(e => ({ entity: e, features: extractFeatures(e, config) }));
  const all: Indexed[] = right ? [...left, ...right] : left;

  // corpus URL-key document frequency -> hub detection in scorePair
  const urlDf = new Map<string, number>();
  for (const item of all) {
    for (const key of new Set([
      ...item.features.uniqueUrls.keys(),
      ...item.features.profileUrls.keys(),
      ...item.features.looseUrls.keys(),
    ])) {
      urlDf.set(key, (urlDf.get(key) ?? 0) + 1);
    }
  }
  const ctx: ScoreContext = { urlDf };

  const pairs: PairMatch[] = [];
  for (const [i, j] of candidatePairs(left, right, maxTokenDf)) {
    const A = all[i] as Indexed;
    const B = all[j] as Indexed;
    const result = scorePair(A.entity, B.entity, config, A.features, B.features, ctx);
    if (result.verdict !== 'distinct') pairs.push(result);
  }

  const uf = new UnionFind(all.length);
  const indexById = new Map<string, number>();
  all.forEach((item, idx) => indexById.set(item.entity.id, idx));
  // Hard clusters only: transitive merging across the likely band created
  // protocol-wide mega-clusters on real data (every Lido audit chained via a
  // shared docs URL). likely/weak pairs go to the review list instead.
  for (const p of pairs) {
    if (p.score >= config.thresholds.duplicate) {
      uf.union(indexById.get(p.a.id) as number, indexById.get(p.b.id) as number);
    }
  }

  const byRoot = new Map<number, NormalizedEntity[]>();
  all.forEach((item, idx) => {
    const root = uf.find(idx);
    const list = byRoot.get(root) ?? [];
    list.push(item.entity);
    byRoot.set(root, list);
  });
  const clusters = [...byRoot.values()].filter(c => c.length > 1);

  const pairKey = (x: string, y: string): string => (x < y ? `${x}|${y}` : `${y}|${x}`);
  const pairMap = new Map<string, PairMatch>();
  for (const p of pairs) pairMap.set(pairKey(p.a.id, p.b.id), p);

  return {
    pairs,
    clusters,
    pairFor: (aId, bId) => pairMap.get(pairKey(aId, bId)),
  };
}

/** Picks the canonical entity in a cluster and explains why. */
export function pickCanonical(cluster: NormalizedEntity[]): { canonical: NormalizedEntity; reason: string } {
  const sorted = [...cluster].sort((a, b) => {
    if (a.isDraft !== b.isDraft) return a.isDraft ? 1 : -1; // existing beats draft
    const richnessA = a.relations.length * 2 + a.values.length;
    const richnessB = b.relations.length * 2 + b.values.length;
    if (richnessA !== richnessB) return richnessB - richnessA; // richer wins
    return a.id < b.id ? -1 : 1; // stable tie-break
  });
  const canonical = sorted[0] as NormalizedEntity;
  const reason = canonical.isDraft
    ? 'richest draft (no existing entity in cluster)'
    : 'existing entity with most relations/values';
  return { canonical, reason };
}

/**
 * Resolve a name (e.g. an auditor company from a CSV column) to an existing
 * entity id. Returns the best match above `likely` with alternatives.
 */
export function resolveCanonical(
  name: string,
  candidates: NormalizedEntity[],
  config: DedupConfig,
  typeId?: string,
): { best?: { id: string; name: string; score: number }; alternatives: Array<{ id: string; name: string; score: number }> } {
  const probe: NormalizedEntity = {
    id: `probe:${name}`,
    isDraft: true,
    name,
    typeIds: typeId ? [typeId] : [],
    values: [],
    relations: [],
  };
  const scored = candidates
    .filter(c => !typeId || c.typeIds.includes(typeId) || c.typeIds.length === 0)
    .map(c => ({ c, m: scorePair(probe, c, config) }))
    .filter(({ m }) => m.score >= config.thresholds.weak)
    .sort((x, y) => y.m.score - x.m.score)
    .map(({ c, m }) => ({ id: c.id, name: c.name, score: Number(m.score.toFixed(3)) }));
  const best = scored[0];
  const result: {
    best?: { id: string; name: string; score: number };
    alternatives: Array<{ id: string; name: string; score: number }>;
  } = { alternatives: scored.slice(1, 4) };
  // `best` is the top candidate above the weak threshold; the score doubles
  // as confidence. Auto-linking should only trust score >= thresholds.likely;
  // anything below that is a suggestion for human review.
  if (best && best.score >= config.thresholds.weak) result.best = best;
  return result;
}
