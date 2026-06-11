import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/model.js';
import { fromDraftRow } from '../src/normalize.js';
import { resolveCanonical } from '../src/matcher.js';
import { buildReport, renderMarkdown } from '../src/report.js';
import {
  AUDIT_TYPE,
  SIGMA_PRIME_ID,
  AAVE_ID,
  AUDITOR_RELATION,
  CERTORA_ID,
  CERTORA_V31_ID,
  COMPANY_TYPE,
  MIXBYTES_ID,
  PROTOCOL_RELATION,
  REPORT_URL_PROPERTY,
  SIGMA_A_ID,
  SIGMA_B_ID,
  cryptoSpaceFixture,
} from './fixtures/crypto-space.js';

const config = defaultConfig({ uniqueUrlPropertyIds: [REPORT_URL_PROPERTY] });

describe('pre-publish lint (drafts vs space)', () => {
  const targets = cryptoSpaceFixture();

  it('flags a restyled draft as duplicate of the existing audit (the 30-of-44 case)', () => {
    const drafts = [
      fromDraftRow({
        ref: 'row:1',
        name: 'Aave v3.1 audit by Certora',
        values: [{ propertyId: REPORT_URL_PROPERTY, text: 'https://github.com/aave/audits/blob/main/certora-core-v3-1.pdf' }],
        relations: [
          { typeId: PROTOCOL_RELATION, toEntityId: AAVE_ID },
          { typeId: AUDITOR_RELATION, toEntityId: CERTORA_ID },
        ],
        source: 'batch.csv:1',
      }),
    ];
    const { report } = buildReport({ space: 'test', mode: 'pre-publish', targets, drafts, config });
    expect(report.stats.duplicate).toBe(1);
    const cluster = report.clusters[0]!;
    expect(cluster.canonical.id).toBe(CERTORA_V31_ID);
    expect(cluster.duplicates[0]!.id).toBe('row:1');
    expect(cluster.suggestedOps.some(o => o.kind === 'skipDraft')).toBe(true);
  });

  it('flags a restyled draft WITHOUT report url as a review pair (name+shape only)', () => {
    const drafts = [
      fromDraftRow({
        ref: 'row:2',
        name: 'Aave v3.1 audit by Certora',
        relations: [
          { typeId: PROTOCOL_RELATION, toEntityId: AAVE_ID },
          { typeId: AUDITOR_RELATION, toEntityId: CERTORA_ID },
        ],
      }),
    ];
    const { report } = buildReport({ space: 'test', mode: 'pre-publish', targets, drafts, config });
    const pair = report.reviewPairs.find(p => p.a.id === 'row:2' || p.b.id === 'row:2');
    expect(pair).toBeDefined();
    expect(pair!.verdict).toBe('likely');
    expect(pair!.signals.some(s => s.kind === 'name.fuzzy')).toBe(true);
    expect(pair!.signals.some(s => s.kind === 'shape.relations')).toBe(true);
  });

  it('catches intra-batch duplicates (same Report URL within the CSV)', () => {
    const mk = (ref: string) =>
      fromDraftRow({
        ref,
        name: ref === 'row:a' ? 'Lido - MixBytes - V2 audit' : 'Lido V2 audit by MixBytes',
        values: [{ propertyId: REPORT_URL_PROPERTY, text: 'https://github.com/lidofinance/audits/mixbytes-v2.pdf' }],
      });
    const { report } = buildReport({
      space: 'test',
      mode: 'pre-publish',
      targets,
      drafts: [mk('row:a'), mk('row:b')],
      config,
    });
    expect(report.stats.duplicate).toBe(1);
    const ids = report.clusters[0]!.duplicates.map(d => d.id).concat(report.clusters[0]!.canonical.id);
    expect(ids.sort()).toEqual(['row:a', 'row:b']);
  });

  it('resolves auditor names to canonical company ids', () => {
    const companies = targets.filter(t => t.typeIds.includes(COMPANY_TYPE));
    const resolved = resolveCanonical('Mixbytes', companies, config, COMPANY_TYPE);
    expect(resolved.best?.id).toBe(MIXBYTES_ID);
    const fuzzy = resolveCanonical('Trail of Bits LLC', companies, config, COMPANY_TYPE);
    expect(fuzzy.best?.name).toBe('Trail of Bits');
  });
});

describe('scan report and fix ops', () => {
  it('suggests replaceRelation + deleteEntity for an existing duplicate', () => {
    const targets = cryptoSpaceFixture();
    const { report } = buildReport({ space: 'test', mode: 'scan', targets, config });
    const sigmaCluster = report.clusters.find(
      c => c.canonical.id === SIGMA_A_ID || c.canonical.id === SIGMA_B_ID,
    );
    expect(sigmaCluster).toBeDefined();
    const ops = sigmaCluster!.suggestedOps;
    expect(ops.some(o => o.kind === 'deleteEntity')).toBe(true);
    // both sigma audits are referenced by nothing inbound in fixtures, so no replaceRelation;
    // companies (MixBytes dup) are referenced by audits -> must produce replaceRelation
    const mixCluster = report.clusters.find(c => c.duplicates.some(d => d.name.toLowerCase() === 'mixbytes'));
    expect(mixCluster).toBeDefined();
  });

  it('re-points inbound relations from duplicate company to canonical', () => {
    const targets = cryptoSpaceFixture();
    // add an audit that points to the duplicate Mixbytes entity
    targets.push({
      id: '44440000000040008000000000000001',
      isDraft: false,
      name: 'Lido - MixBytes - V2 audit',
      typeIds: [],
      values: [],
      relations: [{ id: '44440000000040008000000000000002', typeId: AUDITOR_RELATION, toEntityId: targets.find(t => t.name === 'Mixbytes')!.id }],
    });
    const { report } = buildReport({ space: 'test', mode: 'scan', targets, config });
    const mixCluster = report.clusters.find(c => c.canonical.name === 'MixBytes');
    expect(mixCluster).toBeDefined();
    const replace = mixCluster!.suggestedOps.find(o => o.kind === 'replaceRelation');
    expect(replace).toBeDefined();
    if (replace?.kind === 'replaceRelation') {
      expect(replace.create.toEntityId).toBe(MIXBYTES_ID);
      expect(replace.deleteRelationId).toBe('44440000000040008000000000000002');
    }
    expect(mixCluster!.suggestedOps.some(o => o.kind === 'deleteEntity')).toBe(true);
  });

  it('renders a markdown summary', () => {
    const targets = cryptoSpaceFixture();
    const { report } = buildReport({ space: 'test', mode: 'scan', targets, config });
    const md = renderMarkdown(report);
    expect(md).toContain('# Dedup report');
    expect(md).toContain('url.exact');
  });
});

describe('profile-tier URL gating', () => {
  const cfg = defaultConfig({
    uniqueUrlPropertyIds: [REPORT_URL_PROPERTY],
    profileUrlPropertyIds: ['eed38e74e67946bf8a42ea3e4f8fb5fb'],
  });
  const mk = (id: string, name: string, site: string, typeId: string) => ({
    id,
    isDraft: false,
    name,
    typeIds: [typeId],
    values: [{ propertyId: 'eed38e74e67946bf8a42ea3e4f8fb5fb', text: site }],
    relations: [],
  });

  it('same homepage + same type + exact name -> duplicate', async () => {
    const { scorePair } = await import('../src/scoring.js');
    const p = scorePair(
      mk('a1110000000040008000000000000001', 'Safeheron', 'https://safeheron.com', COMPANY_TYPE),
      mk('a1110000000040008000000000000002', 'safeheron', 'https://www.safeheron.com/', COMPANY_TYPE),
      cfg,
    );
    expect(p.verdict).toBe('duplicate');
    expect(p.signals.some(s => s.kind === 'url.profile')).toBe(true);
  });

  it('same homepage but disjoint types (project vs airdrop) -> review, not auto-duplicate', async () => {
    const { scorePair } = await import('../src/scoring.js');
    const p = scorePair(
      mk('a1110000000040008000000000000003', 'Jupiter', 'https://jup.ag', COMPANY_TYPE),
      mk('a1110000000040008000000000000004', 'Jupiter Exchange Airdrop', 'https://jup.ag', AUDIT_TYPE),
      cfg,
    );
    expect(p.verdict).not.toBe('duplicate');
    expect(p.score).toBeLessThan(0.9);
  });
});

describe('real-data precision guards', () => {
  it('relation.conflict: same protocol, different auditor never auto-merges', async () => {
    const { scorePair } = await import('../src/scoring.js');
    const mk = (id: string, name: string, auditor: string) => ({
      id,
      isDraft: false,
      name,
      typeIds: [AUDIT_TYPE],
      values: [],
      relations: [
        { typeId: PROTOCOL_RELATION, toEntityId: AAVE_ID },
        { typeId: AUDITOR_RELATION, toEntityId: auditor },
      ],
    });
    const p = scorePair(
      mk('a2220000000040008000000000000001', 'Aave - Certora - Core v3.5 Audit', CERTORA_ID),
      mk('a2220000000040008000000000000002', 'Aave - Mixbytes - Core v3.5 Audit', MIXBYTES_ID),
      defaultConfig({ uniqueUrlPropertyIds: [REPORT_URL_PROPERTY] }),
    );
    expect(p.signals.some(s => s.kind === 'relation.conflict')).toBe(true);
    expect(p.score).toBeLessThanOrEqual(0.55);
  });

  it('hub guard: a Report URL shared by 5 entities loses identity power', async () => {
    const { scorePair } = await import('../src/scoring.js');
    const cfg = defaultConfig({ uniqueUrlPropertyIds: [REPORT_URL_PROPERTY] });
    const mk = (id: string, name: string) => ({
      id,
      isDraft: false,
      name,
      typeIds: [AUDIT_TYPE],
      values: [{ propertyId: REPORT_URL_PROPERTY, text: 'https://github.com/lido/audits' }],
      relations: [],
    });
    const urlDf = new Map([['github.com/lido/audits', 5]]);
    const p = scorePair(
      mk('a3330000000040008000000000000001', 'Lido - Statemind - Core V2 Audit'),
      mk('a3330000000040008000000000000002', 'Lido - MixBytes - Oracle v5 Audit'),
      cfg,
      undefined,
      undefined,
      { urlDf },
    );
    expect(p.signals.some(s => s.kind === 'url.exact')).toBe(false);
    expect(p.verdict).not.toBe('duplicate');
  });
});

describe('identity URL vs relation conflict', () => {
  it('same Report URL but different auditors -> 0.85 review, never auto-merge', async () => {
    const { scorePair } = await import('../src/scoring.js');
    const mk = (id: string, name: string, auditor: string) => ({
      id,
      isDraft: false,
      name,
      typeIds: [AUDIT_TYPE],
      values: [{ propertyId: REPORT_URL_PROPERTY, text: 'https://github.com/eigen/contracts/tree/dev/audits' }],
      relations: [{ typeId: AUDITOR_RELATION, toEntityId: auditor }],
    });
    const p = scorePair(
      mk('a4440000000040008000000000000001', 'EigenLayer - Sigma Prime - M1 core audit', SIGMA_PRIME_ID),
      mk('a4440000000040008000000000000002', 'EigenLayer - ConsenSys Diligence - core audit', CERTORA_ID),
      defaultConfig({ uniqueUrlPropertyIds: [REPORT_URL_PROPERTY] }),
    );
    expect(p.score).toBe(0.85);
    expect(p.verdict).toBe('likely');
    expect(p.signals.some(s => s.kind === 'url.exact')).toBe(true);
    expect(p.signals.some(s => s.kind === 'relation.conflict')).toBe(true);
  });
});

describe('schema-entity guard', () => {
  const mkSchemaTwin = (id: string, name: string) => ({
    id,
    isDraft: false,
    name,
    typeIds: [],
    values: [{ propertyId: REPORT_URL_PROPERTY, text: 'https://example.com/schema/date-property' }],
    relations: [],
  });

  it('never auto-merges an entity that other entities use as a type/property', () => {
    // AUDIT_TYPE is referenced via typeIds by every audit in the fixture, so
    // it is a schema entity; its same-name+same-url twin would otherwise be a
    // guaranteed duplicate-tier cluster.
    const targets = [
      ...cryptoSpaceFixture(),
      mkSchemaTwin(AUDIT_TYPE, 'Audit'),
      mkSchemaTwin('a5550000000040008000000000000001', 'Audit'),
    ];
    const { report } = buildReport({ space: 'test', mode: 'scan', targets, config });

    const inClusters = report.clusters.some(
      c => c.canonical.id === AUDIT_TYPE || c.duplicates.some(d => d.id === AUDIT_TYPE),
    );
    expect(inClusters).toBe(false);

    const demoted = report.reviewPairs.find(
      p => p.a.id === AUDIT_TYPE || p.b.id === AUDIT_TYPE,
    );
    expect(demoted).toBeDefined();
    expect(demoted!.signals.some(s => s.kind === 'schema.entity')).toBe(true);
    // no deleteEntity op may target the schema entity anywhere in the plan
    const deleted = report.clusters.flatMap(c => c.suggestedOps).filter(o => o.kind === 'deleteEntity');
    expect(deleted.some(o => 'id' in o && o.id === AUDIT_TYPE)).toBe(false);
  });

  it('identical twin pair WITHOUT schema references still clusters (control)', () => {
    const targets = [
      ...cryptoSpaceFixture(),
      mkSchemaTwin('a6660000000040008000000000000001', 'Date thing'),
      mkSchemaTwin('a6660000000040008000000000000002', 'Date thing'),
    ];
    const { report } = buildReport({ space: 'test', mode: 'scan', targets, config });
    const cluster = report.clusters.find(
      c => c.canonical.id.startsWith('a666') || c.duplicates.some(d => d.id.startsWith('a666')),
    );
    expect(cluster).toBeDefined();
  });
});

describe('intra-entity duplicate lint', () => {
  it('emits deleteRelation ops for repeated (typeId, toEntityId) pairs, keeping the first', () => {
    const entity = {
      id: 'a7770000000040008000000000000001',
      isDraft: false,
      name: 'Aave V3 core audit',
      typeIds: [AUDIT_TYPE],
      values: [],
      relations: [
        { id: 'r1110000000040008000000000000001', typeId: AUDITOR_RELATION, toEntityId: SIGMA_PRIME_ID },
        { id: 'r1110000000040008000000000000002', typeId: AUDITOR_RELATION, toEntityId: SIGMA_PRIME_ID },
        { id: 'r1110000000040008000000000000003', typeId: AUDITOR_RELATION, toEntityId: SIGMA_PRIME_ID },
        { id: 'r1110000000040008000000000000004', typeId: PROTOCOL_RELATION, toEntityId: AAVE_ID },
      ],
    };
    const { report } = buildReport({ space: 'test', mode: 'scan', targets: [...cryptoSpaceFixture(), entity], config });

    const issue = report.intraEntity.find(i => i.entityId === entity.id && i.kind === 'relation');
    expect(issue).toBeDefined();
    expect(issue!.count).toBe(3);
    const ids = issue!.planOps.map(op => (op.kind === 'deleteRelation' ? op.id : ''));
    expect(ids).toEqual(['r1110000000040008000000000000002', 'r1110000000040008000000000000003']);
    expect(report.stats.intraRelationDuplicates).toBeGreaterThanOrEqual(1);
    // unique relation (Protocol -> Aave) must not be flagged
    expect(report.intraEntity.some(i => i.key.includes(AAVE_ID))).toBe(false);
  });

  it('flags repeated (propertyId, value) pairs as advisory (no ops)', () => {
    const entity = {
      id: 'a7770000000040008000000000000002',
      isDraft: false,
      name: 'Some dataset',
      typeIds: [AUDIT_TYPE],
      values: [
        { propertyId: REPORT_URL_PROPERTY, text: 'https://example.com/report.pdf' },
        { propertyId: REPORT_URL_PROPERTY, text: 'https://example.com/report.pdf' },
      ],
      relations: [],
    };
    const { report } = buildReport({ space: 'test', mode: 'scan', targets: [...cryptoSpaceFixture(), entity], config });
    const issue = report.intraEntity.find(i => i.entityId === entity.id);
    expect(issue).toBeDefined();
    expect(issue!.kind).toBe('value');
    expect(issue!.count).toBe(2);
    expect(issue!.planOps).toHaveLength(0);
    expect(report.stats.intraValueDuplicates).toBeGreaterThanOrEqual(1);
  });
});
