import { readFile, writeFile } from 'node:fs/promises';
import { fromGraphQLEntity, type NormalizedEntity, type RawGraphQLEntity } from '@geo-copilot/core';
import {
  GraphQLError,
  qSpaceEntities,
  qSpaceEntitiesConnection,
  type Dialect,
  type Transport,
} from './graphql.js';

export interface Snapshot {
  space: string;
  fetchedAt: string;
  entities: RawGraphQLEntity[];
  dialect?: Dialect | undefined;
}

export interface FetchSnapshotOptions {
  /** postgraphile: server-side typeIds arg; hypergraph: client-side filter. */
  typeIds?: string[] | undefined;
  pageSize?: number;
  maxPages?: number;
  /** Schema dialect; auto-detected from validation errors when wrong. */
  dialect?: Dialect | undefined;
}

/**
 * Pulls a full (or per-type) snapshot of a space.
 *
 * postgraphile (testnet-api.geobrowser.io, REAL data): cursor pagination via
 * `entitiesConnection` — the plain `entities` field rejects offset > 1000.
 * hypergraph (demo deployment): limit/offset pagination.
 *
 * Wrong-dialect validation errors trigger one automatic switch; a rejected
 * relations sub-selection degrades to a relations-free query so name/url
 * dedup still works.
 */
export async function fetchSnapshot(
  transport: Transport,
  space: string,
  options?: FetchSnapshotOptions,
): Promise<Snapshot> {
  let dialect: Dialect = options?.dialect ?? 'postgraphile';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const entities =
        dialect === 'postgraphile'
          ? await fetchPostgraphile(transport, space, options)
          : await fetchHypergraph(transport, space, options);
      return { space, fetchedAt: new Date().toISOString(), entities, dialect };
    } catch (err) {
      if (attempt === 0 && err instanceof GraphQLError && isDialectMismatch(err, dialect)) {
        dialect = dialect === 'postgraphile' ? 'hypergraph' : 'postgraphile';
        continue;
      }
      throw err;
    }
  }
  /* c8 ignore next */
  throw new Error('unreachable');
}

function isDialectMismatch(err: GraphQLError, current: Dialect): boolean {
  const msg = JSON.stringify(err.errors ?? err.message);
  if (current === 'postgraphile') {
    return /Did you mean \\?"limit\\?"/.test(msg) || /Cannot query field \\?"entitiesConnection\\?"/.test(msg);
  }
  return /Did you mean \\?"first\\?"/.test(msg) || /Cannot query field \\?"search\\?"/.test(msg);
}

interface PgConnectionPage {
  entitiesConnection: {
    edges: Array<{ node: RawGraphQLEntity }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  } | null;
}

async function fetchPostgraphile(
  transport: Transport,
  space: string,
  options?: FetchSnapshotOptions,
): Promise<RawGraphQLEntity[]> {
  const pageSize = options?.pageSize ?? 100;
  const maxPages = options?.maxPages ?? 300;
  const typeIds = options?.typeIds;

  let includeRelations = true;
  let after: string | undefined;
  const entities: RawGraphQLEntity[] = [];

  for (let page = 0; page < maxPages; page++) {
    const request = qSpaceEntitiesConnection(space, pageSize, after, typeIds);
    const query = includeRelations ? request.query : stripRelations(request.query);

    let data: PgConnectionPage;
    try {
      data = await transport.execute<PgConnectionPage>({ query });
    } catch (err) {
      if (includeRelations && err instanceof GraphQLError && !isDialectMismatch(err, 'postgraphile')) {
        includeRelations = false;
        page--;
        continue;
      }
      throw err;
    }
    const connection = data.entitiesConnection;
    entities.push(...(connection?.edges ?? []).map(e => e.node));
    if (!connection?.pageInfo?.hasNextPage || !connection.pageInfo.endCursor) break;
    after = connection.pageInfo.endCursor;
  }
  return entities;
}

async function fetchHypergraph(
  transport: Transport,
  space: string,
  options?: FetchSnapshotOptions,
): Promise<RawGraphQLEntity[]> {
  const pageSize = options?.pageSize ?? 100;
  const maxPages = options?.maxPages ?? 300;
  const typeIds = options?.typeIds;

  let includeRelations = true;
  const entities: RawGraphQLEntity[] = [];

  for (let page = 0; page < maxPages; page++) {
    const offset = page * pageSize;
    const request = qSpaceEntities(space, pageSize, offset, 'hypergraph');
    const query = includeRelations ? request.query : stripRelations(request.query);

    let data: { entities: RawGraphQLEntity[] };
    try {
      data = await transport.execute<{ entities: RawGraphQLEntity[] }>({ query });
    } catch (err) {
      if (includeRelations && err instanceof GraphQLError && !isDialectMismatch(err, 'hypergraph')) {
        includeRelations = false;
        page--;
        continue;
      }
      throw err;
    }
    entities.push(...data.entities);
    if (data.entities.length < pageSize) break;
  }

  return typeIds ? entities.filter(e => rawHasAnyType(e, typeIds)) : entities;
}

function stripRelations(query: string): string {
  return query.replace(/relations(List)?\s*(\([^)]*\))?\s*\{[^}]*\}/m, '');
}

const TYPES_RELATION = '8f151ba4de204e3c9cb499ddf96f48f1';

function rawHasAnyType(e: RawGraphQLEntity, typeIds: readonly string[]): boolean {
  const wanted = new Set(typeIds.map(t => t.toLowerCase()));
  for (const t of e.types ?? []) {
    if (t?.id && wanted.has(t.id.toLowerCase())) return true;
  }
  for (const t of e.typeIds ?? []) {
    if (t && wanted.has(t.toLowerCase())) return true;
  }
  for (const r of [...(e.relationsList ?? []), ...(e.relations ?? [])]) {
    const to = (r.toEntityId ?? r.toId ?? '').toLowerCase();
    if (r.typeId === TYPES_RELATION && wanted.has(to)) return true;
  }
  return false;
}

export async function saveSnapshot(path: string, snapshot: Snapshot): Promise<void> {
  await writeFile(path, JSON.stringify(snapshot, null, 2), 'utf8');
}

interface BrowserDump {
  origin?: string;
  dialect?: string;
  dumps?: Record<string, RawGraphQLEntity[]>;
}

export async function loadSnapshot(path: string, spaceHint?: string): Promise<Snapshot> {
  const raw = await readFile(path, 'utf8');
  const parsed = JSON.parse(raw) as
    | Snapshot
    | RawGraphQLEntity[]
    | { data?: { entities?: RawGraphQLEntity[] } }
    | BrowserDump;

  // 1) bare entity array
  if (Array.isArray(parsed)) {
    return { space: spaceHint ?? 'unknown', fetchedAt: new Date().toISOString(), entities: parsed };
  }
  // 2) our Snapshot
  if ('entities' in parsed && Array.isArray(parsed.entities)) {
    return parsed as Snapshot;
  }
  // 3) raw GraphQL response pasted from the browser
  const fromResponse = (parsed as { data?: { entities?: RawGraphQLEntity[] } }).data?.entities;
  if (Array.isArray(fromResponse)) {
    return { space: spaceHint ?? 'unknown', fetchedAt: new Date().toISOString(), entities: fromResponse };
  }
  // 4) console-dump format: { origin, dumps: { spaceId: entities[] } }
  const dumps = (parsed as BrowserDump).dumps;
  if (dumps && typeof dumps === 'object') {
    const keys = Object.keys(dumps);
    const norm = (x: string): string => x.replace(/-/g, '').toLowerCase();
    const key = spaceHint ? keys.find(k => norm(k) === norm(spaceHint)) : keys[0];
    if (key && Array.isArray(dumps[key])) {
      return { space: key, fetchedAt: new Date().toISOString(), entities: dumps[key] as RawGraphQLEntity[] };
    }
    throw new Error(
      `Snapshot file has dumps for spaces [${keys.join(', ')}], none matches "${spaceHint ?? '(none given)'}"`,
    );
  }
  throw new Error(`Unrecognized snapshot shape in ${path}`);
}

export function snapshotToEntities(snapshot: Snapshot): NormalizedEntity[] {
  return snapshot.entities.map(fromGraphQLEntity);
}
