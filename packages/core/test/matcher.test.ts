import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/model.js';
import { match, pickCanonical } from '../src/matcher.js';
import { scorePair } from '../src/scoring.js';
import {
  CERTORA_V30_ID,
  CERTORA_V31_ID,
  MIXBYTES_DUP_ID,
  MIXBYTES_ID,
  PASHOV_DUP_ID,
  PASHOV_ID,
  REPORT_URL_PROPERTY,
  SIGMA_A_ID,
  SIGMA_B_ID,
  TOB_A_ID,
  TOB_B_ID,
  cryptoSpaceFixture,
} from './fixtures/crypto-space.js';

const config = defaultConfig({ uniqueUrlPropertyIds: [REPORT_URL_PROPERTY] });

function clusterContaining(clusters: ReturnType<typeof match>['clusters'], id: string) {
  return clusters.find(c => c.some(e => e.id === id));
}

describe('scan mode on Crypto-space fixtures', () => {
  const entities = cryptoSpaceFixture();
  const result = match(entities, config);

  it('clusters full duplicates with identical Report URL as auto-duplicates', () => {
    const sigma = clusterContaining(result.clusters, SIGMA_A_ID);
    expect(sigma).toBeDefined();
    expect(sigma?.map(e => e.id).sort()).toEqual([SIGMA_A_ID, SIGMA_B_ID].sort());
    const pair = result.pairFor(SIGMA_A_ID, SIGMA_B_ID);
    expect(pair?.verdict).toBe('duplicate');
    expect(pair?.signals.some(s => s.kind === 'url.exact')).toBe(true);

    const tob = clusterContaining(result.clusters, TOB_A_ID);
    expect(tob?.map(e => e.id).sort()).toEqual([TOB_A_ID, TOB_B_ID].sort());
  });

  it('clusters casing duplicates (MixBytes/Mixbytes, Pashov)', () => {
    const mix = clusterContaining(result.clusters, MIXBYTES_ID);
    expect(mix?.map(e => e.id).sort()).toEqual([MIXBYTES_DUP_ID, MIXBYTES_ID].sort());
    expect(result.pairFor(MIXBYTES_ID, MIXBYTES_DUP_ID)?.verdict).toBe('duplicate');

    const pashov = clusterContaining(result.clusters, PASHOV_ID);
    expect(pashov?.map(e => e.id).sort()).toEqual([PASHOV_DUP_ID, PASHOV_ID].sort());
  });

  it('does NOT merge different versions (v3.0 vs v3.1) despite near-identical names', () => {
    const v31 = clusterContaining(result.clusters, CERTORA_V31_ID);
    const inSameCluster = v31?.some(e => e.id === CERTORA_V30_ID) ?? false;
    expect(inSameCluster).toBe(false);

    const [a, b] = [
      cryptoSpaceFixture().find(e => e.id === CERTORA_V31_ID),
      cryptoSpaceFixture().find(e => e.id === CERTORA_V30_ID),
    ];
    const pair = scorePair(a!, b!, config);
    expect(pair.signals.some(s => s.kind === 'version.veto')).toBe(true);
    expect(pair.score).toBeLessThanOrEqual(config.versionVetoCap);
  });

  it('does not call cross-protocol audits duplicates', () => {
    const entitiesById = new Map(entities.map(e => [e.name, e]));
    const oz = entitiesById.get('Compound - OpenZeppelin - V3 audit');
    expect(oz).toBeDefined();
    for (const p of result.pairs) {
      if (p.a.id === oz!.id || p.b.id === oz!.id) {
        expect(p.verdict).not.toBe('duplicate');
      }
    }
  });

  it('picks the richer entity as canonical', () => {
    const { canonical, reason } = pickCanonical([
      { id: 'x', isDraft: false, name: 'MixBytes', typeIds: [], values: [{ propertyId: 'p', text: 'https://mixbytes.io' }], relations: [] },
      { id: 'y', isDraft: false, name: 'Mixbytes', typeIds: [], values: [], relations: [] },
    ]);
    expect(canonical.id).toBe('x');
    expect(reason).toContain('most relations/values');
  });

  it('prefers existing entity over a draft as canonical', () => {
    const { canonical } = pickCanonical([
      { id: 'draft:1', isDraft: true, name: 'A', typeIds: [], values: [], relations: [{ typeId: 't', toEntityId: 'z' }] },
      { id: 'real', isDraft: false, name: 'A', typeIds: [], values: [], relations: [] },
    ]);
    expect(canonical.id).toBe('real');
  });
});
