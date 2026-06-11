/**
 * URL canonicalization. The most reliable dedup key in practice
 * (identical Report URL => identical audit entity).
 */

const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'ref',
  'ref_src',
  'fbclid',
  'gclid',
]);

export function looksLikeUrl(text: string): boolean {
  return /^https?:\/\//i.test(text.trim());
}

/**
 * Canonical key: lowercase host without "www.", scheme dropped, tracking
 * params and fragment stripped, remaining query sorted, trailing slash
 * removed. "http://Github.com/Aave/x/?utm_source=t#L1" === "https://github.com/Aave/x"
 * (path case is preserved: GitHub paths are case-sensitive).
 */
export function canonicalUrlKey(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!looksLikeUrl(trimmed)) return undefined;
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return undefined;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !TRACKING_PARAMS.has(k.toLowerCase()))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = params.length > 0 ? `?${params.map(([k, v]) => `${k}=${v}`).join('&')}` : '';
  const path = u.pathname.replace(/\/+$/, '');
  return `${host}${path}${query}`;
}
