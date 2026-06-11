/**
 * Domain model for the Geo Curator Copilot dedup engine.
 *
 * The engine is I/O-free: it operates on `NormalizedEntity` records that the
 * client layer builds either from GraphQL responses (existing space data) or
 * from a draft Edit / CSV batch (pre-publish lint).
 */

/** GRC-20 v2 id: UUID v4 without dashes (32 hex chars). */
export type GeoId = string;

export interface EntityValue {
  propertyId: GeoId;
  /** Raw text value as returned by the API / provided in the draft. */
  text?: string | undefined;
  boolean?: boolean | undefined;
  float?: number | undefined;
  datetime?: string | undefined;
}

export interface EntityRelation {
  /** Relation entity id (needed to generate delete/replace ops). May be unknown for drafts. */
  id?: GeoId | undefined;
  /** Relation type (property) id, e.g. "Auditor", "Audited protocol". */
  typeId: GeoId;
  toEntityId: GeoId;
  /** Optional resolved name of the target (drafts may carry names before id resolution). */
  toEntityName?: string | undefined;
}

/**
 * A uniform view over an entity, whether it already exists in a space or is a
 * draft about to be published.
 */
export interface NormalizedEntity {
  /** Existing entity id, or a draft ref like "draft:rowIndex" for batch rows. */
  id: GeoId | string;
  /** True when the entity does not exist in the space yet. */
  isDraft: boolean;
  name: string;
  /** Type entity ids (targets of the system TYPES relation). */
  typeIds: GeoId[];
  values: EntityValue[];
  relations: EntityRelation[];
  /** Optional provenance (csv row number, source file, etc.) for reporting. */
  source?: string | undefined;
}

/** A single matching signal between two entities. */
export interface MatchSignal {
  kind:
    | 'url.exact' // canonical URL on an identity property (Report URL) matches
    | 'url.profile' // canonical URL on a profile property (Website/X/LinkedIn) matches
    | 'url.loose' // canonical URL matches on an undeclared property
    | 'name.exact' // names equal after case-folding + punctuation normalization
    | 'name.fuzzy' // token-sort / token-set similarity
    | 'shape.relations' // overlapping (typeId -> toEntityId) relation pairs
    | 'relation.conflict' // same relation type points at disjoint targets -> negative evidence
    | 'version.veto' // version tokens disagree -> negative evidence
    | 'schema.entity'; // entity is used as a property/type elsewhere -> never auto-merge
  score: number;
  detail: string;
}

export type Verdict = 'duplicate' | 'likely' | 'weak' | 'distinct';

export interface PairMatch {
  a: NormalizedEntity;
  b: NormalizedEntity;
  signals: MatchSignal[];
  score: number;
  verdict: Verdict;
}

export interface DuplicateClusterMember {
  id: string;
  name: string;
  isDraft: boolean;
  score: number;
  verdict: Verdict;
  signals: MatchSignal[];
  source?: string | undefined;
}

export interface DuplicateCluster {
  canonical: {
    id: string;
    name: string;
    isDraft: boolean;
    reason: string;
  };
  duplicates: DuplicateClusterMember[];
  suggestedOps: PlanOp[];
}

export interface ReviewPair {
  a: { id: string; name: string; isDraft: boolean; source?: string | undefined };
  b: { id: string; name: string; isDraft: boolean; source?: string | undefined };
  score: number;
  verdict: Verdict;
  signals: MatchSignal[];
}

export interface DuplicateReport {
  space: string;
  mode: 'pre-publish' | 'scan';
  generatedAt: string;
  thresholds: Thresholds;
  /** Hard clusters: connected by pairs at/above the duplicate threshold. */
  clusters: DuplicateCluster[];
  /** Pairs in the likely/weak band — human review, never auto-merged. */
  reviewPairs: ReviewPair[];
  stats: {
    checked: number;
    clusters: number;
    duplicate: number;
    likely: number;
    weak: number;
  };
}

/**
 * Backend-agnostic fix operations. The client layer serializes them into real
 * GRC-20 ops via @graphprotocol/grc-20 (deleteEntity / deleteRelation /
 * createRelation / updateEntity). Relations cannot be re-pointed in place in
 * GRC-20 v2 (UpdateRelation only unsets spaces/versions/position), hence
 * `replaceRelation` = delete + create.
 */
export type PlanOp =
  | { kind: 'skipDraft'; draftRef: string; canonicalId: string; note: string }
  | { kind: 'useCanonicalId'; draftRef: string; field: string; canonicalId: string; note: string }
  | { kind: 'deleteEntity'; id: GeoId; note: string }
  | {
      kind: 'replaceRelation';
      deleteRelationId: GeoId | undefined;
      create: { typeId: GeoId; fromEntityId: GeoId; toEntityId: GeoId };
      note: string;
    };

export interface Thresholds {
  duplicate: number;
  likely: number;
  weak: number;
}

export interface DedupConfig {
  /**
   * Identity-tier URL properties: the URL IS the entity (Report URL, archive
   * URL). A shared canonical value forces score 1.0.
   */
  uniqueUrlPropertyIds: GeoId[];
  /**
   * Profile-tier URL properties (Website, X, LinkedIn, project page): strong
   * evidence, but a company, its product and its airdrop legitimately share a
   * homepage — so this contributes +0.75 when types are compatible and only
   * +0.4 when both sides have disjoint type sets, never forcing 1.0 alone.
   */
  profileUrlPropertyIds: GeoId[];
  thresholds: Thresholds;
  /** Tokens stripped before fuzzy comparison. */
  nameStopwords: string[];
  /** Minimal token-similarity to emit a name.fuzzy signal at all. */
  fuzzyFloor: number;
  /** Cap applied to a pair score when version tokens disagree. */
  versionVetoCap: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { duplicate: 0.9, likely: 0.6, weak: 0.4 };

export const DEFAULT_STOPWORDS = [
  'audit',
  'audits',
  'report',
  'review',
  'security',
  'by',
  'of',
  'the',
  'a',
  'an',
  'for',
  'and',
];

export function defaultConfig(partial?: Partial<DedupConfig>): DedupConfig {
  const base: DedupConfig = {
    uniqueUrlPropertyIds: [],
    profileUrlPropertyIds: [],
    thresholds: DEFAULT_THRESHOLDS,
    nameStopwords: DEFAULT_STOPWORDS,
    fuzzyFloor: 0.7,
    versionVetoCap: 0.35,
  };
  return {
    ...base,
    ...partial,
    thresholds: { ...DEFAULT_THRESHOLDS, ...(partial?.thresholds ?? {}) },
  };
}
