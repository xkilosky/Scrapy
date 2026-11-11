import { describe, expect, it } from 'vitest';
import { JUNK_SITES } from '../lib/search/junk-sites';
import { canonical, junkMatcher, mergeHits, siteOf, tidyDate, tidySnippet } from '../lib/search/merge';

const hit = (url: string, title = 'T', snippet = 'S', published?: string) => ({ url, title, snippet, ...(published ? { published } : {}) });
const base = { count: 8, perSite: 3, junk: JUNK_SITES };

describe('canonical', () => {
  it('treats small differences in a link as the same page', () => {
    const key = canonical('https://example.com/docs/page')?.key;
    for (const same of [
      'https://www.example.com/docs/page/',
      'http://example.com/docs/page#section',
      'https://example.com/docs/page?utm_source=x&utm_medium=y',
      'https://m.example.com/docs/page?fbclid=abc',
      'https://EXAMPLE.com/docs/page/index.html',
    ]) {
      expect(canonical(same)?.key, same).toBe(key);
    }
  });

  it('keeps links apart that really differ', () => {
    expect(canonical('https://example.com/a?id=1')?.key).not.toBe(canonical('https://example.com/a?id=2')?.key);
    expect(canonical('https://example.com/a')?.key).not.toBe(canonical('https://docs.example.com/a')?.key);
  });

  it('removes tracking from the link that is shown, and refuses non-web links', () => {
    expect(canonical('https://example.com/a?utm_campaign=x&id=7#top')?.url).toBe('https://example.com/a?id=7');
    expect(canonical('mailto:a@example.com')).toBeNull();
    expect(canonical('not a link')).toBeNull();
  });
});

describe('siteOf', () => {
  it('finds the site a host belongs to', () => {
    expect(siteOf('docs.example.com')).toBe('example.com');
    expect(siteOf('www.example.com')).toBe('example.com');
    expect(siteOf('shop.example.co.uk')).toBe('example.co.uk');
    expect(siteOf('someone.github.io')).toBe('someone.github.io');
    expect(siteOf('project.vercel.app')).toBe('project.vercel.app');
    expect(siteOf('en.wikipedia.org')).toBe('wikipedia.org');
  });
});

describe('junkMatcher', () => {
  const junk = junkMatcher(JUNK_SITES);

  it('matches copycat sites and their sub-sites', () => {
    for (const host of ['stackoom.com', 'www.stackoom.com', 'qastack.com', 'qastack.com.br', 'it-swarm.dev', 'it-swarm-fr.com', 'githubmemory.com', 'pt.coder.work']) {
      expect(junk(host), host).toBe(true);
    }
  });

  it('never matches the originals or lookalike names', () => {
    for (const host of ['stackoverflow.com', 'github.com', 'developer.mozilla.org', 'notstackoom.com', 'stackoom.com.evil.example', 'react.dev']) {
      expect(junk(host), host).toBe(false);
    }
  });
});

describe('mergeHits', () => {
  it('lists a page found by two engines once, and ranks it first', () => {
    const { results, stats } = mergeHits(
      [
        { engine: 'a', hits: [hit('https://one.example/1'), hit('https://two.example/2'), hit('https://shared.example/page')] },
        { engine: 'b', hits: [hit('https://three.example/3'), hit('https://www.shared.example/page/?utm_source=b')] },
      ],
      base,
    );
    expect(results[0]?.url).toBe('https://shared.example/page');
    expect(results[0]?.foundBy).toEqual(['a', 'b']);
    expect(results.map((r) => r.url).filter((u) => u.includes('shared.example'))).toHaveLength(1);
    expect(stats.duplicates).toBe(1);
    expect(results.map((r) => r.rank)).toEqual([1, 2, 3, 4]);
  });

  it('ranks any page found by both above every page found by one', () => {
    const many = Array.from({ length: 15 }, (_, i) => hit(`https://site${i}.example/`));
    const { results } = mergeHits(
      [
        { engine: 'a', hits: [...many, hit('https://both.example/')] },
        { engine: 'b', hits: [...Array.from({ length: 15 }, (_, i) => hit(`https://other${i}.example/`)), hit('https://both.example/')] },
      ],
      { ...base, count: 20 },
    );
    expect(results[0]?.url).toBe('https://both.example/');
  });

  it('removes copycat sites and counts them', () => {
    const { results, stats } = mergeHits([{ engine: 'a', hits: [hit('https://stackoom.com/q/1'), hit('https://stackoverflow.com/q/1'), hit('https://qastack.ru/x')] }], base);
    expect(results.map((r) => r.url)).toEqual(['https://stackoverflow.com/q/1']);
    expect(stats.junk).toBe(2);
  });

  it('allows no more than three results from one site', () => {
    const hits = Array.from({ length: 6 }, (_, i) => hit(`https://docs.big.example/p${i}`));
    const { results, stats } = mergeHits([{ engine: 'a', hits: [...hits, hit('https://small.example/')] }], base);
    expect(results.filter((r) => r.site === 'big.example')).toHaveLength(3);
    expect(results.at(-1)?.url).toBe('https://small.example/');
    expect(stats.overPerSite).toBe(3);
  });

  it('lifts the per-site limit when the caller named the sites', () => {
    const hits = Array.from({ length: 6 }, (_, i) => hit(`https://react.dev/p${i}`));
    const { results } = mergeHits([{ engine: 'a', hits: [...hits, hit('https://other.example/')] }], { ...base, includeSites: ['react.dev'] });
    expect(results).toHaveLength(6);
    expect(results.every((r) => r.url.startsWith('https://react.dev/'))).toBe(true);
  });

  it('applies the leave-out list and the date filter', () => {
    const now = Date.parse('2026-11-11T00:00:00Z');
    const { results } = mergeHits(
      [{ engine: 'a', hits: [hit('https://a.example/', 'A', 's', '2026-11-09'), hit('https://b.example/', 'B', 's', '2025-01-01'), hit('https://c.example/', 'C', 's'), hit('https://blocked.example/x')] }],
      { ...base, excludeSites: ['blocked.example'], recency: 'week', now },
    );
    expect(results.map((r) => r.title)).toEqual(['A', 'C']);
    expect(results[0]?.published).toBe('2026-11-09');
  });

  it('returns no more than asked for', () => {
    const hits = Array.from({ length: 30 }, (_, i) => hit(`https://s${i}.example/`));
    expect(mergeHits([{ engine: 'a', hits }], { ...base, count: 5 }).results).toHaveLength(5);
  });

  it('prefers the https form and the fuller description', () => {
    const { results } = mergeHits(
      [
        { engine: 'a', hits: [hit('http://x.example/p', 'Title A', 'short')] },
        { engine: 'b', hits: [hit('https://x.example/p', 'Title B', 'a much longer and more useful description of the page')] },
      ],
      base,
    );
    expect(results[0]?.url).toBe('https://x.example/p');
    expect(results[0]?.title).toBe('Title A');
    expect(results[0]?.snippet).toBe('a much longer and more useful description of the page');
  });
});

describe('tidySnippet and tidyDate', () => {
  it('makes one short plain line', () => {
    expect(tidySnippet('## Heading\n\nSome **bold** text with a [link](https://x.example) and ![pic](https://x.example/p.png).')).toBe('Heading Some bold text with a link and .');
    const long = tidySnippet('word '.repeat(200));
    expect(long.length).toBeLessThanOrEqual(301);
    expect(long.endsWith('…')).toBe(true);
  });

  it('reads dates and rejects nonsense', () => {
    expect(tidyDate('2026-03-02T10:00:00Z')).toBe('2026-03-02');
    expect(tidyDate('March 2, 2026')).toBe('2026-03-02');
    expect(tidyDate('N/A')).toBeUndefined();
    expect(tidyDate(undefined)).toBeUndefined();
  });
});
