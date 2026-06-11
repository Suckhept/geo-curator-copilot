/**
 * Text similarity primitives. Zero-dependency on purpose.
 */

/** Lowercase, strip diacritics-ish punctuation, collapse whitespace. */
export function normalizeName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, '-') // unicode dashes -> ascii
    .replace(/[^a-z0-9а-яё.\s-]/gi, ' ')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenize(raw: string, stopwords: readonly string[]): string[] {
  const stop = new Set(stopwords);
  return normalizeName(raw)
    .split(' ')
    .map(t => t.replace(/^\.+|\.+$/g, '')) // trim stray dots, keep "3.1"
    .filter(t => t.length > 0 && !stop.has(t));
}

/** Classic Levenshtein distance, O(len(a)*len(b)), two-row memory. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min((prev[j] as number) + 1, (curr[j - 1] as number) + 1, (prev[j - 1] as number) + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length] as number;
}

/** 1 - normalized edit distance. */
export function ratio(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1;
  const max = Math.max(a.length, b.length);
  return 1 - levenshtein(a, b) / max;
}

/** fuzzywuzzy-style token_sort_ratio. */
export function tokenSortRatio(aTokens: readonly string[], bTokens: readonly string[]): number {
  const a = [...aTokens].sort().join(' ');
  const b = [...bTokens].sort().join(' ');
  return ratio(a, b);
}

/** fuzzywuzzy-style token_set_ratio (subset-friendly). */
export function tokenSetRatio(aTokens: readonly string[], bTokens: readonly string[]): number {
  const aSet = new Set(aTokens);
  const bSet = new Set(bTokens);
  const inter = [...aSet].filter(t => bSet.has(t)).sort();
  const aOnly = [...aSet].filter(t => !bSet.has(t)).sort();
  const bOnly = [...bSet].filter(t => !aSet.has(t)).sort();
  const t0 = inter.join(' ');
  const t1 = [t0, ...aOnly].join(' ').trim();
  const t2 = [t0, ...bOnly].join(' ').trim();
  return Math.max(ratio(t0, t1), ratio(t0, t2), ratio(t1, t2));
}

export function jaccard(aTokens: readonly string[], bTokens: readonly string[]): number {
  const aSet = new Set(aTokens);
  const bSet = new Set(bTokens);
  if (aSet.size === 0 && bSet.size === 0) return 1;
  let inter = 0;
  for (const t of aSet) if (bSet.has(t)) inter++;
  const union = aSet.size + bSet.size - inter;
  return union === 0 ? 0 : inter / union;
}

const VERSION_RE = /^v?\d+(\.\d+)*$/;

/**
 * Extracts version-like tokens ("v3.1" -> "3.1", "2" -> "2").
 * Used as negative evidence: disjoint non-empty version sets veto a merge
 * (an Aave v3.0 audit is not an Aave v3.1 audit, however similar the names).
 */
export function versionTokens(tokens: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const t of tokens) {
    if (VERSION_RE.test(t)) out.add(t.replace(/^v/, ''));
  }
  return out;
}

export function versionsDisjoint(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  for (const v of a) if (b.has(v)) return false;
  return true;
}
