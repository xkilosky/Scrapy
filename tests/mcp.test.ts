/**
 * The whole of Scrapy in one test, with the network replaced by stand-ins.
 *
 * A real MCP client talks to Scrapy's real MCP address. Scrapy's helpers are
 * stand-ins that answer the way the real services document it. Exa and
 * Parallel are stood in for by real MCP servers, so Scrapy's MCP client code
 * runs for real.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from 'mcp-handler';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { POST } from '@/app/api/mcp/route';
import { runChecks } from '@/lib/check';
import { setFetch } from '@/lib/http';
import { HELPER_HOSTS } from '@/lib/providers';
import { runTool } from '@/lib/tools';

/** What each stand-in answers. Tests change this to simulate trouble. */
const world = {
  tavily: 'ok' as 'ok' | 'busy',
  exa: 'ok' as 'ok' | 'busy',
  firecrawl: 'ok' as 'ok' | 'busy',
  jina: 'ok' as 'ok' | 'needs_js' | 'busy',
};
const EXA_TEXT = [
  'Title: Fixing hydration errors (Exa)',
  'URL: https://exa-only.example/hydration',
  'Published: 2026-02-01T00:00:00.000Z',
  'Author: N/A',
  'Highlights:',
  'Exa found this page about hydration.',
  '',
  '---',
  '',
  'Title: Hydration docs',
  'URL: https://nextjs.org/docs/messages/react-hydration-error',
  'Published: N/A',
  'Author: N/A',
  'Highlights:',
  'The official explanation.',
].join('\n');

const exa = createMcpHandler((server) => {
  server.registerTool('web_search_exa', { description: 'search', inputSchema: z.object({ query: z.string(), numResults: z.number().optional() }) }, async () =>
    world.exa === 'busy'
      ? { content: [{ type: 'text' as const, text: "You've hit Exa's free MCP rate limit." }], isError: true, _meta: { 'ai.exa/rateLimited': true } }
      : { content: [{ type: 'text' as const, text: EXA_TEXT }] },
  );
  server.registerTool('web_fetch_exa', { description: 'fetch', inputSchema: z.object({ urls: z.array(z.string()), maxCharacters: z.number().optional() }) }, async ({ urls }) => ({
    content: [{ type: 'text' as const, text: `# Page from Exa\nURL: ${urls[0]}\n\n${'Exa read this page and returned its text. '.repeat(8)}` }],
  }));
});

const parallelCalls: Record<string, unknown>[] = [];
const parallel = createMcpHandler((server) => {
  server.registerTool(
    'web_search',
    { description: 'search', inputSchema: z.object({ objective: z.string(), search_queries: z.array(z.string()), session_id: z.string().optional() }).strict() },
    async (args) => {
      parallelCalls.push(args);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              session_id: 'sess_abcdef123456',
              results: [
                { url: 'https://parallel-only.example/guide', title: 'Hydration guide (Parallel)', publish_date: '2026-01-15', excerpts: ['Parallel found this guide.'] },
                { url: 'https://nextjs.org/docs/messages/react-hydration-error', title: 'Hydration docs', excerpts: ['The official explanation.'] },
              ],
            }),
          },
        ],
      };
    },
  );
});

const contacted: string[] = [];

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

beforeAll(() => {
  setFetch(async (input, init) => {
    const url = new URL(String(input));
    contacted.push(url.host);
    const path = `${url.host}${url.pathname}`;
    if (url.host === 'mcp.exa.ai') return exa(new Request(url, init));
    if (url.host === 'mcp.parallel.ai') return parallel(new Request(url, init));
    if (path === 'api.tavily.com/search') {
      if (world.tavily === 'busy') return json({ error: { code: 'keyless_rate_limit', message: 'Keyless limit reached', retry_after_seconds: 900 } }, 429);
      return json({
        results: [
          { title: 'Hydration docs', url: 'https://nextjs.org/docs/messages/react-hydration-error', content: 'Text content does not match server-rendered HTML.', score: 0.98 },
          { title: 'Copied answer', url: 'https://stackoom.com/en/question/123', content: 'A copy of a Stack Overflow answer.', score: 0.7 },
          { title: 'A question on Stack Overflow', url: 'https://stackoverflow.com/questions/1/hydration', content: 'Why do I get a hydration error?', score: 0.6 },
          { title: 'A blog post', url: 'https://blog.example/hydration', content: 'Five causes of hydration errors, each with the fix that worked for the author.', score: 0.5 },
          { title: 'A video', url: 'https://videos.example/watch/hydration', content: 'Hydration errors explained in ten minutes, with a demo project to follow along.', score: 0.4 },
        ],
      });
    }
    if (path === 'api.firecrawl.dev/v2/search') {
      if (world.firecrawl === 'busy') return json({ success: false, error: 'Rate limit exceeded' }, 429, { 'retry-after': '600' });
      return json({
        success: true,
        data: {
          web: [
            { url: 'https://react.dev/reference/react-dom/client/hydrateRoot', title: 'hydrateRoot', description: 'Reference for hydrateRoot.', position: 1 },
            { url: 'https://www.nextjs.org/docs/messages/react-hydration-error/?utm_source=x', title: 'Hydration error', description: 'Docs.', position: 2 },
            { url: 'https://github.com/vercel/next.js/discussions/35773', title: 'Discussion', description: 'People share their fixes.', position: 3 },
          ],
        },
      });
    }
    if (url.host === 'r.jina.ai') {
      if (world.jina === 'busy') return json({ data: null, code: 429, name: 'RateLimitTriggeredError', message: 'Too many requests' }, 429, { 'retry-after': '60' });
      if (world.jina === 'needs_js') return json({ code: 200, data: { title: 'App', url: 'https://example.com/', content: 'You need to enable JavaScript to run this app.' } });
      if (url.pathname.endsWith('/js/')) {
        const inBrowser = new Headers(init?.headers).get('x-engine') === 'browser';
        const quotes = '"The world as we have created it is a process of our thinking." by Albert Einstein. '.repeat(8);
        return json({ code: 200, data: { title: 'Quotes to Scrape', url: 'https://quotes.example/js/', content: inBrowser ? `Quotes to Scrape\n\n${quotes}` : 'Quotes to Scrape\n\nLogin\n\nQuotes by GoodReads. Made with love.' } });
      }
      return json({ code: 200, status: 20000, data: { title: 'Example Domain', url: 'https://example.com/', content: 'Example Domain\n==============\n\nThis domain is for use in documentation examples without needing permission. Avoid use in operations.\n\n[Learn more](https://iana.org/domains/example)' } });
    }
    if (path === 'api.firecrawl.dev/v2/scrape') {
      return json({ success: true, data: { markdown: `# Example Domain\n\n${'Firecrawl read this page in a real browser. '.repeat(6)}`, metadata: { title: 'Example Domain', statusCode: 200, url: 'https://example.com/' } } });
    }
    return new Response('not a helper', { status: 599 });
  });
});

afterAll(() => setFetch(null));

beforeEach(() => {
  world.tavily = 'ok';
  world.exa = 'ok';
  world.firecrawl = 'ok';
  world.jina = 'ok';
  contacted.length = 0;
});

async function connect(): Promise<Client> {
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('https://scrapy.test/api/mcp'), {
    fetch: (url, init) => POST(new Request(String(url), { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), 'x-real-ip': '203.0.113.9' } })),
  });
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const result = await client.callTool({ name, arguments: args });
  const blocks = result.content as { type: string; text?: string }[];
  return { text: blocks.map((b) => b.text ?? '').join('\n'), isError: result.isError === true };
}

describe("Scrapy's MCP address", () => {
  it('introduces itself and lists its tools', async () => {
    const client = await connect();
    expect(client.getServerVersion()).toMatchObject({ name: 'scrapy' });
    expect(client.getInstructions()).toMatch(/search_web/);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['search_web', 'fetch_url']);
    const search = tools.find((t) => t.name === 'search_web');
    expect(search?.inputSchema.required).toEqual(['query']);
    expect(Object.keys(search?.inputSchema.properties ?? {})).toEqual(['query', 'max_results', 'include_sites', 'exclude_sites', 'recency']);
    expect(search?.annotations?.readOnlyHint).toBe(true);
    await client.close();
  });

  it('search_web: two engines merged, the shared page first, no duplicates, no copycat site', async () => {
    const client = await connect();
    const { text, isError } = await call(client, 'search_web', { query: 'next.js hydration error fix' });
    expect(isError).toBe(false);
    expect(text).toMatch(/^5 results for "next\.js hydration error fix" \(asked tavily and exa, /);
    expect(text).toContain('1. Hydration docs\n   https://nextjs.org/docs/messages/react-hydration-error\n   Text content does not match server-rendered HTML.\n   (found by tavily and exa)');
    expect(text.match(/react-hydration-error/g)).toHaveLength(1);
    expect(text).not.toContain('stackoom');
    expect(text).toContain('https://stackoverflow.com/questions/1/hydration');
    expect(text).toContain('Left out: 1 duplicate, 1 result from a copycat site.');
    expect(text).toContain('https://exa-only.example/hydration');
    expect(text).toContain('published 2026-02-01');
    expect([...new Set(contacted)].sort()).toEqual(['api.tavily.com', 'mcp.exa.ai']);
    await client.close();
  });

  it('search_web: with the first two engines busy, the other two answer', async () => {
    world.tavily = 'busy';
    world.exa = 'busy';
    const client = await connect();
    const { text, isError } = await call(client, 'search_web', { query: 'hydration mismatch after upgrade to the newest version of the framework' });
    expect(isError).toBe(false);
    expect(text).toMatch(/\(asked parallel and firecrawl, /);
    expect(text).toContain('1. Hydration docs\n   https://nextjs.org/docs/messages/react-hydration-error');
    expect(text).toContain('found by parallel and firecrawl');
    expect(text).toContain('https://react.dev/reference/react-dom/client/hydrateRoot');
    expect(text).toContain('https://parallel-only.example/guide');
    expect(text).toContain('published 2026-01-15');
    // Parallel wants short keyword queries next to the full question.
    const sent = parallelCalls.at(-1) as { objective: string; search_queries: string[] };
    expect(sent.objective).toContain('hydration mismatch after upgrade');
    for (const q of sent.search_queries) expect(q.split(' ').length).toBeLessThanOrEqual(6);
    await client.close();
  });

  it('fetch_url: a page as clean Markdown, from the first helper', async () => {
    const client = await connect();
    const { text, isError } = await call(client, 'fetch_url', { url: 'https://example.com' });
    expect(isError).toBe(false);
    expect(text).toMatch(/^Title: Example Domain\nURL: https:\/\/example\.com\/\nLoaded: by Jina Reader in \d+\.\d s\n\n---\n\n# Example Domain\n\nThis domain is for use in documentation examples/);
    expect(text).not.toMatch(/<[a-z]+[\s>]|={3,}/);
    // A page this small is read once more in a real browser, to be sure nothing is missing.
    expect(contacted).toEqual(['r.jina.ai', 'r.jina.ai']);

    contacted.length = 0;
    const again = await call(client, 'fetch_url', { url: 'https://example.com' });
    expect(again.text).toContain("Loaded: from Scrapy's 15-minute memory");
    expect(contacted).toEqual([]);
    await client.close();
  });

  it('fetch_url: when the first helper only gets a "turn on JavaScript" page, the next one is used', async () => {
    world.jina = 'needs_js';
    const client = await connect();
    const { text, isError } = await call(client, 'fetch_url', { url: 'https://example.com/app' });
    expect(isError).toBe(false);
    expect(text).toContain('Loaded: by Firecrawl in');
    expect(text).toContain('Firecrawl read this page in a real browser.');
    await client.close();
  });

  it('fetch_url: a page that shows almost nothing without JavaScript comes back with its real content', async () => {
    const client = await connect();
    const { text, isError } = await call(client, 'fetch_url', { url: 'https://quotes.example/js/' });
    expect(isError).toBe(false);
    expect(text).toContain('Albert Einstein');
    expect(text).toContain('Note: The first reading had very little text, so the page was read again in a real browser.');
    await client.close();
  });

  it('refuses a private address with a plain sentence, and contacts nobody', async () => {
    const client = await connect();
    const { text, isError } = await call(client, 'fetch_url', { url: 'http://192.168.1.1/admin' });
    expect(isError).toBe(true);
    expect(text).toBe('Refused: "192.168.1.1" is a private or internal address. Scrapy only reads public web pages.');
    expect(contacted).toEqual([]);
    await client.close();
  });
});

describe('the safe position', () => {
  it('contacts only the free helpers, never the page itself', async () => {
    expect(process.env.SCRAPY_MODE).toBeUndefined();
    const search = await runTool('search_web', { query: 'a question nobody asked before' }, 'visitor-a');
    const page = await runTool('fetch_url', { url: 'https://example.com/another-page' }, 'visitor-a');
    expect(search.ok).toBe(true);
    expect(page.ok).toBe(true);
    const hosts = [...new Set([...search.trace.hosts, ...page.trace.hosts, ...contacted])];
    expect(hosts.length).toBeGreaterThan(0);
    for (const host of hosts) expect(HELPER_HOSTS, host).toContain(host);
    expect(hosts).not.toContain('example.com');
    expect(page.trace.contacts.every((c) => c.purpose !== 'own download')).toBe(true);
  });
});

describe('the checks behind "Run checks"', () => {
  it('report every helper, the speed, the fallback and the safe position', async () => {
    const report = await runChecks();
    expect(report.mode).toBe('safe');
    expect(report.helpers.map((h) => `${h.id}/${h.job}`)).toEqual([
      'tavily/search',
      'firecrawl/search',
      'exa/search',
      'parallel/search',
      'jina/page',
      'firecrawl/page',
      'tavily/page',
      'parallel/page',
      'exa/page',
    ]);
    const answers = (id: string, job: string): boolean => report.helpers.find((h) => h.id === id && h.job === job)?.answers === true;
    expect(answers('tavily', 'search')).toBe(true);
    expect(answers('exa', 'search')).toBe(true);
    expect(answers('parallel', 'search')).toBe(true);
    expect(answers('jina', 'page')).toBe(true);
    // The stand-in world has no Tavily page reader. The check must say so, not break.
    expect(answers('tavily', 'page')).toBe(false);

    expect(report.speed.map((s) => `${s.what}: ${s.ok}`)).toEqual([
      'search_web: true',
      'fetch_url, ordinary page: true',
      'fetch_url, same page again: true',
      'fetch_url, page that needs JavaScript: true',
    ]);
    expect(report.speed[0]?.note).toMatch(/results from tavily \+ exa/);
    expect(report.speed[3]?.note).toMatch(/content built by JavaScript is there/);

    expect(report.fallback).toHaveLength(2);
    expect(report.fallback[0]).toMatchObject({ what: 'search_web with tavily and exa switched off', ok: true });
    expect(report.fallback[0]?.note).toMatch(/results from parallel \+ firecrawl/);
    expect(report.fallback[1]).toMatchObject({ what: 'fetch_url with jina switched off', ok: true, note: 'loaded by Firecrawl' });

    expect(report.safe).toMatchObject({ applies: true, ok: true });
    for (const host of report.hosts) expect(HELPER_HOSTS, host).toContain(host);
  });
});
