import { describe, expect, it } from 'vitest';
import {
  jaccard,
  levenshtein,
  normalizeName,
  tokenSetRatio,
  tokenSortRatio,
  tokenize,
  versionTokens,
  versionsDisjoint,
} from '../src/signals/text.js';
import { canonicalUrlKey } from '../src/signals/url-key.js';
import { DEFAULT_STOPWORDS } from '../src/model.js';

describe('text signals', () => {
  it('normalizes casing, dashes and whitespace', () => {
    expect(normalizeName('Aave - Sigma Prime - V3 core audit')).toBe('aave sigma prime v3 core audit');
    expect(normalizeName('MixBytes')).toBe(normalizeName('Mixbytes'));
    expect(normalizeName('Pashov Audit Group')).toBe(normalizeName('Pashov audit group'));
  });

  it('levenshtein basics', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('same', 'same')).toBe(0);
  });

  it('token set ratio catches restyled audit names', () => {
    const a = tokenize('Aave - Certora - Core v3.1 Audit', DEFAULT_STOPWORDS);
    const b = tokenize('Aave v3.1 audit by Certora', DEFAULT_STOPWORDS);
    expect(tokenSetRatio(a, b)).toBeGreaterThanOrEqual(0.95);
    expect(tokenSortRatio(a, b)).toBeGreaterThan(0.7);
    expect(jaccard(a, b)).toBeGreaterThan(0.6);
  });

  it('extracts and compares version tokens', () => {
    const a = versionTokens(tokenize('Aave - Certora - Core v3.1 Audit', DEFAULT_STOPWORDS));
    const b = versionTokens(tokenize('Aave - Certora - Core v3.0 Audit', DEFAULT_STOPWORDS));
    expect([...a]).toEqual(['3.1']);
    expect([...b]).toEqual(['3.0']);
    expect(versionsDisjoint(a, b)).toBe(true);
    expect(versionsDisjoint(a, versionTokens(['v3.1']))).toBe(false);
    expect(versionsDisjoint(a, new Set())).toBe(false);
  });
});

describe('url canonicalization', () => {
  it('strips scheme, www, tracking params, trailing slash and fragment', () => {
    const a = canonicalUrlKey('https://github.com/aave/audits/blob/main/x.pdf');
    const b = canonicalUrlKey('http://www.github.com/aave/audits/blob/main/x.pdf/?utm_source=geo#page=2');
    expect(a).toBeDefined();
    expect(a).toBe(b);
  });

  it('keeps meaningful query params, sorted', () => {
    expect(canonicalUrlKey('https://x.com/a?b=2&a=1')).toBe('x.com/a?a=1&b=2');
  });

  it('preserves path case (GitHub paths are case-sensitive)', () => {
    expect(canonicalUrlKey('https://github.com/Aave/X.pdf')).toBe('github.com/Aave/X.pdf');
  });

  it('returns undefined for non-urls', () => {
    expect(canonicalUrlKey('not a url')).toBeUndefined();
  });
});
