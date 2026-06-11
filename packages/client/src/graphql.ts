/**
 * GraphQL read layer for the hypergraph indexer.
 *
 * Endpoint: POST {origin}/graphql
 *   MAINNET origin: https://hypergraph-v2.up.railway.app
 *   TESTNET origin: https://api-testnet.geobrowser.io
 *
 * LIVE SCHEMA — confirmed via introspection (2026-06-11):
 *   Query    { entities(filter, limit, offset, spaceId)
 *              entity(id, spaceId)
 *              search(query, spaceId, filter, limit, offset, threshold)
 *              relations(spaceId, filter, limit, offset)
 *              properties(filter, limit, offset)  property(id)
 *              types(spaceId, limit, offset)  spaces(filter, limit, offset) }
 *   Entity   { id name values(spaceId, filter) relations(spaceId, filter)
 *              backlinks(spaceId, filter) types spaces createdAt updatedAt }
 *   Value    { propertyId value language format unit timezone ... }
 *   Relation { id typeId fromId toId spaceId position verified ... }
 *
 * Queries are built by interpolation with strict id validation (argument
 * SCALAR types are not introspected yet, so typed variables are avoided).
 */

export const MAINNET_API_ORIGIN = 'https://hypergraph-v2.up.railway.app';
export const TESTNET_API_ORIGIN = 'https://api-testnet.geobrowser.io';
/**
 * The origin the production geobrowser.io frontend actually queries
 * (discovered from page traffic, 2026-06-11). hypergraph-v2.up.railway.app
 * turned out to hold demo data with placeholder DAO addresses; real curation
 * spaces live here. Matches grc-20-ts TESTNET_V2.
 */
export const GEOBROWSER_API_ORIGIN = 'https://testnet-api.geobrowser.io';

export interface GraphQLRequest {
  query: string;
  variables?: Record<string, unknown> | undefined;
}

export interface Transport {
  execute<T>(request: GraphQLRequest): Promise<T>;
}

export class GraphQLError extends Error {
  constructor(
    message: string,
    readonly errors?: unknown,
  ) {
    super(message);
    this.name = 'GraphQLError';
  }
}

/** Live transport: plain fetch, no auth needed for public data. */
export class HttpTransport implements Transport {
  constructor(private readonly origin: string = MAINNET_API_ORIGIN) {}

  async execute<T>(request: GraphQLRequest): Promise<T> {
    const res = await fetch(`${this.origin}/graphql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    if (!res.ok) {
      throw new GraphQLError(`HTTP ${res.status} from ${this.origin}/graphql: ${await res.text()}`);
    }
    const json = (await res.json()) as { data?: T; errors?: unknown };
    if (json.errors) throw new GraphQLError('GraphQL errors', json.errors);
    if (json.data === undefined) throw new GraphQLError('GraphQL response without data');
    return json.data;
  }
}

/** Mock transport: returns canned responses keyed by query substring. */
export class MockTransport implements Transport {
  constructor(private readonly responses: Map<string, unknown[]>) {}

  static fromRecordings(recordings: Array<{ match: string; data: unknown }>): MockTransport {
    const map = new Map<string, unknown[]>();
    for (const r of recordings) {
      const list = map.get(r.match) ?? [];
      list.push(r.data);
      map.set(r.match, list);
    }
    return new MockTransport(map);
  }

  async execute<T>(request: GraphQLRequest): Promise<T> {
    for (const [match, queue] of this.responses) {
      if (request.query.includes(match) && queue.length > 0) {
        return queue.shift() as T;
      }
    }
    throw new GraphQLError(`MockTransport: no recorded response for query: ${request.query.slice(0, 80)}...`);
  }
}

/* ------------------------------------------------------------------ */
/* Query builders                                                      */
/* ------------------------------------------------------------------ */

/**
 * Two deployments, two schemas:
 *  - 'postgraphile' — testnet-api.geobrowser.io (REAL data, what geobrowser.io
 *    queries): entities(spaceId, first, offset, typeIds, ...), Entity has
 *    typeIds / valuesList{text} / relationsList{toEntityId} / backlinksList.
 *  - 'hypergraph'   — hypergraph-v2.up.railway.app (demo data today):
 *    entities(spaceId, limit, offset), values{value}, relations{toId}, types.
 * Builders emit either form; fetchSnapshot auto-detects via validation errors.
 */
export type Dialect = 'postgraphile' | 'hypergraph';

/** Accepts dashless (32 hex) and dashed (36) UUIDs. */
export function assertGeoId(id: string, hint: string): string {
  if (!/^[0-9a-fA-F]{32}$/.test(id) && !/^[0-9a-fA-F-]{36}$/.test(id)) {
    throw new Error(`Invalid Geo id for ${hint}: "${id}"`);
  }
  return id;
}

function gqlString(s: string): string {
  return JSON.stringify(s);
}

export const PG_ENTITY_SELECTION = `
    id
    name
    typeIds
    valuesList {
      propertyId
      text
    }
    relationsList {
      id
      typeId
      toEntityId
    }`;

export const ENTITY_SELECTION = (spaceId: string): string => `
    id
    name
    values(spaceId: "${spaceId}") {
      propertyId
      value
    }
    relations(spaceId: "${spaceId}") {
      id
      typeId
      toId
    }
    types {
      id
    }`;

/**
 * Cursor-paginated full-space dump (postgraphile only). The plain `entities`
 * field caps offset at 1000 on testnet-api.geobrowser.io, so big spaces need
 * the relay connection.
 */
export function qSpaceEntitiesConnection(
  spaceId: string,
  first: number,
  after?: string,
  typeIds?: readonly string[],
): GraphQLRequest {
  const s = assertGeoId(spaceId, 'spaceId');
  const typeArg =
    typeIds && typeIds.length > 0
      ? `, typeIds: [${typeIds.map(t => `"${assertGeoId(t, 'typeId')}"`).join(', ')}]`
      : '';
  const afterArg = after ? `, after: ${gqlString(after)}` : '';
  return {
    query: `query spaceEntities {
  entitiesConnection(spaceId: "${s}", first: ${Math.floor(first)}${afterArg}${typeArg}) {
    edges {
      node {${PG_ENTITY_SELECTION}
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`,
  };
}

/** Offset-paginated dump (hypergraph dialect; postgraphile form kept for small spaces). */
export function qSpaceEntities(
  spaceId: string,
  limit: number,
  offset: number,
  dialect: Dialect = 'postgraphile',
  typeIds?: readonly string[],
): GraphQLRequest {
  const s = assertGeoId(spaceId, 'spaceId');
  if (dialect === 'postgraphile') {
    const typeArg =
      typeIds && typeIds.length > 0
        ? `, typeIds: [${typeIds.map(t => `"${assertGeoId(t, 'typeId')}"`).join(', ')}]`
        : '';
    return {
      query: `query spaceEntities {
  entities(spaceId: "${s}", first: ${Math.floor(limit)}, offset: ${Math.floor(offset)}${typeArg}) {${PG_ENTITY_SELECTION}
  }
}`,
    };
  }
  return {
    query: `query spaceEntities {
  entities(spaceId: "${s}", limit: ${Math.floor(limit)}, offset: ${Math.floor(offset)}) {${ENTITY_SELECTION(s)}
  }
}`,
  };
}

/**
 * Name search. hypergraph: semantic `search` root (empty results may mean a
 * high default threshold). postgraphile: name filter (TENTATIVE — relies on
 * the standard connection-filter `includesInsensitive` operator).
 */
export function qSearch(
  query: string,
  spaceId: string,
  limit: number,
  dialect: Dialect = 'postgraphile',
  threshold?: number,
): GraphQLRequest {
  const s = assertGeoId(spaceId, 'spaceId');
  if (dialect === 'postgraphile') {
    return {
      query: `query searchEntities {
  entities(spaceId: "${s}", first: ${Math.floor(limit)}, filter: { name: { includesInsensitive: ${gqlString(query)} } }) {${PG_ENTITY_SELECTION}
  }
}`,
    };
  }
  const thr = threshold !== undefined ? `, threshold: ${threshold}` : '';
  return {
    query: `query searchEntities {
  entities: search(query: ${gqlString(query)}, spaceId: "${s}", limit: ${Math.floor(limit)}${thr}) {${ENTITY_SELECTION(s)}
  }
}`,
  };
}

/** Single entity by id, scoped to a space. */
export function qEntityById(entityId: string, spaceId: string): GraphQLRequest {
  const e = assertGeoId(entityId, 'entityId');
  const s = assertGeoId(spaceId, 'spaceId');
  return {
    query: `query entityById {
  entity(id: "${e}", spaceId: "${s}") {${ENTITY_SELECTION(s)}
  }
}`,
  };
}

/** Inbound relations of an entity (who points at it) — native backlinks. */
export function qBacklinks(entityId: string, spaceId: string): GraphQLRequest {
  const e = assertGeoId(entityId, 'entityId');
  const s = assertGeoId(spaceId, 'spaceId');
  return {
    query: `query entityBacklinks {
  entity(id: "${e}", spaceId: "${s}") {
    id
    backlinks(spaceId: "${s}") {
      id
      typeId
      fromId
      toId
    }
  }
}`,
  };
}
