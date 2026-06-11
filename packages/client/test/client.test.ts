import { describe, expect, it } from 'vitest';
import { GraphQLError, MockTransport, type GraphQLRequest, type Transport } from '../src/graphql.js';
import { fetchSnapshot, loadSnapshot, snapshotToEntities } from '../src/snapshot.js';
import { csvToDrafts, parseCsv } from '../src/csv.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const entity = (id: string, name: string) => ({
  id,
  name,
  valuesList: [],
  relationsList: [],
});

const pgPage = (ids: string[], hasNextPage: boolean, endCursor: string | null) => ({
  entitiesConnection: {
    edges: ids.map(id => ({ node: entity(id, `Entity ${id}`) })),
    pageInfo: { hasNextPage, endCursor },
  },
});

describe('snapshot via mock transport', () => {
  it('paginates with cursors until hasNextPage=false (postgraphile)', async () => {
    const transport = MockTransport.fromRecordings([
      { match: 'query spaceEntities', data: pgPage(['e0', 'e1', 'e2'], true, 'CUR1') },
      { match: 'query spaceEntities', data: pgPage(['e3'], false, null) },
    ]);
    const snap = await fetchSnapshot(transport, 'c9f267dcb0d270718c2a3c45a64afd32', { pageSize: 3 });
    expect(snap.entities).toHaveLength(4);
    expect(snap.dialect).toBe('postgraphile');
  });

  it('degrades to a relations-free query if the schema rejects relations', async () => {
    const seen: string[] = [];
    const failing: Transport = {
      async execute<T>(req: GraphQLRequest): Promise<T> {
        seen.push(req.query);
        if (/relations(List)?\s*\{/.test(req.query)) {
          throw new GraphQLError('Cannot query field "relationsList"');
        }
        return pgPage(['e1'], false, null) as T;
      },
    };
    const snap = await fetchSnapshot(failing, 'c9f267dcb0d270718c2a3c45a64afd32', { pageSize: 10 });
    expect(snap.entities).toHaveLength(1);
    expect(seen.some(q => !/relations(List)?\s*\{/.test(q))).toBe(true);
  });

  it('loads a raw GraphQL response pasted from the browser', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'geo-'));
    const path = join(dir, 'resp.json');
    await writeFile(
      path,
      JSON.stringify({ data: { entities: [entity('e9', 'Pasted')] } }),
      'utf8',
    );
    const snap = await loadSnapshot(path);
    expect(snapshotToEntities(snap)[0]?.name).toBe('Pasted');
  });
});

describe('csv drafts', () => {
  it('parses quoted fields and CRLF', () => {
    const rows = parseCsv('a,b\r\n"x, y","with ""quotes"""\r\n');
    expect(rows).toEqual([
      ['a', 'b'],
      ['x, y', 'with "quotes"'],
    ]);
  });

  it('maps audit batch columns to drafts', () => {
    const csv = [
      'Name,Report URL,Auditor,Protocol',
      '"Aave v3.1 audit by Certora",https://github.com/aave/audits/certora.pdf,Certora,Aave',
      ',skipped-no-name,,',
    ].join('\n');
    const drafts = csvToDrafts(csv, {
      name: 'Name',
      values: { 'Report URL': 'aaaa0000000040008000000000000001' },
      relationNames: {
        Auditor: 'dddd0000000040008000000000000001',
        Protocol: 'eeee0000000040008000000000000001',
      },
      typeIds: ['bbbb0000000040008000000000000001'],
    });
    expect(drafts).toHaveLength(1);
    const d = drafts[0]!;
    expect(d.ref).toBe('row:2');
    expect(d.values?.[0]?.text).toContain('certora.pdf');
    expect(d.relations?.map(r => r.toEntityName)).toEqual(['Certora', 'Aave']);
  });
});

describe('live-schema shapes', () => {
  it('normalizes Value.value, Relation.toId and Entity.types', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'geo-live-'));
    const path = join(dir, 'live.json');
    await writeFile(
      path,
      JSON.stringify({
        data: {
          entities: [
            {
              id: '33330000000040008000000000000001',
              name: 'Aave - Certora - Core v3.1 Audit',
              types: [{ id: 'bbbb0000000040008000000000000001' }],
              values: [
                { propertyId: 'aaaa0000000040008000000000000001', value: 'https://github.com/aave/audits/x.pdf' },
              ],
              relations: [
                { id: '22220000000040008000000000000001', typeId: 'dddd0000000040008000000000000001', toId: '11110000000040008000000000000002' },
              ],
            },
          ],
        },
      }),
      'utf8',
    );
    const snap = await loadSnapshot(path);
    const [e] = snapshotToEntities(snap);
    expect(e?.typeIds).toEqual(['bbbb0000000040008000000000000001']);
    expect(e?.values[0]?.text).toContain('github.com');
    expect(e?.relations[0]?.toEntityId).toBe('11110000000040008000000000000002');
    expect(e?.relations[0]?.id).toBe('22220000000040008000000000000001');
  });
});

describe('dialect auto-detection', () => {
  it('switches postgraphile -> hypergraph on "Did you mean limit"', async () => {
    const seen: string[] = [];
    const t: Transport = {
      async execute<T>(req: GraphQLRequest): Promise<T> {
        seen.push(req.query);
        if (req.query.includes('first:')) {
          throw new GraphQLError('GraphQL errors', [{ message: 'Unknown argument "first" on field "Query.entities". Did you mean "limit"?' }]);
        }
        return { entities: [{ id: 'e1', name: 'X', values: [], relations: [], types: [] }] } as T;
      },
    };
    const snap = await fetchSnapshot(t, 'c9f267dcb0d270718c2a3c45a64afd32', { pageSize: 10, dialect: 'postgraphile' });
    expect(snap.entities).toHaveLength(1);
    expect(seen.some(q => q.includes('limit:'))).toBe(true);
  });

  it('normalizes the postgraphile shape (typeIds scalar list)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'geo-pg-'));
    const path = join(dir, 'pg.json');
    await writeFile(
      path,
      JSON.stringify({
        data: {
          entities: [
            {
              id: '33330000000040008000000000000009',
              name: 'Lido - MixBytes - V2 audit',
              typeIds: ['bbbb0000000040008000000000000001'],
              valuesList: [{ propertyId: 'aaaa0000000040008000000000000001', text: 'https://github.com/lido/audits/m.pdf' }],
              relationsList: [{ id: '22220000000040008000000000000009', typeId: 'dddd0000000040008000000000000001', toEntityId: '11110000000040008000000000000005' }],
            },
          ],
        },
      }),
      'utf8',
    );
    const [e] = snapshotToEntities(await loadSnapshot(path));
    expect(e?.typeIds).toEqual(['bbbb0000000040008000000000000001']);
    expect(e?.values[0]?.text).toContain('github.com');
    expect(e?.relations[0]?.toEntityId).toBe('11110000000040008000000000000005');
  });
});
