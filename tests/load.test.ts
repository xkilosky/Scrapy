import { describe, expect, it } from 'vitest';
import { HelperError, ScrapyError } from '../lib/errors';
import { createHealth } from '../lib/health';
import { loadPage, type LoadDeps } from '../lib/page/load';
import type { PageQuery, PageWay, RawPage } from '../lib/providers/types';
import { createMemoryStore } from '../lib/store';
import { Trace } from '../lib/trace';
import { fetchUrl } from '../lib/tools/fetchUrl';

const BODY = 'This is a real paragraph with real content about the topic of the page. '.repeat(6);
const GOOD: RawPage = { title: 'Good page', markdown: `# Good page\n\n${BODY}`, finalUrl: 'https://site.example/page' };
const NEEDS_JS: RawPage = { title: 'App', markdown: 'You need to enable JavaScript to run this app.' };

interface Fake extends PageWay {
  calls: PageQuery[];
}

function way(id: string, answer: RawPage | HelperError, opts: { delayMs?: number; browser?: boolean; own?: boolean; formats?: ('markdown' | 'html')[] } = {}): Fake {
  const calls: PageQuery[] = [];
  return {
    id,
    name: `Way ${id}`,
    hosts: [`${id}.test`],
    formats: opts.formats ?? ['markdown', 'html'],
    browser: opts.browser ?? false,
    own: opts.own ?? false,
    calls,
    async load(query, _trace, call) {
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

function deps(helpers: PageWay[], extra: Partial<LoadDeps> = {}): Partial<LoadDeps> {
  const store = createMemoryStore();
  return {
    helpers,
    own: way('own', GOOD, { own: true }),
    store,
    health: createHealth(store),
    mode: 'safe',
    order: helpers.map((h) => h.id),
    off: new Set(),
    wayTimeoutMs: 2_000,
    hedgeAfterMs: 0,
    budgetMs: 5_000,
    ...extra,
  };
}

const failure = async (run: Promise<unknown>): Promise<ScrapyError> => {
  const err = await run.catch((e: unknown) => e);
  if (err instanceof ScrapyError) return err;
  throw new Error(`expected a ScrapyError, got ${String(err)}`);
};

describe('loadPage', () => {
  it('uses the first helper when it works', async () => {
    const a = way('a', GOOD);
    const b = way('b', GOOD);
    const { doc, cached } = await loadPage({ url: 'https://site.example/page' }, new Trace(), deps([a, b]));
    expect(doc).toMatchObject({ way: 'a', title: 'Good page', format: 'markdown', finalUrl: 'https://site.example/page' });
    expect(doc.content.startsWith('# Good page')).toBe(true);
    expect(cached).toBe(false);
    expect(b.calls).toHaveLength(0);
  });

  it('checks its own result: a "turn on JavaScript" page is not an answer, and a real-browser helper is tried next', async () => {
    const plain = way('plain', NEEDS_JS);
    const alsoPlain = way('alsoplain', GOOD);
    const browser = way('browser', GOOD, { browser: true });
    const trace = new Trace();
    const { doc } = await loadPage({ url: 'https://app.example/' }, trace, deps([plain, alsoPlain, browser]));
    expect(doc.way).toBe('browser');
    expect(alsoPlain.calls).toHaveLength(0);
    expect(trace.steps.map((s) => `${s.way}:${s.ok}`)).toEqual(['plain:false', 'browser:true']);
    expect(trace.steps[0]?.note).toMatch(/turn on JavaScript/);
  });

  it('falls back when a helper is busy, rests that helper, and remembers which way worked for the site', async () => {
    const a = way('a', new HelperError('a', 'busy', 'slow down', 900));
    const b = way('b', new HelperError('b', 'blocked', 'the site refused'));
    const c = way('c', GOOD);
    const shared = deps([a, b, c]);
    const first = await loadPage({ url: 'https://site.example/one' }, new Trace(), shared);
    expect(first.doc.way).toBe('c');

    const trace = new Trace();
    const second = await loadPage({ url: 'https://site.example/two' }, trace, shared);
    expect(second.doc.way).toBe('c');
    expect(a.calls).toHaveLength(1); // resting
    expect(b.calls).toHaveLength(1); // not tried again: "c" is remembered for this site
    expect(c.calls).toHaveLength(2);
    expect(trace.steps[0]).toMatchObject({ way: 'a', ok: false });
    expect(trace.steps[0]?.note).toMatch(/resting/);
  });

  it('remembers a page for 15 minutes', async () => {
    const a = way('a', GOOD);
    const shared = deps([a]);
    await loadPage({ url: 'https://site.example/page' }, new Trace(), shared);
    const trace = new Trace();
    const again = await loadPage({ url: 'https://site.example/page#top' }, trace, shared);
    expect(again.cached).toBe(true);
    expect(a.calls).toHaveLength(1);
    expect(trace.cache).toBe('hit');
    const fresh = await loadPage({ url: 'https://site.example/page', fresh: true }, new Trace(), shared);
    expect(fresh.cached).toBe(false);
    expect(a.calls).toHaveLength(2);
  });

  it('starts the next way alongside a slow one, and the first good answer wins', async () => {
    const slow = way('slow', GOOD, { delayMs: 3_000 });
    const fast = way('fast', GOOD, { delayMs: 50 });
    const started = Date.now();
    const trace = new Trace();
    const { doc } = await loadPage({ url: 'https://site.example/page' }, trace, deps([slow, fast], { hedgeAfterMs: 200 }));
    expect(doc.way).toBe('fast');
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(trace.steps.find((s) => s.way === 'slow')?.note).toMatch(/another way answered first/);
  });

  it('stops at once when a page does not exist, and remembers that for a while', async () => {
    const a = way('a', new HelperError('a', 'not_found', 'the page does not exist (the site answered 404)'));
    const b = way('b', GOOD);
    const shared = deps([a, b]);
    const err = await failure(loadPage({ url: 'https://site.example/missing' }, new Trace(), shared));
    expect(err.reason).toBe('not_found');
    expect(err.message).toMatch(/^Not found: this page does not exist\./);
    expect(b.calls).toHaveLength(0);
    await failure(loadPage({ url: 'https://site.example/missing' }, new Trace(), shared));
    expect(a.calls).toHaveLength(1);
  });

  it('reports a login wall after one second opinion, and does not try to get around it', async () => {
    const wall: RawPage = { title: 'Log in', markdown: 'Log in to continue. Email address. Password. Forgot your password?' };
    const a = way('a', wall);
    const b = way('b', wall);
    const c = way('c', GOOD);
    const err = await failure(loadPage({ url: 'https://site.example/private' }, new Trace(), deps([a, b, c])));
    expect(err.reason).toBe('login');
    expect(err.message).toMatch(/^Needs a login/);
    expect(c.calls).toHaveLength(0);
  });

  it('gives plain reasons: busy, blocked, empty, too slow', async () => {
    const busy = await failure(loadPage({ url: 'https://s.example/' }, new Trace(), deps([way('a', new HelperError('a', 'busy', 'limit', 600)), way('b', new HelperError('b', 'busy', 'limit', 1_800))])));
    expect(busy).toMatchObject({ reason: 'busy', retryAfterSec: 600 });
    expect(busy.message).toMatch(/^The free services that load pages are busy\. Try again in about 10 minutes\./);

    const blocked = await failure(loadPage({ url: 'https://s.example/' }, new Trace(), deps([way('a', { title: 'Just a moment...', markdown: 'Verifying you are human. This may take a few seconds.' })])));
    expect(blocked.reason).toBe('blocked');
    expect(blocked.message).toMatch(/^Blocked by the site/);

    const empty = await failure(loadPage({ url: 'https://s.example/' }, new Trace(), deps([way('a', { markdown: '' }), way('b', NEEDS_JS)])));
    expect(empty.reason).toBe('empty');
    expect(empty.message).toMatch(/Try again with browser set to true/);

    const slow = await failure(loadPage({ url: 'https://s.example/' }, new Trace(), deps([way('a', GOOD, { delayMs: 3_000 })], { budgetMs: 300 })));
    expect(slow.reason).toBe('too_slow');
  });

  it('refuses a private address before contacting anyone', async () => {
    const a = way('a', GOOD);
    const err = await failure(loadPage({ url: 'http://169.254.169.254/latest/meta-data/' }, new Trace(), deps([a])));
    expect(err.reason).toBe('private_address');
    expect(a.calls).toHaveLength(0);
  });

  it('asks for HTML only from helpers that can give it, and returns tidy HTML', async () => {
    const markdownOnly = way('mdonly', GOOD, { formats: ['markdown'] });
    const html = way('html', { title: 'Page', rawHtml: `<html><body><nav><a href="/">Home</a></nav><main><h1>Page</h1><p class="x">${BODY}</p><script>bad()</script></main></body></html>` });
    const { doc } = await loadPage({ url: 'https://site.example/p', format: 'html' }, new Trace(), deps([markdownOnly, html]));
    expect(markdownOnly.calls).toHaveLength(0);
    expect(doc.format).toBe('html');
    expect(doc.content).toMatch(/^<h1>Page<\/h1>\n<p>This is a real paragraph/);
    expect(doc.content).not.toMatch(/script|class=|Home/);
  });

  it('puts real-browser helpers first when the caller asks for a real browser', async () => {
    const plain = way('plain', GOOD);
    const browser = way('browser', GOOD, { browser: true });
    const { doc } = await loadPage({ url: 'https://site.example/p', browser: true }, new Trace(), deps([plain, browser]));
    expect(doc.way).toBe('browser');
    expect(browser.calls[0]?.browser).toBe(true);
    expect(plain.calls).toHaveLength(0);
  });
});

describe('the three positions', () => {
  it('safe: never uses its own download, even when every helper fails', async () => {
    const own = way('own', GOOD, { own: true });
    const a = way('a', new HelperError('a', 'busy', 'limit', 600));
    const trace = new Trace();
    const err = await failure(loadPage({ url: 'https://site.example/p' }, trace, deps([a], { own, mode: 'safe' })));
    expect(err.reason).toBe('busy');
    expect(own.calls).toHaveLength(0);
    expect(trace.steps.some((s) => s.way === 'own')).toBe(false);
  });

  it('middle: helpers first, own download when they are busy', async () => {
    const own = way('own', GOOD, { own: true });
    const a = way('a', new HelperError('a', 'busy', 'limit', 600));
    const { doc } = await loadPage({ url: 'https://site.example/p' }, new Trace(), deps([a], { own, mode: 'middle' }));
    expect(doc.way).toBe('own');
    expect(a.calls).toHaveLength(1);
  });

  it('full speed: own download first, helpers when the page needs a browser', async () => {
    const own = way('own', GOOD, { own: true });
    const a = way('a', GOOD, { browser: true });
    const first = await loadPage({ url: 'https://site.example/p' }, new Trace(), deps([a], { own, mode: 'full' }));
    expect(first.doc.way).toBe('own');
    expect(a.calls).toHaveLength(0);

    const ownJs = way('own', NEEDS_JS, { own: true });
    const second = await loadPage({ url: 'https://app.example/' }, new Trace(), deps([a], { own: ownJs, mode: 'full' }));
    expect(second.doc.way).toBe('a');
  });
});

describe('fetch_url', () => {
  const section = (n: number): string => `## Section ${n}\n\n${`Sentence about topic number ${n} with details. `.repeat(60)}\n\n`;
  const longBody = `# Long guide\n\n${Array.from({ length: 30 }, (_, i) => section(i + 1)).join('')}## Rate limits\n\nEach key may send 100 requests per minute.`;
  const long: RawPage = { title: 'Long guide', markdown: longBody, finalUrl: 'https://docs.example/guide' };

  it('returns a header and the content', async () => {
    const text = await fetchUrl({ url: 'https://site.example/page' }, new Trace(), deps([way('a', GOOD)]));
    expect(text).toMatch(/^Title: Good page\nURL: https:\/\/site\.example\/page\nLoaded: by Way a in \d+\.\d s\n\n---\n\n# Good page\n\nThis is a real paragraph/);
    expect(text).not.toContain('Part:');
  });

  it('returns a long page in parts that join up into the full text', async () => {
    const shared = deps([way('a', long)]);
    const first = await fetchUrl({ url: 'https://docs.example/guide' }, new Trace(), shared);
    const total = Number(/Part: 1 of (\d+) \(call fetch_url again with part: 2 for the next part\)/.exec(first)?.[1]);
    expect(total).toBeGreaterThan(2);

    const bodies: string[] = [];
    for (let part = 1; part <= total; part++) {
      const text = await fetchUrl({ url: 'https://docs.example/guide', part }, new Trace(), shared);
      expect(text).toContain(`Part: ${part} of ${total}`);
      if (part > 1) expect(text).toContain("Loaded: from Scrapy's 15-minute memory");
      bodies.push(text.slice(text.indexOf('\n\n---\n\n') + 7));
    }
    // The parts, joined, are exactly the whole page: nothing missing, nothing repeated.
    const whole = (await loadPage({ url: 'https://docs.example/guide' }, new Trace(), shared)).doc.content;
    expect(bodies.join('') === whole).toBe(true);
    expect(whole).toContain('## Section 30');
    expect(whole.endsWith('Each key may send 100 requests per minute.')).toBe(true);
    for (const body of bodies) expect(body.length).toBeLessThanOrEqual(23_001);

    await expect(fetchUrl({ url: 'https://docs.example/guide', part: total + 1 }, new Trace(), shared)).rejects.toMatchObject({ reason: 'bad_input' });
  });

  it('with a focus, returns only the matching sections', async () => {
    const text = await fetchUrl({ url: 'https://docs.example/guide', focus: 'rate limits' }, new Trace(), deps([way('a', long)]));
    expect(text).toMatch(/Focus: "rate limits" \(1 of 32 sections kept/);
    expect(text).toContain('Each key may send 100 requests per minute.');
    expect(text).not.toContain('Section 7');
    expect(text.length).toBeLessThan(600);
  });
});
