import { describe, expect, it } from 'vitest';
import { HelperError, ScrapyError } from '../lib/errors';
import { createHealth } from '../lib/health';
import type { RawHit, SearchEngine, SearchQuery } from '../lib/providers/types';
import { searchWeb, type SearchDeps } from '../lib/search';
import { createMemoryStore } from '../lib/store';
import { Trace } from '../lib/trace';
import { formatSearch } from '../lib/tools/searchWeb';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Fake extends SearchEngine {
  calls: SearchQuery[];
}

function engine(id: string, answer: RawHit[] | HelperError, opts: { delayMs?: number; siteFilter?: boolean } = {}): Fake {
  const calls: SearchQuery[] = [];
  return {
    id,
    name: id,
    hosts: [`${id}.test`],
    siteFilter: opts.siteFilter ?? true,
    calls,
    async search(query, _trace, call) {
      calls.push(query);
      if (opts.delayMs) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, opts.delayMs);
          call.signal?.addEventListener('abort', () => {
            clearTimeout(t);
            reject(new HelperError(id, 'cancelled', 'stopped'));
          });
        });
      }
      if (answer instanceof HelperError) throw answer;
      return answer;
    },
  };
}

const hits = (prefix: string, n: number): RawHit[] => Array.from({ length: n }, (_, i) => ({ url: `https://${prefix}${i}.example/page`, title: `${prefix} ${i}`, snippet: `About ${prefix} ${i}` }));

function deps(engines: SearchEngine[], extra: Partial<SearchDeps> = {}): Partial<SearchDeps> {
  const store = createMemoryStore();
  return { engines, store, health: createHealth(store), order: engines.map((e) => e.id), off: new Set(), junk: ['junk.example'], ...extra };
}

describe('searchWeb', () => {
  it('asks the first two engines at once, merges them, and leaves the others alone', async () => {
    const shared = { url: 'https://shared.example/page', title: 'Shared', snippet: 'Found by both' };
    const a = engine('a', [...hits('a', 5), shared]);
    const b = engine('b', [shared, ...hits('b', 5), { url: 'https://junk.example/x', title: 'Junk', snippet: 'copy' }]);
    const c = engine('c', hits('c', 5));
    const d = engine('d', hits('d', 5));
    const trace = new Trace();
    const out = await searchWeb({ query: '  center   a div ' }, trace, deps([a, b, c, d]));

    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);
    expect(c.calls).toHaveLength(0);
    expect(d.calls).toHaveLength(0);
    expect(a.calls[0]?.query).toBe('center a div');
    expect(out.results).toHaveLength(8);
    expect(out.results[0]).toMatchObject({ url: 'https://shared.example/page', foundBy: ['a', 'b'] });
    expect(out.results.some((r) => r.url.includes('junk.example'))).toBe(false);
    expect(out.stats).toMatchObject({ junk: 1, duplicates: 1 });
    expect(new Set(out.results.map((r) => r.url)).size).toBe(out.results.length);
    expect(trace.cache).toBe('miss');
  });

  it('falls back to the other engines when the first two fail', async () => {
    const a = engine('a', new HelperError('a', 'busy', 'slow down', 1200));
    const b = engine('b', new HelperError('b', 'timeout', 'no answer'));
    const c = engine('c', hits('c', 6));
    const d = engine('d', hits('d', 6));
    const out = await searchWeb({ query: 'q' }, new Trace(), deps([a, b, c, d]));
    expect(out.results).toHaveLength(8);
    expect(out.engines.map((e) => `${e.id}:${e.ok}`)).toEqual(['a:false', 'b:false', 'c:true', 'd:true']);
  });

  it('asks more engines when the first two found too little', async () => {
    const a = engine('a', hits('a', 1));
    const b = engine('b', []);
    const c = engine('c', hits('c', 6));
    const out = await searchWeb({ query: 'q' }, new Trace(), deps([a, b, c]));
    expect(c.calls).toHaveLength(1);
    expect(out.results.length).toBeGreaterThanOrEqual(5);
  });

  it('rests an engine that said "slow down" and does not ask it again', async () => {
    const a = engine('a', new HelperError('a', 'busy', 'slow down', 1200));
    const b = engine('b', hits('b', 8));
    const c = engine('c', hits('c', 8));
    const shared = deps([a, b, c]);
    await searchWeb({ query: 'first' }, new Trace(), shared);
    const trace = new Trace();
    await searchWeb({ query: 'second' }, trace, shared);
    expect(a.calls).toHaveLength(1);
    expect(trace.steps.find((s) => s.way === 'a search')?.note).toMatch(/resting, back in about 20 minutes/);
  });

  it('does not wait long for a slow engine once the other has answered', async () => {
    const fast = engine('fast', hits('f', 8));
    const slow = engine('slow', hits('s', 8), { delayMs: 8_000 });
    const started = Date.now();
    const out = await searchWeb({ query: 'q' }, new Trace(), deps([fast, slow]));
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(out.results).toHaveLength(8);
    expect(out.engines.find((e) => e.id === 'slow')?.note).toMatch(/not waited for/);
  });

  it('answers the same question from memory the second time', async () => {
    const a = engine('a', hits('a', 8));
    const b = engine('b', hits('b', 8));
    const shared = deps([a, b]);
    await searchWeb({ query: 'Same Question' }, new Trace(), shared);
    const trace = new Trace();
    const again = await searchWeb({ query: 'same question' }, trace, shared);
    expect(a.calls).toHaveLength(1);
    expect(again.cached).toBe(true);
    expect(trace.cache).toBe('hit');
    expect(trace.contacts).toHaveLength(0);
  });

  it('passes filters on, puts engines with their own site filter first, and applies the filter itself too', async () => {
    const noFilter = engine('nofilter', [...hits('x', 3), { url: 'https://react.dev/a', title: 'A', snippet: 's' }], { siteFilter: false });
    const withFilter = engine('withfilter', [{ url: 'https://react.dev/b', title: 'B', snippet: 's' }, { url: 'https://react.dev/c', title: 'C', snippet: 's' }]);
    const out = await searchWeb({ query: 'hooks', includeSites: ['https://www.react.dev/learn'], recency: 'year', count: 30 }, new Trace(), deps([noFilter, withFilter]));
    expect(withFilter.calls[0]).toMatchObject({ includeSites: ['react.dev'], recency: 'year', count: 20 });
    expect(out.engines[0]?.id).toBe('withfilter');
    expect(out.results.every((r) => r.url.startsWith('https://react.dev/'))).toBe(true);
    expect(out.results).toHaveLength(3);
  });

  it('gives a plain reason when every engine is busy', async () => {
    const a = engine('a', new HelperError('a', 'busy', 'limit reached', 600));
    const b = engine('b', new HelperError('b', 'busy', 'limit reached', 3_000));
    const err = await searchWeb({ query: 'q' }, new Trace(), deps([a, b])).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScrapyError);
    expect(err).toMatchObject({ reason: 'busy', retryAfterSec: 600 });
    expect((err as ScrapyError).message).toMatch(/^The free search services are busy\. Try again in about 10 minutes\./);
  });

  it('refuses an empty or far too long question', async () => {
    await expect(searchWeb({ query: '   ' }, new Trace(), deps([]))).rejects.toMatchObject({ reason: 'bad_input' });
    await expect(searchWeb({ query: 'x'.repeat(501) }, new Trace(), deps([]))).rejects.toMatchObject({ reason: 'bad_input' });
  });

  it('skips engines that are switched off', async () => {
    const a = engine('a', hits('a', 8));
    const b = engine('b', hits('b', 8));
    const c = engine('c', hits('c', 8));
    await searchWeb({ query: 'q' }, new Trace(), deps([a, b, c], { off: new Set(['a']) }));
    expect(a.calls).toHaveLength(0);
    expect(b.calls).toHaveLength(1);
    expect(c.calls).toHaveLength(1);
    await sleep(1);
  });
});

describe('formatSearch', () => {
  it('writes a list an agent can read', async () => {
    const shared = { url: 'https://shared.example/page', title: 'Shared page', snippet: 'Found by both engines.', published: '2026-03-02' };
    const a = engine('a', [shared, { url: 'https://junk.example/1', title: 'J', snippet: 'j' }]);
    const b = engine('b', [shared, { url: 'https://other.example/', title: 'Other page', snippet: 'Only one engine found this.' }]);
    const out = await searchWeb({ query: 'my question' }, new Trace(), deps([a, b]));
    const text = formatSearch(out);
    expect(text).toMatch(/^2 results for "my question" \(asked a and b, \d\.\d s\)/);
    expect(text).toContain('1. Shared page\n   https://shared.example/page\n   Found by both engines.\n   (published 2026-03-02, found by a and b)');
    expect(text).toContain('2. Other page\n   https://other.example/\n   Only one engine found this.');
    expect(text).toContain('Left out: 1 duplicate, 1 result from a copycat site.');
    expect(text).toContain('To read a result, call fetch_url with its link.');
  });

  it('says so when nothing was found', async () => {
    const out = await searchWeb({ query: 'zzz' }, new Trace(), deps([engine('a', []), engine('b', [])]));
    expect(formatSearch(out)).toMatch(/^No results for "zzz"/);
  });
});
