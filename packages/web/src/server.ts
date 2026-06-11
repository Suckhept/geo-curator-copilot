/**
 * geocheck.space — public demo for Geo Curator Copilot.
 *
 * Plain node:http, no framework:
 *   GET /                      landing page (static/index.html)
 *   GET /healthz               liveness
 *   GET /api/proposal/:id      proxy to testnet-api proposal status (CORS-free)
 *   GET /api/scan/:spaceId     live duplicate scan of a Geo space (capped, cached)
 */
import { createServer, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReport, defaultConfig } from '@geo-copilot/core';
import { GEOBROWSER_API_ORIGIN, HttpTransport, fetchSnapshot, snapshotToEntities } from '@geo-copilot/client';

const PORT = Number(process.env['PORT'] ?? 8080);
const STATIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'static');
/** Live-scan cap: 30 pages x 100 = 3000 entities keeps demo latency sane. */
const SCAN_MAX_PAGES = 30;
const SCAN_CACHE_TTL_MS = 10 * 60 * 1000;

const HEX32 = /^[0-9a-f]{32}$/;

interface CacheEntry {
  at: number;
  body: string;
}
const scanCache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<string>>();

function send(res: ServerResponse, status: number, body: string, type = 'application/json'): void {
  res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
  res.end(body);
}

async function scanSpace(spaceId: string): Promise<string> {
  const transport = new HttpTransport(GEOBROWSER_API_ORIGIN);
  const snapshot = await fetchSnapshot(transport, spaceId, { pageSize: 100, maxPages: SCAN_MAX_PAGES });
  const targets = snapshotToEntities(snapshot);
  const { report } = buildReport({ space: spaceId, mode: 'scan', targets, config: defaultConfig({}) });
  const clusters = report.clusters
    .slice()
    .sort((a, b) => b.duplicates.length - a.duplicates.length)
    .slice(0, 25)
    .map(c => ({
      canonical: { id: c.canonical.id, name: c.canonical.name },
      duplicates: c.duplicates.map(d => ({ id: d.id, name: d.name, score: d.score, verdict: d.verdict })),
    }));
  return JSON.stringify({
    spaceId,
    scannedEntities: targets.length,
    truncated: targets.length >= SCAN_MAX_PAGES * 100,
    stats: report.stats,
    topClusters: clusters,
    generatedAt: new Date().toISOString(),
  });
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
      const cached = scanCache.get(spaceId);
      if (cached && Date.now() - cached.at < SCAN_CACHE_TTL_MS) return send(res, 200, cached.body);
      let job = inflight.get(spaceId);
      if (!job) {
        job = scanSpace(spaceId).finally(() => inflight.delete(spaceId));
        inflight.set(spaceId, job);
      }
      const body = await job;
      scanCache.set(spaceId, { at: Date.now(), body });
      return send(res, 200, body);
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
