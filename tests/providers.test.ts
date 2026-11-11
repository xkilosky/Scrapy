import { afterEach, describe, expect, it } from 'vitest';
import { HelperError } from '../lib/errors';
import { setFetch } from '../lib/http';
import { parseExaPage, parseExaSearch } from '../lib/providers/exa';
import { firecrawlPage, firecrawlSearch } from '../lib/providers/firecrawl';
import { jinaPage } from '../lib/providers/jina';
import { parseParallelPage, parseParallelSearch } from '../lib/providers/parallel';
import { keywordQueries } from '../lib/providers/shared';
import { tavilyPage, tavilySearch } from '../lib/providers/tavily';
import { Trace } from '../lib/trace';

interface Seen {
  url: string;
  method: string;
  headers: Headers;
  body: Record<string, unknown> | null;
}

/** Replaces the network with one fixed answer, and records what was sent. */
function answerWith(status: number, body: unknown, headers: Record<string, string> = {}): Seen[] {
  const seen: Seen[] = [];
  setFetch(async (input, init) => {
    seen.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  });
  return seen;
}

const opts = { timeoutMs: 5_000 };
const query = { query: 'next.js hydration error', count: 10, includeSites: [], excludeSites: [] };
const failure = async (run: Promise<unknown>): Promise<HelperError> => {
  try {
    await run;
  } catch (err) {
    if (err instanceof HelperError) return err;
    throw err;
  }
  throw new Error('expected a failure');
};

afterEach(() => setFetch(null));

describe('Tavily', () => {
  it('uses the no-key door: the access header, and no key of any kind', async () => {
    const seen = answerWith(200, { query: 'q', results: [{ title: 'Hydration', url: 'https://nextjs.org/docs/h', content: 'About hydration.', score: 0.9, published_date: '2026-01-05' }] });
    const trace = new Trace();
    const hits = await tavilySearch.search({ ...query, includeSites: ['nextjs.org'], recency: 'month' }, trace, opts);
    expect(hits).toEqual([{ url: 'https://nextjs.org/docs/h', title: 'Hydration', snippet: 'About hydration.', published: '2026-01-05' }]);
    const sent = seen[0];
    expect(sent?.url).toBe('https://api.tavily.com/search');
    expect(sent?.headers.get('x-tavily-access-mode')).toBe('keyless');
    expect(sent?.headers.get('authorization')).toBeNull();
    expect(sent?.headers.get('user-agent')).toMatch(/^Scrapy\//);
    expect(sent?.body).toMatchObject({ query: 'next.js hydration error', max_results: 10, include_domains: ['nextjs.org'], time_range: 'month' });
    expect(trace.contacts).toMatchObject([{ host: 'api.tavily.com', status: 200, purpose: 'tavily search' }]);
  });

  it('understands "slow down" from the no-key door, with the wait it asks for', async () => {
    answerWith(429, { error: { code: 'keyless_hourly_limit', message: 'Hourly keyless limit reached.', retry_after_seconds: 1800, next_actions: [] } });
    const err = await failure(tavilySearch.search(query, new Trace(), opts));
    expect(err).toMatchObject({ helper: 'tavily', kind: 'busy', retryAfterSec: 1800 });
  });

  it('reads a page, and reports a page that could not be read', async () => {
    answerWith(200, { results: [{ url: 'https://example.com/', title: 'Example Domain', raw_content: '# Example Domain\n\nText.' }], failed_results: [] });
    expect(await tavilyPage.load({ url: 'https://example.com/', format: 'markdown', browser: false }, new Trace(), opts)).toEqual({
      markdown: '# Example Domain\n\nText.',
      finalUrl: 'https://example.com/',
      title: 'Example Domain',
    });
    answerWith(200, { results: [], failed_results: [{ url: 'https://example.com/x', error: 'Page not found (404)' }] });
    expect(await failure(tavilyPage.load({ url: 'https://example.com/x', format: 'markdown', browser: false }, new Trace(), opts))).toMatchObject({ kind: 'not_found' });
  });

  it('reports a refusal and an unreadable answer', async () => {
    answerWith(401, { detail: { error: 'Unauthorized: missing or invalid API key.' } });
    expect(await failure(tavilySearch.search(query, new Trace(), opts))).toMatchObject({ kind: 'refused' });
    answerWith(200, '<html>gateway error</html>');
    expect(await failure(tavilySearch.search(query, new Trace(), opts))).toMatchObject({ kind: 'bad_response' });
  });
});

describe('Firecrawl', () => {
  it('searches with no key and reads the result list', async () => {
    const seen = answerWith(200, { success: true, data: { web: [{ url: 'https://react.dev/a', title: 'A', description: 'About A', position: 1 }, { url: 'https://react.dev/b', title: 'B', description: 'About B', position: 2 }] } });
    const hits = await firecrawlSearch.search({ ...query, recency: 'week' }, new Trace(), opts);
    expect(hits.map((h) => h.url)).toEqual(['https://react.dev/a', 'https://react.dev/b']);
    expect(seen[0]?.url).toBe('https://api.firecrawl.dev/v2/search');
    expect(seen[0]?.headers.get('authorization')).toBeNull();
    expect(seen[0]?.body).toMatchObject({ query: 'next.js hydration error', limit: 10, tbs: 'qdr:w' });
  });

  it('asks for the main content only, without ads, and passes "use a real browser" on', async () => {
    const seen = answerWith(200, { success: true, data: { markdown: '# Example Domain\n\nText.', metadata: { title: 'Example Domain', statusCode: 200, url: 'https://example.com/', language: 'en' } } });
    const page = await firecrawlPage.load({ url: 'https://example.com/', format: 'markdown', browser: true }, new Trace(), opts);
    expect(page).toMatchObject({ markdown: '# Example Domain\n\nText.', title: 'Example Domain', finalUrl: 'https://example.com/', status: 200, language: 'en' });
    expect(seen[0]?.body).toMatchObject({ url: 'https://example.com/', formats: ['markdown'], onlyMainContent: true, blockAds: true, waitFor: 3000 });
  });

  it('reports the allowance being used up, with the wait', async () => {
    answerWith(429, { success: false, error: 'Rate limit exceeded.' }, { 'retry-after': '3600' });
    expect(await failure(firecrawlSearch.search(query, new Trace(), opts))).toMatchObject({ kind: 'busy', retryAfterSec: 3600 });
    answerWith(402, { success: false, error: 'Insufficient credits.' });
    expect(await failure(firecrawlPage.load({ url: 'https://example.com/', format: 'markdown', browser: false }, new Trace(), opts))).toMatchObject({ kind: 'busy' });
  });

  it('reports what the page itself answered', async () => {
    answerWith(200, { success: true, data: { markdown: '# Not Found', metadata: { statusCode: 404 } } });
    expect(await failure(firecrawlPage.load({ url: 'https://example.com/nope', format: 'markdown', browser: false }, new Trace(), opts))).toMatchObject({ kind: 'not_found' });
    answerWith(200, { success: true, data: { markdown: 'Forbidden', metadata: { statusCode: 403 } } });
    expect(await failure(firecrawlPage.load({ url: 'https://example.com/x', format: 'markdown', browser: false }, new Trace(), opts))).toMatchObject({ kind: 'blocked' });
  });
});

describe('Jina Reader', () => {
  it('puts the link behind r.jina.ai and reads the answer', async () => {
    const seen = answerWith(200, { code: 200, status: 20000, data: { title: 'Example Domain', description: '', url: 'https://example.com/', content: 'This domain is for use in documentation examples.' } });
    const page = await jinaPage.load({ url: 'https://example.com/path?x=1', format: 'markdown', browser: false }, new Trace(), opts);
    expect(page).toEqual({ finalUrl: 'https://example.com/', title: 'Example Domain', markdown: 'This domain is for use in documentation examples.' });
    expect(seen[0]?.url).toBe('https://r.jina.ai/https://example.com/path?x=1');
    expect(seen[0]?.method).toBe('GET');
    expect(seen[0]?.headers.get('accept')).toBe('application/json');
    expect(seen[0]?.headers.get('authorization')).toBeNull();
    expect(seen[0]?.headers.get('x-engine')).toBeNull();
  });

  it('asks for a real browser and for HTML when told to', async () => {
    const seen = answerWith(200, { code: 200, data: { title: 'T', url: 'https://example.com/', html: '<html><body><p>Hi</p></body></html>' } });
    const page = await jinaPage.load({ url: 'https://example.com/', format: 'html', browser: true }, new Trace(), opts);
    expect(page.rawHtml).toContain('<p>Hi</p>');
    expect(seen[0]?.headers.get('x-engine')).toBe('browser');
    expect(seen[0]?.headers.get('x-respond-with')).toBe('html');
  });

  it('reports a missing page, "slow down" and a blocked site', async () => {
    answerWith(200, { code: 200, data: { title: 'Not Found', url: 'https://example.com/nope', content: 'Not Found', warning: 'Target URL returned error 404: Not Found' } });
    expect(await failure(jinaPage.load({ url: 'https://example.com/nope', format: 'markdown', browser: false }, new Trace(), opts))).toMatchObject({ kind: 'not_found' });
    answerWith(429, { data: null, code: 429, name: 'RateLimitTriggeredError', message: 'Per IP rate limit exceeded', readableMessage: 'Too many requests' }, { 'retry-after': '30' });
    expect(await failure(jinaPage.load({ url: 'https://example.com/', format: 'markdown', browser: false }, new Trace(), opts))).toMatchObject({ kind: 'busy', retryAfterSec: 30 });
    answerWith(451, { data: null, code: 451, name: 'SecurityCompromiseError', message: 'Domain blocked', readableMessage: 'Domain x.example blocked until tomorrow' });
    expect(await failure(jinaPage.load({ url: 'https://x.example/', format: 'markdown', browser: false }, new Trace(), opts))).toMatchObject({ kind: 'blocked' });
  });
});

describe('Exa answers', () => {
  const text = [
    'Title: Text content does not match server-rendered HTML',
    'URL: https://nextjs.org/docs/messages/react-hydration-error',
    'Published: 2025-06-01T00:00:00.000Z',
    'Author: N/A',
    'Highlights:',
    'While rendering your application, there was a difference between the React tree.',
    'A second highlight.',
    '',
    '---',
    '',
    'Title: N/A',
    'URL: https://react.dev/reference/react-dom/client/hydrateRoot',
    'Published: N/A',
    'Author: N/A',
    'Text: hydrateRoot lets you display React components inside a browser DOM node.',
  ].join('\n');

  it('reads the list of results', () => {
    expect(parseExaSearch(`Note: results were widened.\n\n${text}`)).toEqual([
      {
        url: 'https://nextjs.org/docs/messages/react-hydration-error',
        title: 'Text content does not match server-rendered HTML',
        snippet: 'While rendering your application, there was a difference between the React tree.\nA second highlight.',
        published: '2025-06-01T00:00:00.000Z',
      },
      { url: 'https://react.dev/reference/react-dom/client/hydrateRoot', title: '', snippet: 'hydrateRoot lets you display React components inside a browser DOM node.' },
    ]);
    expect(parseExaSearch('No search results found. Please try a different query.')).toEqual([]);
  });

  it('reads a page and its errors', () => {
    expect(parseExaPage('# Example Domain\nURL: https://example.com/\nPublished: 2020-01-01\n\nThis domain is for use in examples.\n\nMore text.')).toEqual({
      markdown: 'This domain is for use in examples.\n\nMore text.',
      finalUrl: 'https://example.com/',
      title: 'Example Domain',
    });
    expect(() => parseExaPage('Error fetching URL(s): https://example.com/nope: CRAWL_NOT_FOUND')).toThrowError(/does not exist/);
    expect(() => parseExaPage('No content found for the provided URL(s).')).toThrowError(/empty/);
  });
});

describe('Parallel answers', () => {
  const answer = (text: string, structured?: unknown) => ({ text, structured, isError: false, meta: {} });

  it('reads results from JSON, from structured data and from plain text', () => {
    const json = { search_id: 's1', session_id: 'sess_12345678', results: [{ url: 'https://a.example/', title: 'A', publish_date: '2026-02-01', excerpts: ['First part.', 'Second part.'] }] };
    const expected = [{ url: 'https://a.example/', title: 'A', snippet: 'First part. … Second part.', published: '2026-02-01' }];
    expect(parseParallelSearch(answer(JSON.stringify(json)))).toEqual(expected);
    expect(parseParallelSearch(answer('', json))).toEqual(expected);
    expect(parseParallelSearch(answer('Here are the results:\n' + JSON.stringify(json)))).toEqual(expected);

    const plain = '## A page about flexbox\nhttps://css.example/flexbox\nCentering with flexbox takes two lines.\n\n## [Grid guide](https://css.example/grid)\nGrid is for two dimensions.';
    expect(parseParallelSearch(answer(plain))).toEqual([
      { url: 'https://css.example/flexbox', title: 'A page about flexbox', snippet: 'Centering with flexbox takes two lines.' },
      { url: 'https://css.example/grid', title: 'Grid guide', snippet: 'Grid is for two dimensions.' },
    ]);
  });

  it('reads a page, and a page error', () => {
    expect(parseParallelPage(answer(JSON.stringify({ results: [{ url: 'https://example.com/', title: 'Example Domain', full_content: '# Example Domain\n\nText.' }], errors: [] })))).toEqual({
      markdown: '# Example Domain\n\nText.',
      finalUrl: 'https://example.com/',
      title: 'Example Domain',
    });
    expect(() => parseParallelPage(answer(JSON.stringify({ results: [], errors: [{ url: 'https://example.com/x', error_type: 'fetch_error', http_status_code: 404 }] })))).toThrowError(/does not exist/);
    expect(parseParallelPage(answer('# Plain Markdown\n\nNo JSON here.'))).toEqual({ markdown: '# Plain Markdown\n\nNo JSON here.' });
  });
});

describe('keywordQueries', () => {
  it('keeps a short question and shortens a long one', () => {
    expect(keywordQueries('react hooks')).toEqual(['react hooks']);
    const long = keywordQueries('how do I fix the hydration error that appears in my next.js app after the upgrade');
    expect(long.length).toBeLessThanOrEqual(2);
    for (const q of long) expect(q.split(' ').length).toBeLessThanOrEqual(6);
    expect(long[0]).toBe('fix hydration error appears next.js app');
  });
});
