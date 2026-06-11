// Drives the MCP server over stdio with raw JSON-RPC and prints condensed results.
import { spawn } from 'node:child_process';

const child = spawn('node', ['packages/mcp-server/dist/main.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    GEO_SNAPSHOT: 'examples/snapshot.sample.json',
    GEO_SPACE: 'sample-crypto',
    GEO_UNIQUE_URL_PROPS: 'aaaa0000000040008000000000000001',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});

const pending = new Map();
let buffer = '';
child.stdout.on('data', chunk => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});
child.stderr.on('data', d => process.stderr.write(`[server] ${d}`));

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  return new Promise(resolve => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}
const text = res => JSON.parse(res.result.content[0].text);

const init = await rpc('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'smoke', version: '0.0.1' },
});
notify('notifications/initialized', {});
console.log('server:', init.result.serverInfo.name, init.result.serverInfo.version);

const tools = await rpc('tools/list', {});
console.log('tools:', tools.result.tools.map(t => t.name).join(', '));

const search = await rpc('tools/call', { name: 'search_entities', arguments: { query: 'Pashov' } });
console.log('search Pashov ->', text(search).hits.map(h => `${h.name}@${h.score}`).join(' | '));

const dup = await rpc('tools/call', {
  name: 'check_duplicates',
  arguments: {
    name: 'Aave v3.1 audit by Certora',
    values: [
      {
        propertyId: 'aaaa0000000040008000000000000001',
        text: 'https://github.com/aave/audits/blob/main/certora-core-v3-1.pdf',
      },
    ],
  },
});
const d = text(dup);
console.log('check_duplicates ->', d.verdict, '| canonical:', d.canonical.name, '| ops:', d.suggestedOps.map(o => o.kind).join(','));

const resolve = await rpc('tools/call', {
  name: 'resolve_canonical_id',
  arguments: { name: 'Mixbytes', typeId: 'cccc0000000040008000000000000001' },
});
console.log('resolve Mixbytes ->', JSON.stringify(text(resolve).best));

const gen = await rpc('tools/call', { name: 'generate_ops', arguments: { planOps: d.suggestedOps } });
console.log('generate_ops ->', JSON.stringify({ opCount: text(gen).opCount, preview: text(gen).opsPreview, skipped: text(gen).skipped.length }));

const pub = await rpc('tools/call', {
  name: 'publish_edit',
  arguments: { editName: 'smoke test edit', planOps: d.suggestedOps, confirm: true },
});
console.log('publish_edit (no key) ->', text(pub).error?.slice(0, 60));

child.kill();
process.exit(0);
