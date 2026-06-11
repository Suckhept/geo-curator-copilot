#!/usr/bin/env node
/**
 * geo-copilot — dedup CLI for Geo (geobrowser.io) curators.
 *
 *   snapshot  pull a space snapshot via GraphQL (live)
 *   scan      find duplicates inside an existing space snapshot
 *   lint      check a draft batch (CSV/JSON) against a space before publishing
 *   fix       turn a report's suggested ops into GRC-20 ops (and optionally publish)
 *
 * Exit codes: 0 ok, 1 error, 2 duplicates found (CI-friendly for lint/scan).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import {
  DEFAULT_IDENTITY_URL_PROPERTIES,
  DEFAULT_PROFILE_URL_PROPERTIES,
  buildReport,
  defaultConfig,
  fromDraftRow,
  renderMarkdown,
  resolveCanonical,
  type DedupConfig,
  type DraftRow,
  type DuplicateReport,
  type NormalizedEntity,
  type PlanOp,
} from '@geo-copilot/core';
import {
  GEOBROWSER_API_ORIGIN,
  HttpTransport,
  csvToDrafts,
  fetchSnapshot,
  loadSnapshot,
  publishEdit,
  saveSnapshot,
  serializePlanOps,
  snapshotToEntities,
  type CsvMapping,
} from '@geo-copilot/client';

const program = new Command();
program
  .name('geo-copilot')
  .description('Dedup engine for Geo knowledge-graph curators')
  .version('0.1.0');

interface CommonOpts {
  uniqueUrlProp: string[];
  profileUrlProp: string[];
  out: string;
}

function makeConfig(opts: { uniqueUrlProp: string[]; profileUrlProp: string[] }): DedupConfig {
  return defaultConfig({
    uniqueUrlPropertyIds: opts.uniqueUrlProp.length > 0 ? opts.uniqueUrlProp : DEFAULT_IDENTITY_URL_PROPERTIES,
    profileUrlPropertyIds: opts.profileUrlProp.length > 0 ? opts.profileUrlProp : DEFAULT_PROFILE_URL_PROPERTIES,
  });
}

async function loadTargets(snapshotPath: string, space?: string): Promise<NormalizedEntity[]> {
  const snapshot = await loadSnapshot(resolve(snapshotPath), space);
  return snapshotToEntities(snapshot);
}

async function writeReport(outDir: string, report: DuplicateReport): Promise<void> {
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  await writeFile(join(outDir, 'report.md'), renderMarkdown(report), 'utf8');
  console.log(`report.json + report.md -> ${outDir}`);
  console.log(
    `clusters: ${report.stats.clusters}, duplicate: ${report.stats.duplicate}, likely: ${report.stats.likely}, weak: ${report.stats.weak}`,
  );
}

function exitForReport(report: DuplicateReport): never {
  process.exit(report.stats.duplicate > 0 ? 2 : 0);
}

/* ------------------------------------------------------------------ */
program
  .command('snapshot')
  .description('Fetch a space snapshot from the GraphQL API (requires network)')
  .requiredOption('--space <id>', 'space id (UUID without dashes)')
  .option('--origin <url>', 'API origin', GEOBROWSER_API_ORIGIN)
  .option('--type <typeId...>', 'restrict to entity type ids')
  .option('--page-size <n>', 'entities per page', '100')
  .option('--out <file>', 'output file', 'snapshot.json')
  .action(async opts => {
    const transport = new HttpTransport(opts.origin);
    const snapshot = await fetchSnapshot(transport, opts.space, {
      typeIds: opts.type,
      pageSize: Number(opts.pageSize),
    });
    await saveSnapshot(resolve(opts.out), snapshot);
    console.log(`${snapshot.entities.length} entities -> ${opts.out}`);
  });

/* ------------------------------------------------------------------ */
program
  .command('scan')
  .description('Find duplicates among existing entities in a snapshot')
  .requiredOption('--space <id>', 'space id (for the report header)')
  .requiredOption('--snapshot <file>', 'snapshot.json (from `snapshot` or pasted GraphQL response)')
  .option('--unique-url-prop <id...>', 'identity-tier URL property ids (Report URL); default: observed Crypto ids', [])
  .option('--profile-url-prop <id...>', 'profile-tier URL property ids (Website/X/LinkedIn)', [])
  .option('--out <dir>', 'output directory', 'geo-copilot-out')
  .action(async (opts: CommonOpts & { space: string; snapshot: string }) => {
    const config = makeConfig(opts);
    const targets = await loadTargets(opts.snapshot, opts.space);
    const { report } = buildReport({ space: opts.space, mode: 'scan', targets, config });
    await writeReport(resolve(opts.out), report);
    exitForReport(report);
  });

/* ------------------------------------------------------------------ */
program
  .command('lint')
  .description('Check a draft batch (CSV or JSON) against a space snapshot before publishing')
  .requiredOption('--space <id>', 'space id (for the report header)')
  .requiredOption('--snapshot <file>', 'snapshot.json of the target space')
  .requiredOption('--draft <file>', 'draft batch: .csv (with --map) or .json (DraftRow[])')
  .option('--map <file>', 'JSON file with the CSV column mapping (CsvMapping)')
  .option('--unique-url-prop <id...>', 'identity-tier URL property ids (Report URL)', [])
  .option('--profile-url-prop <id...>', 'profile-tier URL property ids (Website/X/LinkedIn)', [])
  .option('--out <dir>', 'output directory', 'geo-copilot-out')
  .action(
    async (
      opts: CommonOpts & { space: string; snapshot: string; draft: string; map?: string },
    ) => {
      const config = makeConfig(opts);
      const targets = await loadTargets(opts.snapshot, opts.space);

      let drafts: DraftRow[];
      if (opts.draft.endsWith('.csv')) {
        if (!opts.map) throw new Error('CSV drafts need --map <mapping.json> (see examples/mapping.audits.json)');
        const mapping = JSON.parse(await readFile(resolve(opts.map), 'utf8')) as CsvMapping;
        drafts = csvToDrafts(await readFile(resolve(opts.draft), 'utf8'), mapping, opts.draft);
      } else {
        drafts = JSON.parse(await readFile(resolve(opts.draft), 'utf8')) as DraftRow[];
      }

      // Resolve relation targets given by name (e.g. the Auditor column) to
      // canonical existing ids, so shape signals work and the curator gets a
      // ready-made resolution table.
      const resolutions: Array<{
        row: string;
        relationTypeId: string;
        name: string;
        resolvedId?: string;
        score?: number;
        alternatives: Array<{ id: string; name: string; score: number }>;
      }> = [];
      for (const draft of drafts) {
        for (const rel of draft.relations ?? []) {
          if (rel.toEntityId !== undefined || rel.toEntityName === undefined) continue;
          const { best, alternatives } = resolveCanonical(rel.toEntityName, targets, config);
          if (best && best.score >= config.thresholds.likely) rel.toEntityId = best.id;
          resolutions.push({
            row: draft.ref,
            relationTypeId: rel.typeId,
            name: rel.toEntityName,
            ...(best ? { resolvedId: best.id, score: best.score } : {}),
            alternatives,
          });
        }
      }

      const normalizedDrafts = drafts.map(fromDraftRow);
      const { report } = buildReport({
        space: opts.space,
        mode: 'pre-publish',
        targets,
        drafts: normalizedDrafts,
        config,
      });

      const outDir = resolve(opts.out);
      await writeReport(outDir, report);
      if (resolutions.length > 0) {
        await writeFile(join(outDir, 'resolutions.json'), JSON.stringify(resolutions, null, 2), 'utf8');
        const unresolved = resolutions.filter(r => r.resolvedId === undefined);
        console.log(`relation name resolutions: ${resolutions.length} (${unresolved.length} unresolved) -> resolutions.json`);
      }
      exitForReport(report);
    },
  );

/* ------------------------------------------------------------------ */
program
  .command('fix')
  .description('Serialize fix ops from a report or a plan file into GRC-20 ops (and optionally publish)')
  .option('--report <file>', 'report.json produced by scan/lint (all suggestedOps)')
  .option('--plan <file>', 'plan file: PlanOp[], {planOps}, or pilot-edit.json (use with --space/--tier)')
  .option('--tier <tier>', 'for pilot plan files: a | b | all', 'all')
  .option('--out <file>', 'ops output file', 'ops.json')
  .option('--publish', 'publish the edit (needs GEO_PRIVATE_KEY env)', false)
  .option('--space <id>', 'space id to publish into (required with --publish)')
  .option('--edit-name <name>', 'edit name', 'geo-copilot dedup fix')
  .option('--network <net>', 'MAINNET | TESTNET | TESTNET_V2 | TESTNET_V3', 'MAINNET')
  .option('--rpc-url <url>', 'override chain RPC (defaults follow --network)')
  .option(
    '--safe-address <address>',
    'already-deployed Geo Safe on chain 19411 to publish from (defaults to env GEO_SAFE_ADDRESS)',
    process.env['GEO_SAFE_ADDRESS'],
  )
  .option('--dry-run', 'upload to IPFS and build calldata but do not send the tx', false)
  .option('--exclude <file>', 'JSON with entity ids that must never be deleted (drops their deleteEntity ops)')
  .action(async opts => {
    if (!opts.report && !opts.plan) throw new Error('Pass --report <report.json> or --plan <plan.json>');
    let planOps: PlanOp[];
    if (opts.plan) {
      planOps = loadPlanOps(
        JSON.parse(await readFile(resolve(opts.plan), 'utf8')),
        opts.space,
        String(opts.tier).toLowerCase(),
      );
    } else {
      const report = JSON.parse(await readFile(resolve(opts.report), 'utf8')) as DuplicateReport;
      planOps = report.clusters.flatMap(c => c.suggestedOps);
    }
    if (opts.exclude) {
      const excluded = collectExcludedIds(JSON.parse(await readFile(resolve(opts.exclude), 'utf8')));
      const before = planOps.length;
      planOps = planOps.filter(
        op => !(op.kind === 'deleteEntity' && excluded.has(op.id.replace(/-/g, '').toLowerCase())),
      );
      console.log(`--exclude: dropped ${before - planOps.length} deleteEntity op(s) (${excluded.size} protected ids)`);
    }
    const { ops, skipped } = serializePlanOps(planOps);
    await writeFile(
      resolve(opts.out),
      JSON.stringify(
        {
          _note:
            'planOps are portable; ops contain binary ids (Uint8Array) serialized for inspection only — publishing always re-serializes from planOps in-process.',
          planOps,
          opsPreview: ops.map(o => o.type),
          skipped,
        },
        null,
        2,
      ),
      'utf8',
    );
    console.log(`${ops.length} GRC-20 ops (${skipped.length} advisory skips) -> ${opts.out}`);

    if (!opts.publish) return;
    if (planOps.length === 0) throw new Error('Plan is empty — nothing to publish');
    const privateKey = process.env['GEO_PRIVATE_KEY'];
    if (!privateKey || !privateKey.startsWith('0x')) {
      throw new Error('GEO_PRIVATE_KEY env var (0x...) is required for --publish. Export it from geobrowser.io/export-wallet; never commit it.');
    }
    if (!opts.space) throw new Error('--space is required with --publish');
    const result = await publishEdit({
      spaceId: opts.space,
      editName: opts.editName,
      ops,
      privateKey: privateKey as `0x${string}`,
      network: opts.network,
      rpcUrl: opts.rpcUrl,
      safeAddress: opts.safeAddress as `0x${string}` | undefined,
      dryRun: Boolean(opts.dryRun),
    });
    console.log(JSON.stringify(result, null, 2));
  });

/**
 * Gathers every 32-hex entity id found anywhere in the exclude file, so both
 * a flat array and a {spaces: {spaceId: [ids]}} layout work.
 */
function collectExcludedIds(parsed: unknown): Set<string> {
  const ids = new Set<string>();
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      const hex = node.replace(/-/g, '').toLowerCase();
      if (/^[0-9a-f]{32}$/.test(hex)) ids.add(hex);
    } else if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (node !== null && typeof node === 'object') {
      Object.values(node).forEach(walk);
    }
  };
  walk(parsed);
  return ids;
}

/** Accepts PlanOp[], {planOps}, or pilot-edit.json {spaces:{id:{tierA,tierB}}}. */
function loadPlanOps(parsed: unknown, space: string | undefined, tier: string): PlanOp[] {
  if (Array.isArray(parsed)) return parsed as PlanOp[];
  const obj = parsed as { planOps?: PlanOp[]; spaces?: Record<string, { label?: string; tierA?: { planOps?: PlanOp[] }; tierB?: { planOps?: PlanOp[] } }> };
  if (Array.isArray(obj.planOps)) return obj.planOps;
  if (obj.spaces) {
    const norm = (x: string): string => x.replace(/-/g, '').toLowerCase();
    const keys = Object.keys(obj.spaces);
    const key = space ? keys.find(k => norm(k) === norm(space)) : keys[0];
    if (!key) throw new Error(`Plan has spaces [${keys.join(', ')}], none matches --space ${space ?? '(none)'}`);
    const entry = obj.spaces[key]!;
    const a = entry.tierA?.planOps ?? [];
    const b = entry.tierB?.planOps ?? [];
    if (tier === 'a') return a;
    if (tier === 'b') return b;
    return [...a, ...b];
  }
  throw new Error('Unrecognized plan file shape');
}

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
