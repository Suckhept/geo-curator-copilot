import type { EntityRelation, EntityValue, NormalizedEntity } from './model.js';
import { SystemIds } from './system-ids.js';

/**
 * Raw entity as returned by the hypergraph GraphQL API.
 *
 * LIVE SCHEMA (confirmed via introspection, 2026-06-11):
 *   Entity { id name description values(spaceId, filter): [Value]
 *            relations(spaceId, filter): [Relation]
 *            backlinks(spaceId, filter): [Relation]
 *            types: [Entity] spaces: [String] createdAt updatedAt ... }
 *   Value    { id propertyId entityId spaceId value language format unit timezone }
 *   Relation { id entityId spaceId typeId fromId toId toSpaceId position verified }
 *
 * The mapper ALSO accepts the legacy TS-client shapes (valuesList /
 * relationsList with text/toEntityId) so older snapshots keep working.
 */
interface RawValue {
  propertyId: string;
  /** live schema: single generic string field */
  value?: string | null;
  /** legacy shapes */
  text?: string | null;
  boolean?: boolean | null;
  float?: number | null;
  datetime?: string | null;
}

interface RawRelation {
  id?: string | null;
  typeId?: string | null;
  /** live schema */
  toId?: string | null;
  fromId?: string | null;
  /** legacy shape */
  toEntityId?: string | null;
}

export interface RawGraphQLEntity {
  id: string;
  name?: string | null;
  spaceIds?: ReadonlyArray<string | null> | null;
  /** hypergraph: Entity.types -> [Entity] */
  types?: Array<{ id: string; name?: string | null }> | null;
  /** postgraphile: scalar list of type ids */
  typeIds?: ReadonlyArray<string | null> | null;
  values?: RawValue[] | null;
  valuesList?: RawValue[] | null;
  relations?: RawRelation[] | null;
  relationsList?: RawRelation[] | null;
  /** aliased relation sub-selections, hypergraph-TS-client style */
  [key: `relations_${string}`]: unknown;
}

interface AliasedRelations {
  nodes?: Array<{
    id?: string | null;
    typeId?: string | null;
    toEntityId?: string | null;
    toEntity?: { id?: string | null; name?: string | null } | null;
  }> | null;
}

export function fromGraphQLEntity(raw: RawGraphQLEntity): NormalizedEntity {
  const values: EntityValue[] = [];
  let name = raw.name ?? '';

  for (const v of [...(raw.valuesList ?? []), ...(raw.values ?? [])]) {
    const text = v.text ?? v.value ?? undefined;
    if (v.propertyId === SystemIds.NAME_PROPERTY && typeof text === 'string' && name === '') {
      name = text;
    }
    values.push({
      propertyId: v.propertyId,
      text,
      boolean: v.boolean ?? undefined,
      float: v.float ?? undefined,
      datetime: v.datetime ?? undefined,
    });
  }

  const relations: EntityRelation[] = [];
  const typeIds: string[] = [];

  for (const t of raw.types ?? []) {
    if (t?.id) typeIds.push(t.id);
  }
  for (const t of raw.typeIds ?? []) {
    if (t) typeIds.push(t);
  }

  for (const r of [...(raw.relationsList ?? []), ...(raw.relations ?? [])]) {
    const toEntityId = r.toEntityId ?? r.toId ?? undefined;
    const typeId = r.typeId ?? undefined;
    if (!toEntityId || !typeId) continue;
    relations.push({ id: r.id ?? undefined, typeId, toEntityId });
    if (typeId === SystemIds.TYPES_PROPERTY) typeIds.push(toEntityId);
  }

  for (const [key, value] of Object.entries(raw)) {
    if (!key.startsWith('relations_') || value === null || typeof value !== 'object') continue;
    const aliased = value as AliasedRelations;
    for (const node of aliased.nodes ?? []) {
      const toEntityId = node.toEntityId ?? node.toEntity?.id ?? undefined;
      const typeId = node.typeId ?? undefined;
      if (!toEntityId || !typeId) continue;
      relations.push({
        id: node.id ?? undefined,
        typeId,
        toEntityId,
        toEntityName: node.toEntity?.name ?? undefined,
      });
      if (typeId === SystemIds.TYPES_PROPERTY) typeIds.push(toEntityId);
    }
  }

  return { id: raw.id, isDraft: false, name, typeIds: [...new Set(typeIds)], values, relations };
}

/**
 * Draft row from a CSV batch (the curator import workflow). Relation targets
 * may carry names to be resolved to canonical ids before publishing.
 */
export interface DraftRow {
  ref: string; // e.g. "row:7"
  name: string;
  typeIds?: string[] | undefined;
  values?: Array<{ propertyId: string; text: string }> | undefined;
  relations?: Array<{ typeId: string; toEntityId?: string | undefined; toEntityName?: string | undefined }> | undefined;
  source?: string | undefined;
}

export function fromDraftRow(row: DraftRow): NormalizedEntity {
  return {
    id: row.ref,
    isDraft: true,
    name: row.name,
    typeIds: row.typeIds ?? [],
    values: (row.values ?? []).map(v => ({ propertyId: v.propertyId, text: v.text })),
    relations: (row.relations ?? [])
      .filter(r => r.toEntityId !== undefined || r.toEntityName !== undefined)
      .map(r => ({
        typeId: r.typeId,
        toEntityId: r.toEntityId ?? `unresolved:${(r.toEntityName ?? '').toLowerCase()}`,
        toEntityName: r.toEntityName,
      })),
    source: row.source,
  };
}
