export * from './model.js';
export * from './system-ids.js';
export * from './normalize.js';
export { extractFeatures, scorePair, verdictFor } from './scoring.js';
export { match, pickCanonical, resolveCanonical, type MatchResult, type MatchOptions } from './matcher.js';
export { buildReport, buildInboundIndex, collectSchemaIds, renderMarkdown, type BuildReportParams } from './report.js';
export {
  normalizeName,
  tokenize,
  levenshtein,
  ratio,
  tokenSortRatio,
  tokenSetRatio,
  jaccard,
  versionTokens,
  versionsDisjoint,
} from './signals/text.js';
export { canonicalUrlKey, looksLikeUrl } from './signals/url-key.js';
