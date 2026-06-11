#!/usr/bin/env node
/**
 * geo-copilot-mcp — MCP server (stdio) exposing the dedup engine to AI
 * curators working on Geo (geobrowser.io).
 *
 * Tools:
 *   search_entities      find entities by name (live GraphQL search or snapshot scoring)
 *   check_duplicates     score a draft entity against the space before publishing
 *   resolve_canonical_id map a name (e.g. an auditor) to the canonical existing entity id
 *   generate_ops         turn a dedup report's plan ops into a GRC-20 op preview
 *   publish_edit         the ONLY mutating tool; requires GEO_PRIVATE_KEY env + confirm:true
 *
 * Environment:
 *   GEO_SNAPSHOT          path to snapshot.json -> offline mode (no network needed)
 *   GEO_API_ORIGIN        GraphQL origin (default https://testnet-api.geobrowser.io — what geobrowser.io itself uses)
 *   GEO_SPACE             default space id
 *   GEO_UNIQUE_URL_PROPS   identity-tier URL property ids (Report URL)
 *   GEO_PROFILE_URL_PROPS  profile-tier URL property ids (Website/X/LinkedIn)
 *   GEO_PRIVATE_KEY       0x wallet key (geobrowser.io/export-wallet); only read by publish_edit
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  DEFAULT_IDENTITY_URL_PROPERTIES,
  DEFAULT_PROFILE_URL_PROPERTIES,
  buildReport,
  defaultConfig,
  fromDraftRow,
  fromGraphQLEntity,
  resolveCanonical,
  jaccard,
  normalizeName,
  tokenSetRatio,
  tokenSortRatio,
  tokenize,
  type DedupConfig,
  type NormalizedEntity,
  type PlanOp,
  type RawGraphQLEntity,
} from '@geo-copilot/core';
import {
  GEOBROWSER_API_ORIGIN,
  HttpTransport,
  loadSnapshot,
  publishEdit,
  qSearch,
  serializePlanOps,
  snapshotToEntities,
  type Network,
} from '@geo-copilot/client';

/* ------------------------------------------------------------------ */
/* Context                                                             */
/* ------------------------------------------------------------------ */

const env = process.env;
const ORIGIN = env['GEO_API_ORIGIN'] ?? GEOBROWSER_API_ORIGIN;
const DEFAULT_SPACE = env['GEO_SPACE'];
const SNAPSHOT_PATH = env['GEO_SNAPSHOT'];

const config: DedupConfig = defaultConfig({
  uniqueUrlPropertyIds: env['GEO_UNIQUE_URL_PROPS']
    ? env['GEO_UNIQUE_URL_PROPS'].split(',').map(s => s.trim()).filter(Boolean)
    : DEFAULT_IDENTITY_URL_PROPERTIES,
  profileUrlPropertyIds: env['GEO_PROFILE_URL_PROPS']
    ? env['GEO_PROFILE_URL_PROPS'].split(',').map(s => s.trim()).filter(Boolean)
    : DEFAULT_PROFILE_URL_PROPERTIES,
});

let snapshotCache: NormalizedEntity[] | undefined;

async function getSnapshotEntities(): Promise<NormalizedEntity[] | undefined> {
  if (!SNAPSHOT_PATH) return undefined;
  if (!snapshotCache) {
    snapshotCache = snapshotToEntities(await loadSnapshot(SNAPSHOT_PATH));
  }
  return snapshotCache;
}

function requireSpace(spaceId?: string): string {
  const space = spaceId ?? DEFAULT_SPACE;
  if (!space) throw new Error('spaceId is required (pass it or set GEO_SPACE)');
  return space;
}

/** Live candidate acquisition: name search; tries both schema dialects. */
async function searchLive(query: string, spaceId: string, limit: number): Promise<NormalizedEntity[]> {
  const transport = new HttpTransport(ORIGIN);
  try {
    const data = await transport.execute<{ entities: RawGraphQLEntity[] }>(
      qSearch(query, spaceId, limit, 'postgraphile'),
    );
    return data.entities.map(fromGraphQLEntity);
  } catch {
    const data = await transport.execute<{ entities: RawGraphQLEntity[] }>(
      qSearch(query, spaceId, limit, 'hypergraph'),
    );
    return data.entities.map(fromGraphQLEntity);
  }
}

/** Snapshot candidate acquisition: rank by raw name similarity (not dedup tiers). */
function searchSnapshot(query: string, entities: NormalizedEntity[], limit: number): Array<{ id: string; name: string; score: number }> {
  const qTokens = tokenize(query, config.nameStopwords);
  const qNorm = normalizeName(query);
  return entities
    .map(e => {
      const tokens = tokenize(e.name, config.nameStopwords);
      const sim =
        qNorm.length > 0 && normalizeName(e.name) === qNorm
          ? 1
          : 0.6 * Math.max(tokenSortRatio(qTokens, tokens), tokenSetRatio(qTokens, tokens)) + 0.4 * jaccard(qTokens, tokens);
      return { id: e.id, name: e.name, score: Number(sim.toFixed(3)) };
    })
    .filter(({ score }) => score >= 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

async function getTargets(spaceId: string, hintName?: string, limit = 50): Promise<NormalizedEntity[]> {
  const snap = await getSnapshotEntities();
  if (snap) return snap;
  if (!hintName) throw new Error('Live mode needs a name to search candidates with; or set GEO_SNAPSHOT for full-space checks');
  return searchLive(hintName, spaceId, limit);
}

function json(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

/* ------------------------------------------------------------------ */
/* Server + tools                                                      */
/* ------------------------------------------------------------------ */

const server = new McpServer({ name: 'geo-copilot', version: '0.1.0' });

server.registerTool(
  'search_entities',
  {
    title: 'Search entities in a Geo space',
    description:
      'Find entities by name. Uses the live GraphQL search when online, or fuzzy scoring over the GEO_SNAPSHOT file when offline. Returns id, name and (offline) a similarity score.',
    inputSchema: {
      query: z.string().min(1).describe('Name or fragment to search for'),
      spaceId: z.string().optional().describe('Space id (UUID without dashes); defaults to GEO_SPACE'),
      limit: z.number().int().min(1).max(50).default(10),
    },
  },
  async ({ query, spaceId, limit }) => {
    const space = requireSpace(spaceId);
    const snap = await getSnapshotEntities();
    if (snap) {
      const hits = searchSnapshot(query, snap, limit);
      return json({ mode: 'snapshot', hits });
    }
    const live = await searchLive(query, space, limit);
    return json({ mode: 'live', hits: live.map(h => ({ id: h.id, name: h.name })) });
  },
);

server.registerTool(
  'check_duplicates',
  {
    title: 'Check a draft entity for duplicates',
    description:
      'Pre-publish lint for one draft entity: scores it against existing entities (full snapshot, or live search candidates) and returns verdicts with signals (url.exact / name.exact / name.fuzzy / shape.relations / version.veto). Verdicts: duplicate >= 0.9, likely >= 0.6, weak >= 0.4.',
    inputSchema: {
      name: z.string().min(1).describe('Draft entity name'),
      spaceId: z.string().optional(),
      values: z
        .array(z.object({ propertyId: z.string(), text: z.string() }))
        .optional()
        .describe('Text/URL values, e.g. [{propertyId: <Report URL prop>, text: "https://..."}]'),
      relations: z
        .array(z.object({ typeId: z.string(), toEntityId: z.string().optional(), toEntityName: z.string().optional() }))
        .optional()
        .describe('Outbound relations of the draft (auditor, protocol, ...)'),
      typeIds: z.array(z.string()).optional(),
    },
  },
  async ({ name, spaceId, values, relations, typeIds }) => {
    const space = requireSpace(spaceId);
    const targets = await getTargets(space, name);
    const draft = fromDraftRow({ ref: 'draft:1', name, values, relations, typeIds });
    const { report } = buildReport({
      space,
      mode: 'pre-publish',
      targets,
      drafts: [draft],
      config,
      generateFixOps: true,
    });
    const cluster = report.clusters[0];
    if (!cluster) return json({ verdict: 'distinct', message: 'No similar entities found', stats: report.stats });
    return json({
      verdict: cluster.duplicates[0]?.verdict ?? 'distinct',
      canonical: cluster.canonical,
      matches: cluster.duplicates,
      suggestedOps: cluster.suggestedOps,
      thresholds: report.thresholds,
    });
  },
);

server.registerTool(
  'resolve_canonical_id',
  {
    title: 'Resolve a name to the canonical entity id',
    description:
      'Maps a name (e.g. an auditor company from a CSV column) to the best existing entity. Returns best match with confidence plus alternatives. Only trust auto-linking when score >= 0.6.',
    inputSchema: {
      name: z.string().min(1),
      spaceId: z.string().optional(),
      typeId: z.string().optional().describe('Restrict candidates to this type (e.g. the Company type id)'),
    },
  },
  async ({ name, spaceId, typeId }) => {
    const space = requireSpace(spaceId);
    const targets = await getTargets(space, name);
    const result = resolveCanonical(name, targets, config, typeId);
    return json(result);
  },
);

const planOpSchema = z.union([
  z.object({ kind: z.literal('skipDraft'), draftRef: z.string(), canonicalId: z.string(), note: z.string() }),
  z.object({
    kind: z.literal('useCanonicalId'),
    draftRef: z.string(),
    field: z.string(),
    canonicalId: z.string(),
    note: z.string(),
  }),
  z.object({ kind: z.literal('deleteEntity'), id: z.string(), note: z.string() }),
  z.object({
    kind: z.literal('replaceRelation'),
    deleteRelationId: z.string().optional(),
    create: z.object({ typeId: z.string(), fromEntityId: z.string(), toEntityId: z.string() }),
    note: z.string(),
  }),
]);

server.registerTool(
  'generate_ops',
  {
    title: 'Serialize plan ops into GRC-20 ops (preview)',
    description:
      'Validates portable planOps (from check_duplicates / a report) against the real @graphprotocol/grc-20 SDK and returns an op-type preview. Binary ops never cross the tool boundary; publish_edit re-serializes from planOps.',
    inputSchema: { planOps: z.array(planOpSchema) },
  },
  async ({ planOps }) => {
    const { ops, skipped } = serializePlanOps(planOps as PlanOp[]);
    return json({
      opCount: ops.length,
      opsPreview: ops.map(o => o.type),
      skipped,
      planOps,
      next: 'Pass these planOps to publish_edit with confirm:true to apply.',
    });
  },
);

server.registerTool(
  'publish_edit',
  {
    title: 'Publish an edit to a Geo space (MUTATING)',
    description:
      'The only mutating tool. Serializes planOps and publishes them as one edit: IPFS upload -> calldata -> smart-account tx (gas sponsored). Requires GEO_PRIVATE_KEY in the server environment and confirm:true. Use dryRun:true first to get the CID and calldata target without sending.',
    inputSchema: {
      spaceId: z.string().optional(),
      editName: z.string().min(3).describe('Human-readable edit name shown in Geo governance'),
      planOps: z.array(planOpSchema),
      confirm: z.boolean().describe('Must be true; an explicit human-approved go-ahead'),
      dryRun: z.boolean().default(false),
      network: z.enum(['MAINNET', 'TESTNET', 'TESTNET_V2', 'TESTNET_V3']).default('MAINNET'),
    },
  },
  async ({ spaceId, editName, planOps, confirm, dryRun, network }) => {
    if (!confirm) {
      return json({ error: 'Refusing to publish: confirm must be true (explicit human approval).' });
    }
    const privateKey = env['GEO_PRIVATE_KEY'];
    if (!privateKey || !privateKey.startsWith('0x')) {
      return json({
        error:
          'GEO_PRIVATE_KEY env var is not set on the MCP server. Export the key from geobrowser.io/export-wallet and set it in the server environment (never in chat).',
      });
    }
    const space = requireSpace(spaceId);
    const { ops, skipped } = serializePlanOps(planOps as PlanOp[]);
    if (ops.length === 0) return json({ error: 'No publishable ops (all plan ops were advisory).', skipped });
    const result = await publishEdit({
      spaceId: space,
      editName,
      ops,
      privateKey: privateKey as `0x${string}`,
      network: network as Network,
      dryRun,
    });
    return json({ ...result, skipped });
  },
);

/* ------------------------------------------------------------------ */

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `geo-copilot-mcp ready (mode: ${SNAPSHOT_PATH ? `snapshot ${SNAPSHOT_PATH}` : `live ${ORIGIN}`}${DEFAULT_SPACE ? `, space ${DEFAULT_SPACE}` : ''})`,
);
