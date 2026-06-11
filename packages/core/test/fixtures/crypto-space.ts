/**
 * Fixtures modelled on real duplicate cases observed in the Geo "Crypto"
 * space (c9f267dcb0d270718c2a3c45a64afd32):
 *  - full duplicates with identical Report URL ("Aave - Sigma Prime - V3 core audit" x2, Trail of Bits x2)
 *  - casing duplicates ("MixBytes"/"Mixbytes", "Pashov Audit Group"/"Pashov audit group")
 *  - restyled names ("Aave - Certora - Core v3.1 Audit" vs "Aave v3.1 audit by Certora")
 *  - near-miss that must NOT merge (v3.0 vs v3.1)
 *
 * Ids are synthetic 32-hex UUIDs. The Report URL property id is a
 * placeholder until confirmed from the live schema.
 */
import { fromGraphQLEntity, type RawGraphQLEntity } from '../../src/normalize.js';
import type { NormalizedEntity } from '../../src/model.js';

/**
 * Synthetic but VALID dashless UUID v4 ids (version nibble = 4 at index 12,
 * variant nibble = 8 at index 16), so fixtures survive grc-20 Id() validation
 * end-to-end (core -> serializePlanOps -> publish).
 */
const vid = (group: string, n: number): string =>
  `${group.padEnd(8, '0').slice(0, 8)}000040008000${String(n).padStart(12, '0')}`;

export const REPORT_URL_PROPERTY = vid('aaaa', 1);
export const AUDIT_TYPE = vid('bbbb', 1);
export const COMPANY_TYPE = vid('cccc', 1);
export const AUDITOR_RELATION = vid('dddd', 1);
export const PROTOCOL_RELATION = vid('eeee', 1);
export const TYPES_RELATION = '8f151ba4de204e3c9cb499ddf96f48f1';

export const AAVE_ID = vid('1111', 1);
export const CERTORA_ID = vid('1111', 2);
export const SIGMA_PRIME_ID = vid('1111', 3);
export const TRAIL_OF_BITS_ID = vid('1111', 4);
export const MIXBYTES_ID = vid('1111', 5);
export const MIXBYTES_DUP_ID = vid('1111', 6);
export const PASHOV_ID = vid('1111', 7);
export const PASHOV_DUP_ID = vid('1111', 8);
export const OPENZEPPELIN_ID = vid('1111', 9);

let counter = 0;
const nextId = (): string => vid('2222', ++counter);

function audit(params: {
  id?: string;
  name: string;
  reportUrl?: string;
  protocolId?: string;
  auditorId?: string;
}): RawGraphQLEntity {
  const relationsList: RawGraphQLEntity['relationsList'] = [
    { id: nextId(), typeId: TYPES_RELATION, toEntityId: AUDIT_TYPE },
  ];
  if (params.protocolId) relationsList.push({ id: nextId(), typeId: PROTOCOL_RELATION, toEntityId: params.protocolId });
  if (params.auditorId) relationsList.push({ id: nextId(), typeId: AUDITOR_RELATION, toEntityId: params.auditorId });
  return {
    id: params.id ?? nextId(),
    name: params.name,
    valuesList: params.reportUrl ? [{ propertyId: REPORT_URL_PROPERTY, text: params.reportUrl }] : [],
    relationsList,
  };
}

function company(id: string, name: string, website?: string): RawGraphQLEntity {
  return {
    id,
    name,
    valuesList: website ? [{ propertyId: 'eed38e74e67946bf8a42ea3e4f8fb5fb', text: website }] : [],
    relationsList: [{ id: nextId(), typeId: TYPES_RELATION, toEntityId: COMPANY_TYPE }],
  };
}

export const SIGMA_A_ID = vid('3333', 1);
export const SIGMA_B_ID = vid('3333', 2);
export const TOB_A_ID = vid('3333', 3);
export const TOB_B_ID = vid('3333', 4);
export const CERTORA_V31_ID = vid('3333', 5);
export const CERTORA_V30_ID = vid('3333', 6);

const rawEntities: RawGraphQLEntity[] = [
  // full duplicates: identical Report URL, identical name
  audit({
    id: SIGMA_A_ID,
    name: 'Aave - Sigma Prime - V3 core audit',
    reportUrl: 'https://github.com/aave/audits/blob/main/sigma-prime-v3-core.pdf',
    protocolId: AAVE_ID,
    auditorId: SIGMA_PRIME_ID,
  }),
  audit({
    id: SIGMA_B_ID,
    name: 'Aave - Sigma Prime - V3 core audit',
    reportUrl: 'http://www.github.com/aave/audits/blob/main/sigma-prime-v3-core.pdf/?utm_source=geo',
    protocolId: AAVE_ID,
    auditorId: SIGMA_PRIME_ID,
  }),
  audit({
    id: TOB_A_ID,
    name: 'Aave - Trail of Bits - V3 core audit',
    reportUrl: 'https://github.com/aave/audits/blob/main/trail-of-bits-v3-core.pdf',
    protocolId: AAVE_ID,
    auditorId: TRAIL_OF_BITS_ID,
  }),
  audit({
    id: TOB_B_ID,
    name: 'Aave - Trail of Bits - V3 core audit',
    reportUrl: 'https://github.com/aave/audits/blob/main/trail-of-bits-v3-core.pdf',
    protocolId: AAVE_ID,
    auditorId: TRAIL_OF_BITS_ID,
  }),
  // restyled-name case (no shared URL on purpose: name+shape must catch it)
  audit({
    id: CERTORA_V31_ID,
    name: 'Aave - Certora - Core v3.1 Audit',
    reportUrl: 'https://github.com/aave/audits/blob/main/certora-core-v3-1.pdf',
    protocolId: AAVE_ID,
    auditorId: CERTORA_ID,
  }),
  // near-miss: different version, must NOT merge with v3.1
  audit({
    id: CERTORA_V30_ID,
    name: 'Aave - Certora - Core v3.0 Audit',
    reportUrl: 'https://github.com/aave/audits/blob/main/certora-core-v3-0.pdf',
    protocolId: AAVE_ID,
    auditorId: CERTORA_ID,
  }),
  // cross-protocol near-miss: same auditor+scope wording, different protocol
  audit({
    name: 'Compound - OpenZeppelin - V3 audit',
    reportUrl: 'https://github.com/compound/audits/oz-v3.pdf',
    protocolId: nextId(),
    auditorId: OPENZEPPELIN_ID,
  }),
  // casing duplicates among companies
  company(MIXBYTES_ID, 'MixBytes', 'https://mixbytes.io'),
  company(MIXBYTES_DUP_ID, 'Mixbytes'),
  company(PASHOV_ID, 'Pashov Audit Group'),
  company(PASHOV_DUP_ID, 'Pashov audit group'),
  company(CERTORA_ID, 'Certora', 'https://certora.com'),
  company(SIGMA_PRIME_ID, 'Sigma Prime'),
  company(TRAIL_OF_BITS_ID, 'Trail of Bits'),
  company(OPENZEPPELIN_ID, 'OpenZeppelin'),
];

export function cryptoSpaceFixture(): NormalizedEntity[] {
  return rawEntities.map(fromGraphQLEntity);
}
