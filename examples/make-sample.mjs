// Generates examples/snapshot.sample.json — a miniature of the real Crypto
// space with the duplicate cases the engine is built around. Run:
//   node examples/make-sample.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const vid = (group, n) => `${group.padEnd(8, '0').slice(0, 8)}000040008000${String(n).padStart(12, '0')}`;

export const IDS = {
  REPORT_URL_PROPERTY: vid('aaaa', 1),
  AUDIT_TYPE: vid('bbbb', 1),
  COMPANY_TYPE: vid('cccc', 1),
  AUDITOR_RELATION: vid('dddd', 1),
  PROTOCOL_RELATION: vid('eeee', 1),
  TYPES_RELATION: '8f151ba4de204e3c9cb499ddf96f48f1',
  WEBSITE_PROPERTY: 'eed38e74e67946bf8a42ea3e4f8fb5fb',
  AAVE: vid('1111', 1),
  CERTORA: vid('1111', 2),
  SIGMA_PRIME: vid('1111', 3),
  TRAIL_OF_BITS: vid('1111', 4),
  MIXBYTES: vid('1111', 5),
  MIXBYTES_DUP: vid('1111', 6),
  PASHOV: vid('1111', 7),
  PASHOV_DUP: vid('1111', 8),
  OPENZEPPELIN: vid('1111', 9),
  COMPOUND: vid('1111', 10),
};

let c = 0;
const rel = () => vid('2222', ++c);

const audit = (id, name, reportUrl, protocolId, auditorId) => ({
  id,
  name,
  valuesList: reportUrl ? [{ propertyId: IDS.REPORT_URL_PROPERTY, text: reportUrl }] : [],
  relationsList: [
    { id: rel(), typeId: IDS.TYPES_RELATION, toEntityId: IDS.AUDIT_TYPE },
    ...(protocolId ? [{ id: rel(), typeId: IDS.PROTOCOL_RELATION, toEntityId: protocolId }] : []),
    ...(auditorId ? [{ id: rel(), typeId: IDS.AUDITOR_RELATION, toEntityId: auditorId }] : []),
  ],
});

const company = (id, name, website) => ({
  id,
  name,
  valuesList: website ? [{ propertyId: IDS.WEBSITE_PROPERTY, text: website }] : [],
  relationsList: [{ id: rel(), typeId: IDS.TYPES_RELATION, toEntityId: IDS.COMPANY_TYPE }],
});

const entities = [
  audit(vid('3333', 1), 'Aave - Sigma Prime - V3 core audit', 'https://github.com/aave/audits/blob/main/sigma-prime-v3-core.pdf', IDS.AAVE, IDS.SIGMA_PRIME),
  audit(vid('3333', 2), 'Aave - Sigma Prime - V3 core audit', 'http://www.github.com/aave/audits/blob/main/sigma-prime-v3-core.pdf/?utm_source=geo', IDS.AAVE, IDS.SIGMA_PRIME),
  audit(vid('3333', 3), 'Aave - Trail of Bits - V3 core audit', 'https://github.com/aave/audits/blob/main/trail-of-bits-v3-core.pdf', IDS.AAVE, IDS.TRAIL_OF_BITS),
  audit(vid('3333', 4), 'Aave - Trail of Bits - V3 core audit', 'https://github.com/aave/audits/blob/main/trail-of-bits-v3-core.pdf', IDS.AAVE, IDS.TRAIL_OF_BITS),
  audit(vid('3333', 5), 'Aave - Certora - Core v3.1 Audit', 'https://github.com/aave/audits/blob/main/certora-core-v3-1.pdf', IDS.AAVE, IDS.CERTORA),
  audit(vid('3333', 6), 'Aave - Certora - Core v3.0 Audit', 'https://github.com/aave/audits/blob/main/certora-core-v3-0.pdf', IDS.AAVE, IDS.CERTORA),
  audit(vid('3333', 7), 'Compound - OpenZeppelin - V3 audit', 'https://github.com/compound/audits/oz-v3.pdf', IDS.COMPOUND, IDS.OPENZEPPELIN),
  // an audit that points at the *duplicate* MixBytes entity -> scan must re-point it
  audit(vid('3333', 8), 'Lido - MixBytes - V2 audit', 'https://github.com/lidofinance/audits/mixbytes-v2.pdf', null, IDS.MIXBYTES_DUP),
  company(IDS.MIXBYTES, 'MixBytes', 'https://mixbytes.io'),
  company(IDS.MIXBYTES_DUP, 'Mixbytes'),
  company(IDS.PASHOV, 'Pashov Audit Group'),
  company(IDS.PASHOV_DUP, 'Pashov audit group'),
  company(IDS.CERTORA, 'Certora', 'https://certora.com'),
  company(IDS.SIGMA_PRIME, 'Sigma Prime'),
  company(IDS.TRAIL_OF_BITS, 'Trail of Bits'),
  company(IDS.OPENZEPPELIN, 'OpenZeppelin'),
  company(IDS.AAVE, 'Aave'),
  company(IDS.COMPOUND, 'Compound'),
];

const snapshot = { space: 'sample-crypto', fetchedAt: new Date().toISOString(), entities };
const out = join(dirname(fileURLToPath(import.meta.url)), 'snapshot.sample.json');
writeFileSync(out, JSON.stringify(snapshot, null, 2));
console.log(`${entities.length} entities -> ${out}`);
