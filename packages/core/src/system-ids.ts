/**
 * Well-known Geo system ids, verified against
 * graphprotocol/grc-20-ts src/core/ids/{system,content}.ts.
 * All ids are UUID v4 without dashes.
 */
export const SystemIds = {
  NAME_PROPERTY: 'a126ca530c8e48d5b88882c734c38935',
  DESCRIPTION_PROPERTY: '9b1f76ff9711404c861e59dc3fa7d037',
  TYPES_PROPERTY: '8f151ba4de204e3c9cb499ddf96f48f1',
  WEBSITE_PROPERTY: 'eed38e74e67946bf8a42ea3e4f8fb5fb',
  X_PROPERTY: '0d6259784b3c4b57a86fde45c997c73c',
  WEB_URL_PROPERTY: '412ff593e9154012a43d4c27ec5c68b6',
  WEB_ARCHIVE_URL_PROPERTY: '54aa3b25c45d4974a9376bb895aeaefe',
} as const;

/**
 * Ids observed in the live Crypto / Crypto datasets spaces on
 * testnet-api.geobrowser.io (dump of 2026-06-11), not part of the official
 * system-ids set:
 *  - REPORT_URL: the property both audit batches keep the report link under
 *    (203 url values in Crypto, 12 in Crypto datasets; verified on
 *    "EigenLayer - Sigma Prime - M1 core audit" and the Espresso/Cantina audit)
 *  - AUDIT_TYPE: typeIds of those audit entities
 *  - LINKEDIN: 278/56 url values, verified on company entities
 */
export const ObservedCryptoIds = {
  REPORT_URL_PROPERTY: '0998ac0f753247ea872d3e7cadd98e62',
  AUDIT_TYPE: 'beaca72fca1b4c5699e04bea0369eefd',
  LINKEDIN_PROPERTY: 'cdf139bce610446cac42d57cd7967478',
  CRYPTO_SPACE: 'c9f267dcb0d270718c2a3c45a64afd32',
  CRYPTO_DATASETS_SPACE: '5908c73ad336472ccbd983491d2d17e4',
} as const;

/**
 * Property ids that look like a URL and are unique-ish by default. The
 * space-specific "Report URL" property id must be added via config once
 * confirmed from the live schema (see prepared GraphQL queries in /queries).
 */
/** Identity tier: the URL IS the entity. */
export const DEFAULT_IDENTITY_URL_PROPERTIES: string[] = [
  ObservedCryptoIds.REPORT_URL_PROPERTY,
  SystemIds.WEB_ARCHIVE_URL_PROPERTY,
];

/** Profile tier: shared homepages/social links — strong but not identity. */
export const DEFAULT_PROFILE_URL_PROPERTIES: string[] = [
  SystemIds.WEBSITE_PROPERTY,
  SystemIds.X_PROPERTY,
  SystemIds.WEB_URL_PROPERTY,
  ObservedCryptoIds.LINKEDIN_PROPERTY,
];

/** @deprecated kept for compatibility; identity tier. */
export const DEFAULT_UNIQUE_URL_PROPERTIES: string[] = DEFAULT_IDENTITY_URL_PROPERTIES;
