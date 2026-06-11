/**
 * geocheck.space — public demo for Geo Curator Copilot.
 *
 * Plain node:http, no framework:
 *   GET /                      landing page (static/index.html)
 *   GET /healthz               liveness
 *   GET /api/proposal/:id      proxy to testnet-api proposal status (CORS-free)
 *   GET /api/scan/:spaceId     duplicate scan of a Geo space:
 *                              precomputed nightly report when available,
 *                              otherwise a capped live scan with an async
 *                              queue (202 + retryAfterSec while running).
 */
import { createServer, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_IDENTITY_URL_PROPERTIES,
  DEFAULT_PROFILE_URL_PROPERTIES,
  buildReport,
  defaultConfig,
  type DuplicateReport,
} from '@geo-copilot/core';
import { GEOBROWSER_API_ORIGIN, HttpTransport, fetchSnapshot, snapshotToEntities } from '@geo-copilot/client';

const PORT = Number(process.env['PORT'] ?? 8080);
const STATIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'static');
/** Nightly CLI full scans land here (see /root/precompute-scans.sh). */
const PRECOMPUTED_DIR = process.env['GEOCHECK_DATA'] ?? '/var/lib/geocheck';
/** Live scans paginate the whole space; 500 pages x 100 = 50k sanity cap. */
const SCAN_MAX_PAGES = 500;
const SCAN_CACHE_TTL_MS = 10 * 60 * 1000;
const RETRY_AFTER_SEC = 90;

const HEX32 = /^[0-9a-f]{32}$/;

interface ScanPayload {
  spaceId: string;
  scannedEntities: number;
  truncated: boolean;
  precomputed: boolean;
  generatedAt: string;
  stats: DuplicateReport['stats'];
  autoClusters: unknown[];
  reviewPairs: unknown[];
  intraEntity: unknown[];
}

const scanCache = new Map<string, { at: number; body: string }>();
const inflight = new Map<string, Promise<void>>();

function send(res: ServerResponse, status: number, body: string, type = 'application/json'): void {
  res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
  res.end(body);
}

function reportToPayload(
  report: DuplicateReport,
  opts: { spaceId: string; scannedEntities: number; truncated: boolean; precomputed: boolean; generatedAt: string },
): ScanPayload {
  const autoClusters = report.clusters.map(c => ({
    canonical: { id: c.canonical.id, name: c.canonical.name },
    duplicates: c.duplicates.map(d => ({ id: d.id, name: d.name, score: d.score })),
    planOps: c.suggestedOps,
  }));
  const reviewPairs = report.reviewPairs.slice(0, 100).map(p => ({
    a: { id: p.a.id, name: p.a.name },
    b: { id: p.b.id, name: p.b.name },
    score: p.score,
    schemaGuard: p.signals.some(s => s.kind === 'schema.entity'),
  }));
  // old precomputed files predate the intra-entity lint
  const intraEntity = (report.intraEntity ?? []).slice(0, 200).map(i => ({
    entityId: i.entityId,
    entityName: i.entityName,
    kind: i.kind,
    key: i.key,
    count: i.count,
    planOps: i.planOps,
  }));
  return { ...opts, stats: report.stats, autoClusters, reviewPairs, intraEntity };
}

async function readPrecomputed(spaceId: string): Promise<string | undefined> {
  const file = join(PRECOMPUTED_DIR, spaceId, 'report.json');
  try {
    const [raw] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
    const report = JSON.parse(raw) as DuplicateReport;
    const payload = reportToPayload(report, {
      spaceId,
      scannedEntities: report.stats.checked,
      truncated: false,
      precomputed: true,
      generatedAt: report.generatedAt,
    });
    return JSON.stringify(payload);
  } catch {
    return undefined;
  }
}

async function liveScan(spaceId: string): Promise<void> {
  const transport = new HttpTransport(GEOBROWSER_API_ORIGIN);
  const snapshot = await fetchSnapshot(transport, spaceId, { pageSize: 100, maxPages: SCAN_MAX_PAGES });
  const targets = snapshotToEntities(snapshot);
  // Same config the CLI uses for the nightly full scans — live and
  // precomputed results must agree on cluster counts.
  const config = defaultConfig({
    uniqueUrlPropertyIds: DEFAULT_IDENTITY_URL_PROPERTIES,
    profileUrlPropertyIds: DEFAULT_PROFILE_URL_PROPERTIES,
  });
  const { report } = buildReport({ space: spaceId, mode: 'scan', targets, config });
  const payload = reportToPayload(report, {
    spaceId,
    scannedEntities: targets.length,
    truncated: targets.length >= SCAN_MAX_PAGES * 100,
    precomputed: false,
    generatedAt: new Date().toISOString(),
  });
  scanCache.set(spaceId, { at: Date.now(), body: JSON.stringify(payload) });
}

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (path === '/healthz') return send(res, 200, '{"ok":true}');

    if (path === '/' || path === '/index.html') {
      const html = await readFile(join(STATIC_DIR, 'index.html'), 'utf8');
      return send(res, 200, html, 'text/html');
    }

    const proposal = path.match(/^\/api\/proposal\/([0-9a-f-]{32,36})$/);
    if (proposal) {
      const id = proposal[1]!.replace(/-/g, '');
      const upstream = await fetch(`https://testnet-api.geobrowser.io/proposals/${id}/status`, {
        signal: AbortSignal.timeout(15_000),
      });
      return send(res, upstream.status, await upstream.text());
    }

    const scan = path.match(/^\/api\/scan\/([0-9a-f-]{32,36})$/);
    if (scan) {
      const spaceId = scan[1]!.replace(/-/g, '');
      if (!HEX32.test(spaceId)) return send(res, 400, '{"error":"space id must be a 16-byte hex uuid"}');

      const precomputed = await readPrecomputed(spaceId);
      if (precomputed) return send(res, 200, precomputed);

      const cached = scanCache.get(spaceId);
      if (cached && Date.now() - cached.at < SCAN_CACHE_TTL_MS) return send(res, 200, cached.body);

      if (!inflight.has(spaceId)) {
        const job = liveScan(spaceId)
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            scanCache.set(spaceId, { at: Date.now(), body: JSON.stringify({ error: message }) });
          })
          .finally(() => inflight.delete(spaceId));
        inflight.set(spaceId, job);
      }
      return send(res, 202, JSON.stringify({ status: 'pending', retryAfterSec: RETRY_AFTER_SEC }));
    }

    return send(res, 404, '{"error":"not found"}');
  })().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    send(res, 502, JSON.stringify({ error: message }));
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`geocheck web listening on 0.0.0.0:${PORT}`);
});
