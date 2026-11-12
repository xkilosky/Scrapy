/**
 * The docs say what the tools do. These tests hold the two together: the
 * examples must be accepted, the sample answers must be what a tool really
 * writes, the list of failures must match the sentences in the code, and the
 * numbers must be the ones Scrapy runs on.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { docsPayload, facts, failureDocs, originOf, rulebook, toolDocs } from '@/lib/docs';
import { FAILURES, type Reason } from '@/lib/errors';
import { createHealth } from '@/lib/health';
import { createLimiter } from '@/lib/limits';
import { createLogBook } from '@/lib/logs';
import type { LoadDeps } from '@/lib/page/load';
import type { PageWay, RawHit, SearchEngine } from '@/lib/providers/types';
import { searchWeb } from '@/lib/search';
import { createMemoryStore } from '@/lib/store';
import { checkedInput, runTool, SERVER_INSTRUCTIONS, TOOLS, type ToolDef } from '@/lib/tools';
import { jsonSchemaOf, paramsOf } from '@/lib/tools/describe';
import { fetchUrl } from '@/lib/tools/fetchUrl';
import { formatSearch } from '@/lib/tools/searchWeb';
import { Trace } from '@/lib/trace';

const SETTINGS = ['SCRAPY_VISITOR_PER_MINUTE', 'SCRAPY_DAILY_CALLS', 'SCRAPY_OFF', 'SCRAPY_SEARCH_ORDER', 'SCRAPY_PAGE_ORDER', 'SCRAPY_MODE', 'SCRAPY_LOGS', 'VERCEL', 'VERCEL_ENV'];

afterEach(() => {
  for (const name of SETTINGS) delete process.env[name];
});

const tool = (name: string): ToolDef => {
  const found = TOOLS.find((t) => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
};
const search = tool('search_web');
const page = tool('fetch_url');

/** The sentence a tool answers with to these arguments. Empty when it accepts them. */
function refusal(t: ToolDef, args: unknown): string {
  try {
    checkedInput(t, args);
    return '';
  } catch (err) {
    return (err as Error).message;
  }
}

describe('what an agent is told about each tool', () => {
  it('lists every parameter with its type, its limits and its default', () => {
    expect(paramsOf(search.schema).map(({ about: _about, ...rest }) => rest)).toEqual([
      { name: 'query', type: 'string', required: true, limits: '1 to 500 characters' },
      { name: 'max_results', type: 'integer', required: false, default: '8', limits: '1 to 20' },
      { name: 'include_sites', type: 'array of strings', required: false, limits: 'at most 10 items' },
      { name: 'exclude_sites', type: 'array of strings', required: false, limits: 'at most 10 items' },
      { name: 'recency', type: 'one of "day", "week", "month", "year"', required: false, limits: '' },
    ]);
    expect(paramsOf(page.schema).map(({ about: _about, ...rest }) => rest)).toEqual([
      { name: 'url', type: 'string', required: true, limits: '1 to 2,000 characters' },
      { name: 'format', type: 'one of "markdown", "html"', required: false, default: '"markdown"', limits: '' },
      { name: 'focus', type: 'string', required: false, limits: 'at most 200 characters' },
      { name: 'part', type: 'integer', required: false, default: '1', limits: '1 or more' },
      { name: 'browser', type: 'boolean', required: false, default: 'false', limits: '' },
    ]);
  });

  it('describes every parameter in words', () => {
    for (const t of TOOLS) {
      for (const p of paramsOf(t.schema)) expect(p.about.length, `${t.name}.${p.name}`).toBeGreaterThan(20);
    }
  });

  it('hands over a schema that allows nothing else, and carries no meaningless limit', () => {
    for (const t of TOOLS) {
      const schema = jsonSchemaOf(t.schema);
      expect(schema.type).toBe('object');
      expect(schema.additionalProperties).toBe(false);
      expect(JSON.stringify(schema)).not.toContain(String(Number.MAX_SAFE_INTEGER));
    }
    expect((jsonSchemaOf(page.schema).properties as Record<string, unknown>).part).toMatchObject({ type: 'integer', minimum: 1, default: 1 });
  });

  it('gives examples that are accepted exactly as written', () => {
    for (const t of TOOLS) {
      expect(t.examples.length, t.name).toBeGreaterThanOrEqual(3);
      for (const example of t.examples) {
        // Accepted, and nothing had to be put right: the examples show the proper form.
        expect(checkedInput(t, example.args), `${t.name}: ${example.about}`).toEqual(example.args);
      }
    }
  });

  it('uses every parameter in at least one example', () => {
    for (const t of TOOLS) {
      const used = new Set(t.examples.flatMap((example) => Object.keys(example.args)));
      expect([...used].sort(), t.name).toEqual(Object.keys(t.schema.shape).sort());
    }
  });

  it('shows the sentence Scrapy really answers to a guess', () => {
    for (const doc of toolDocs()) {
      const t = tool(doc.name);
      expect(doc.wrongInput.args).toEqual(t.mistake);
      expect(doc.wrongInput.answer).toBe(refusal(t, t.mistake));
      expect(doc.wrongInput.answer).toMatch(new RegExp(`^The input for ${doc.name} is not right\\. It has no parameter `));
    }
    expect(toolDocs()[0]?.wrongInput.answer).toBe(
      'The input for search_web is not right. It has no parameter "q" or "limit". Parameters of search_web: query (string, required, 1 to 500 characters); max_results (integer, 1 to 20, default 8); ' +
        'include_sites (array of strings, at most 10 items); exclude_sites (array of strings, at most 10 items); recency (one of "day", "week", "month", "year").',
    );
  });
});

describe('the check of what an agent sent', () => {
  it('refuses a parameter the tool does not have, and names the ones it has', () => {
    expect(refusal(page, { url: 'https://a.example', timeout: 5 })).toBe(
      'The input for fetch_url is not right. It has no parameter "timeout". Parameters of fetch_url: url (string, required, 1 to 2,000 characters); format (one of "markdown", "html", default "markdown"); ' +
        'focus (string, at most 200 characters); part (integer, 1 or more, default 1); browser (boolean, default false).',
    );
    // Names every object has by birth are not parameters either.
    expect(refusal(search, { query: 'x', toString: 'a' })).toContain('It has no parameter "toString".');
    expect(refusal(search, { query: 'x', constructor: 'a' })).toContain('It has no parameter "constructor".');
  });

  it('says what is wrong with a value, and what it must be', () => {
    const what = (t: ToolDef, args: unknown): string => refusal(t, args).split(` Parameters of ${t.name}: `)[0] ?? '';
    expect(what(search, {})).toBe('The input for search_web is not right. "query" is missing. It is required.');
    expect(what(search, { query: '' })).toBe('The input for search_web is not right. "query" is empty. It is required.');
    expect(what(search, { query: 'x', max_results: 500 })).toBe('The input for search_web is not right. "max_results" is 500. It must be: integer, 1 to 20.');
    expect(what(search, { query: 'x', max_results: 2.5 })).toBe('The input for search_web is not right. "max_results" is 2.5. It must be: integer, 1 to 20.');
    expect(what(search, { query: 'x', max_results: 'five' })).toBe('The input for search_web is not right. "max_results" is "five". It must be: integer, 1 to 20.');
    expect(what(search, { query: 'x', recency: 'decade' })).toBe('The input for search_web is not right. "recency" is "decade". It must be: one of "day", "week", "month", "year".');
    expect(what(search, { query: 'x', include_sites: [1, 2] })).toBe('The input for search_web is not right. "include_sites" is [1,2]. It must be: array of strings, at most 10 items.');
    expect(what(search, { query: ['x'] })).toBe('The input for search_web is not right. "query" is ["x"]. It must be: string, 1 to 500 characters.');
    expect(what(page, { url: 'https://a.example', part: 0 })).toBe('The input for fetch_url is not right. "part" is 0. It must be: integer, 1 or more.');
    expect(what(page, { url: 'https://a.example', browser: 'yes' })).toBe('The input for fetch_url is not right. "browser" is "yes". It must be: boolean.');
    expect(what(page, { url: 'https://a.example', format: 'text' })).toBe('The input for fetch_url is not right. "format" is "text". It must be: one of "markdown", "html".');
    // Several things wrong: one sentence each, the missing one first.
    expect(what(search, { max_results: 500, recency: 'decade' })).toBe(
      'The input for search_web is not right. "query" is missing. It is required. "max_results" is 500. It must be: integer, 1 to 20. "recency" is "decade". It must be: one of "day", "week", "month", "year".',
    );
  });

  it('does not repeat a long value back', () => {
    const long = refusal(search, { query: 'a'.repeat(600) });
    expect(long).toContain(`"query" is "${'a'.repeat(40)}..." (600 characters). It must be: string, 1 to 500 characters.`);
    const many = refusal(search, { query: 'x', include_sites: Array.from({ length: 12 }, (_, i) => `site${i}.example`) });
    expect(many).toContain('"include_sites" is a list of 12 items. It must be: array of strings, at most 10 items.');
  });

  it('wants one JSON object', () => {
    for (const wrong of ['next.js', ['next.js'], 5, true]) {
      expect(refusal(search, wrong)).toMatch(/^The input for search_web is not right\. The arguments must be one JSON object, for example \{"query":"next\.js hydration error fix"\}\. Parameters of search_web: /);
    }
    // Nothing at all is an empty object: the sentence then names what is missing.
    for (const nothing of [undefined, null]) expect(refusal(search, nothing)).toContain('"query" is missing.');
  });

  it('counts null, and an empty text for a parameter that need not be given, as left out', () => {
    expect(checkedInput(page, { url: 'https://a.example', format: null, focus: null, part: null, browser: null })).toEqual({ url: 'https://a.example' });
    expect(checkedInput(page, { url: 'https://a.example', format: '', focus: ' ', part: '', browser: '' })).toEqual({ url: 'https://a.example' });
    expect(checkedInput(search, { query: 'x', max_results: undefined, include_sites: '', recency: '' })).toEqual({ query: 'x' });
  });

  it('puts right a value whose form is wrong but can mean one thing only', () => {
    // A number or true/false written as text.
    expect(checkedInput(search, { query: 'x', max_results: '5' })).toEqual({ query: 'x', max_results: 5 });
    expect(checkedInput(page, { url: 'https://a.example', part: ' 2 ', browser: 'true' })).toEqual({ url: 'https://a.example', part: 2, browser: true });
    expect(checkedInput(page, { url: 'https://a.example', browser: 'FALSE' })).toEqual({ url: 'https://a.example', browser: false });
    // One item where a list is expected, and a list written as text.
    expect(checkedInput(search, { query: 'x', include_sites: 'react.dev' })).toEqual({ query: 'x', include_sites: ['react.dev'] });
    expect(checkedInput(search, { query: 'x', exclude_sites: '["pinterest.com", "quora.com"]' })).toEqual({ query: 'x', exclude_sites: ['pinterest.com', 'quora.com'] });
    // A listed word in other letters.
    expect(checkedInput(search, { query: 'x', recency: 'Week' })).toEqual({ query: 'x', recency: 'week' });
    expect(checkedInput(page, { url: 'https://a.example', format: ' HTML ' })).toEqual({ url: 'https://a.example', format: 'html' });
    // A text that a program on the way took for a number.
    expect(checkedInput(search, { query: 2026 })).toEqual({ query: '2026' });
  });

  it('never guesses at what a value means', () => {
    // Text that is a number is still held to the limits of the number.
    expect(refusal(search, { query: 'x', max_results: '500' })).toContain('"max_results" is 500. It must be: integer, 1 to 20.');
    expect(refusal(search, { query: 'x', max_results: '2.5' })).toContain('"max_results" is 2.5.');
    expect(refusal(page, { url: 'https://a.example', part: '0' })).toContain('"part" is 0.');
    // 1 is not "true", and a broken list is not a list of one.
    expect(refusal(page, { url: 'https://a.example', browser: 1 })).toContain('"browser" is 1. It must be: boolean.');
    expect(refusal(search, { query: 'x', include_sites: '[broken' })).toContain('"include_sites" is "[broken".');
    expect(refusal(search, { query: 'x', include_sites: '["a.example", 5]' })).toContain('"include_sites" is ["a.example",5].');
  });

  it('is what runTool uses, so a wrong call is answered with the sentence, counted, and listed in the live feed', async () => {
    const limiter = createLimiter(createMemoryStore());
    const logs = createLogBook();
    const run = await runTool('search_web', { q: 'guessed' }, 'visitor', { limiter, logs });
    expect(run).toMatchObject({ ok: false, reason: 'bad_input' });
    expect(run.text).toBe(refusal(search, { q: 'guessed' }));
    expect(limiter.usage().today).toBe(1);
    const entries = (await logs.read()).entries ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ tool: 'search_web', ok: false, method: 'Not started', text: run.text });
  });
});

describe('the sample answers in the docs', () => {
  const sampleOf = (name: string): string[] => tool(name).answer.sample.split('\n');

  it('search_web: the sample is what the tool writes', async () => {
    const shared: RawHit = { url: 'https://nextjs.org/docs/messages/react-hydration-error', title: 'Text content does not match server-rendered HTML', snippet: 'Why the error happens, and the usual ways to fix it.', published: '2026-02-01' };
    const other = (n: number): RawHit => ({ url: `https://site${n}.example/page`, title: `Page ${n}`, snippet: `A description of page number ${n}, long enough to be shown as it is.` });
    const engine = (id: string, hits: RawHit[]): SearchEngine => ({ id, name: id, hosts: [`${id}.test`], siteFilter: true, search: async () => hits });
    const store = createMemoryStore();
    const out = await searchWeb({ query: 'next.js hydration error fix' }, new Trace(), {
      engines: [engine('tavily', [shared, other(1), other(2), { url: 'https://junk.example/x', title: 'Junk', snippet: 'copy' }]), engine('exa', [shared, other(3), other(4)])],
      store,
      health: createHealth(store),
      order: ['tavily', 'exa'],
      off: new Set(),
      junk: ['junk.example'],
    });
    const real = formatSearch(out)
      .replace(/\d+\.\d s\)/, '0.6 s)')
      .split('\n');
    const sample = sampleOf('search_web');

    // The first line and the whole first result, letter for letter.
    expect(real.slice(0, 7)).toEqual(sample.slice(0, 7));
    // The sample cuts the list short with "2. ...". The real list goes on with result 2.
    expect(sample[7]).toBe('2. ...');
    expect(real[7]).toBe('2. Page 1');
    // The two closing lines, letter for letter.
    expect(real.slice(-2)).toEqual(sample.slice(-2));
    expect(sample.slice(-2)).toEqual(['Left out: 1 duplicate, 1 result from a copycat site.', 'To read a result, call fetch_url with its link.']);
  });

  it('search_web: the note about an empty answer is true', async () => {
    const store = createMemoryStore();
    const none: SearchEngine = { id: 'tavily', name: 'tavily', hosts: ['tavily.test'], siteFilter: true, search: async () => [] };
    const out = await searchWeb({ query: 'zzz' }, new Trace(), { engines: [none], store, health: createHealth(store), order: ['tavily'], off: new Set(), junk: [] });
    expect(formatSearch(out)).toMatch(/^No results for "zzz"/);
    expect(search.answer.notes.join(' ')).toContain('starts with "No results for"');
  });

  it('fetch_url: the sample is what the tool writes', async () => {
    const paragraph = 'Effects are an escape hatch from the React paradigm. They let you step outside of React and synchronize your components with some external system. ';
    const markdown = `# You Might Not Need an Effect\n\n${Array.from({ length: 30 }, () => paragraph.repeat(11)).join('\n\n')}`;
    const jina: PageWay = {
      id: 'jina',
      name: 'Jina Reader',
      hosts: ['jina.test'],
      formats: ['markdown', 'html'],
      browser: true,
      own: false,
      load: async () => ({ title: 'You Might Not Need an Effect', markdown, finalUrl: 'https://react.dev/learn/you-might-not-need-an-effect' }),
    };
    const store = createMemoryStore();
    const deps: Partial<LoadDeps> = { helpers: [jina], store, health: createHealth(store), mode: 'safe', order: ['jina'], off: new Set(), wayTimeoutMs: 2_000, hedgeAfterMs: 0, budgetMs: 5_000 };
    const text = await fetchUrl({ url: 'https://react.dev/learn/you-might-not-need-an-effect' }, new Trace(), deps);
    const real = text.replace(/ in \d+\.\d s\n/, ' in 0.9 s\n').split('\n');
    const sample = sampleOf('fetch_url');

    // Everything before the content, and the title that opens it, letter for letter.
    expect(real.slice(0, 9)).toEqual(sample.slice(0, 9));
    expect(sample[9]).toBe('Effects are an escape hatch from the React paradigm. ...');
    expect(real[9]?.startsWith('Effects are an escape hatch from the React paradigm. ')).toBe(true);

    // The other lines the notes speak of are real too.
    const last = await fetchUrl({ url: 'https://react.dev/learn/you-might-not-need-an-effect', part: 3 }, new Trace(), deps);
    expect(last).toContain('\nPart: 3 of 3 (the last part)\n');
    expect(last).toContain("\nLoaded: from Scrapy's 15-minute memory (first loaded by Jina Reader)\n");
    const focused = await fetchUrl({ url: 'https://react.dev/learn/you-might-not-need-an-effect', focus: 'escape hatch' }, new Trace(), deps);
    expect(focused).toMatch(/\nFocus: "escape hatch" \(\d+ of \d+ sections kept; call again without focus for the whole page\)\n/);
    // Past the last part, the sentence says how many parts there are.
    await expect(fetchUrl({ url: 'https://react.dev/learn/you-might-not-need-an-effect', part: 4 }, new Trace(), deps)).rejects.toThrow('This page has 3 parts. "part" must be between 1 and 3.');
  });
});

describe('the list of failures', () => {
  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? sources(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(dir, entry.name)] : []));
  const code = [...sources('lib'), ...sources('app')].map((file) => ({ file, text: readFileSync(file, 'utf8') }));

  /** Every place in the code where a tool's failure sentence is made: its reason, and how the sentence starts. */
  function sentences(): { file: string; reason: string; start: string }[] {
    const found: { file: string; reason: string; start: string }[] = [];
    // new ScrapyError('reason', `Sentence ...`   or   new ScrapyError('reason', condition ? `Sentence ...`
    const pattern = /new ScrapyError\(\s*'([a-z_]+)',\s*(?:[^'"`,]*?\?\s*)?(['"`])/g;
    for (const { file, text } of code) {
      for (const match of text.matchAll(pattern)) {
        const quote = match[2] ?? '';
        const from = (match.index ?? 0) + match[0].length;
        const rest = text.slice(from);
        const end = Math.min(...[rest.indexOf(quote), rest.indexOf('${')].filter((at) => at !== -1));
        found.push({ file, reason: match[1] ?? '', start: rest.slice(0, end) });
      }
    }
    return found;
  }

  it('reads every failure sentence in the code', () => {
    const all = code.reduce((sum, { text }) => sum + (text.match(/new ScrapyError\(/g) ?? []).length, 0);
    // One place makes a failure from a remembered one (a page known to be missing), so it has no sentence of its own.
    const copies = code.reduce((sum, { text }) => sum + (text.match(/new ScrapyError\(missing\.reason, missing\.message\)/g) ?? []).length, 0);
    expect(copies).toBe(1);
    expect(sentences()).toHaveLength(all - copies);
    expect(all).toBeGreaterThanOrEqual(30);
  });

  it('knows how every failure sentence starts', () => {
    for (const { file, reason, start } of sentences()) {
      const advice = FAILURES[reason as Reason];
      expect(advice, `${file}: reason "${reason}"`).toBeDefined();
      const known = [...advice.starts, ...(advice.more ?? [])];
      expect(
        known.some((k) => start.startsWith(k)),
        `${file}: a "${reason}" sentence starts with "${start.slice(0, 50)}", which the list of failures does not know`,
      ).toBe(true);
    }
  });

  it('lists no start that no sentence has', () => {
    // The list of failures itself does not count as a use.
    const withoutList = code
      .filter(({ file }) => !file.endsWith(join('lib', 'errors.ts')))
      .map(({ text }) => text)
      .join('\n');
    for (const [reason, advice] of Object.entries(FAILURES)) {
      for (const start of [...advice.starts, ...(advice.more ?? [])]) {
        if (start === '"') continue;
        expect(
          ["'", '"', '`'].some((quote) => withoutList.includes(`${quote}${start}`)),
          `${reason}: no sentence in the code starts with "${start}"`,
        ).toBe(true);
      }
    }
  });

  it('has advice for every kind, in words an agent can act on', () => {
    const docs = failureDocs();
    expect(docs.map((d) => d.reason).sort()).toEqual(Object.keys(FAILURES).sort());
    for (const d of docs) {
      expect(d.starts.length, d.reason).toBeGreaterThan(0);
      expect(d.means.length, d.reason).toBeGreaterThan(15);
      expect(d.then.length, d.reason).toBeGreaterThan(15);
    }
    // What to do after an empty page is the same as what the sentence itself suggests.
    expect(docs.find((d) => d.reason === 'empty')?.then).toContain('browser set to true');
  });
});

describe('the numbers in the docs', () => {
  it('are the ones Scrapy runs on', () => {
    const f = facts();
    expect(f.limits).toEqual({ perMinute: 30, perDay: 1500 });
    expect(f.search).toMatchObject({ defaultResults: 8, maxResults: 20, perSite: 3, graceSeconds: 2.5, enoughResults: 5, memoryMinutes: 15 });
    expect(f.search.copycatSites).toBeGreaterThan(50);
    expect(f.search.order.map((e) => e.id)).toEqual(['tavily', 'exa', 'parallel', 'firecrawl']);
    expect(f.page).toMatchObject({ partChars: 20_000, memoryMinutes: 15, budgetSeconds: 45, hedgeSeconds: 6, thinChars: 500, siteMemoryHours: 24, own: 'never' });
    expect(f.page.order.map((w) => `${w.id}${w.browser ? '*' : ''}`)).toEqual(['jina*', 'firecrawl*', 'tavily', 'parallel*', 'exa']);
    expect(f.rest).toEqual({ busyMinutes: 10, failSeconds: 90, failsBeforeRest: 2 });
    expect(f.logs).toEqual({ on: true, keep: 100, hours: 24 });
    expect(f.where).toEqual({ vercel: false, env: null });
  });

  it('follow the settings', () => {
    process.env.SCRAPY_VISITOR_PER_MINUTE = '7';
    process.env.SCRAPY_DAILY_CALLS = '321';
    process.env.SCRAPY_OFF = 'exa,jina';
    process.env.SCRAPY_SEARCH_ORDER = 'firecrawl,tavily';
    process.env.SCRAPY_PAGE_ORDER = 'parallel,tavily';
    process.env.SCRAPY_MODE = 'middle';
    process.env.VERCEL = '1';
    process.env.VERCEL_ENV = 'production';
    const f = facts();
    expect(f.limits).toEqual({ perMinute: 7, perDay: 321 });
    // The named ones first, in the order given. The rest keep their own order. What is switched off is not listed.
    expect(f.search.order.map((e) => e.id)).toEqual(['firecrawl', 'tavily', 'parallel']);
    expect(f.search.off).toEqual(['Exa']);
    // "exa" names both the search engine and the page helper: switched off, both are.
    expect(f.page.order.map((w) => w.id)).toEqual(['parallel', 'tavily', 'firecrawl']);
    expect(f.page.off).toEqual(['Jina Reader', 'Exa']);
    expect(f.page.own).toBe('last');
    expect(f.logs.on).toBe(false);
    expect(f.where).toEqual({ vercel: true, env: 'production' });

    process.env.SCRAPY_MODE = 'full';
    expect(facts().page.own).toBe('first');
    process.env.SCRAPY_OFF = 'own';
    expect(facts().page.own).toBe('never');

    // The rulebook quotes the same numbers.
    const text = rulebook();
    expect(text).toContain('- At most 7 calls a minute for each caller.');
    expect(text).toContain('- At most 321 calls a day for all callers together.');
  });
});

describe('the rulebook for agents', () => {
  const text = rulebook();

  it('says which tool to use, and never to make up a link', () => {
    expect(text.startsWith('# Scrapy: the rulebook for AI agents\n')).toBe(true);
    expect(text).toContain('- You need information and have no link: call `search_web`.');
    expect(text).toContain('- You have a link and need what the page says: call `fetch_url`.');
    expect(text).toContain('- Never make up a link.');
    expect(text).toContain('A parameter that is not listed is refused.');
  });

  it('has, for every tool, its description, every parameter, every example and the sample answer', () => {
    for (const doc of toolDocs()) {
      expect(text).toContain(`## ${doc.name}: ${doc.title}\n\n${doc.description}\n`);
      for (const p of doc.params) expect(text, `${doc.name}.${p.name}`).toContain(`- \`${p.name}\` (`);
      for (const example of doc.examples) expect(text).toContain(`- ${example.about} \`${JSON.stringify(example.args)}\``);
      expect(text).toContain(`\`\`\`\n${doc.answer.sample}\n\`\`\``);
      for (const note of doc.answer.notes) expect(text).toContain(`- ${note}`);
    }
    expect(text).toContain('- `query` (string, required, 1 to 500 characters): What to search for: a full question or a few keywords.');
    expect(text).toContain('- `max_results` (integer, 1 to 20, default 8): ');
    expect(text).toContain('- `browser` (boolean, default false): ');
  });

  it('has the table of failures, one row for each kind', () => {
    const rows = text.split('\n').filter((line) => line.startsWith('| `'));
    expect(rows).toHaveLength(Object.keys(FAILURES).length);
    for (const d of failureDocs()) {
      expect(text).toContain(`| ${d.starts.map((s) => `\`${s}\``).join(' or ')} | ${d.means} | ${d.then} |`);
    }
    // No cell breaks the table.
    for (const row of rows) expect(row.split(' | ')).toHaveLength(3);
  });

  it('says where Scrapy is, when it is given the address', () => {
    expect(text).not.toContain('MCP address:');
    const placed = rulebook({ address: 'https://scrapy.example/api/mcp' });
    expect(placed).toContain('\nMCP address: https://scrapy.example/api/mcp (Streamable HTTP, no key needed).\n');
    expect(placed.replace('MCP address: https://scrapy.example/api/mcp (Streamable HTTP, no key needed).\n\n', '')).toBe(text);
  });

  it('is short enough to paste into an instruction, and plain text only', () => {
    expect(text.length).toBeLessThan(12_000);
    // Nothing a model cannot read, and nothing that would look like markup to it.
    expect(text).not.toMatch(/<[a-z/]/i);
    expect(text).not.toMatch(/\t/);
  });

  it('agrees with what an agent is told on connecting', () => {
    expect(SERVER_INSTRUCTIONS).toContain('search_web');
    expect(SERVER_INSTRUCTIONS).toContain('fetch_url');
    expect(SERVER_INSTRUCTIONS).toContain('a parameter that is not listed is refused');
    expect(SERVER_INSTRUCTIONS).toContain('within 15 minutes');
    expect(SERVER_INSTRUCTIONS).toContain('scrapy://rulebook');
    expect(SERVER_INSTRUCTIONS.length).toBeLessThan(1_000);
    // Neither says that a call answered from memory is free of charge: it counts as a call.
    expect(`${SERVER_INSTRUCTIONS} ${text}`).not.toMatch(/costs nothing|uses up nothing/);
    expect(text).toContain('- Every call counts, also one that is answered from memory and one with wrong input.');
  });
});

describe('what the docs page is given', () => {
  it('holds everything the two pages show', () => {
    const payload = docsPayload();
    expect(Object.keys(payload)).toEqual(['version', 'release', 'mode', 'instructions', 'rulebookUri', 'rulebook', 'addressLine', 'tools', 'failures', 'facts']);
    expect(payload.version).toBe('1.0.0');
    expect(payload.release).toBe('G - 1.0');
    // The page puts its own address into this line. The rulebook at /llms.txt has the same line.
    expect(payload.addressLine.replace('{address}', 'https://scrapy.example/api/mcp')).toBe(rulebook({ address: 'https://scrapy.example/api/mcp' }).split('\n')[4]);
    expect(payload.facts.access).toBe('open');
    expect(payload.instructions).toBe(SERVER_INSTRUCTIONS);
    expect(payload.rulebook).toBe(rulebook());
    expect(payload.rulebookUri).toBe('scrapy://rulebook');
    expect(payload.tools.map((t) => t.name)).toEqual(['search_web', 'fetch_url']);
    expect(payload.tools[0]?.signature).toContain('query (string, required, 1 to 500 characters); max_results (integer, 1 to 20, default 8)');
    expect(payload.tools[0]?.schema).toEqual(jsonSchemaOf(search.schema));
    // It can be sent as it is.
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  });

  it('reads the address a request came to, as the caller typed it', () => {
    expect(originOf(new Request('http://localhost:3000/llms.txt'))).toBe('http://localhost:3000');
    expect(originOf(new Request('http://10.0.0.7:3000/llms.txt', { headers: { 'x-forwarded-host': 'scrapy.example', 'x-forwarded-proto': 'https' } }))).toBe('https://scrapy.example');
    expect(originOf(new Request('http://10.0.0.7:3000/llms.txt', { headers: { host: 'scrapy.example', 'x-forwarded-proto': 'https, http' } }))).toBe('https://scrapy.example');
  });
});
