/**
 * The checks behind the "Run checks" button.
 *
 * 1. Every free helper is asked one small thing, to see whether it answers
 *    from where Scrapy runs, and how fast.
 * 2. The real tools are timed and compared with their targets.
 * 3. In the safe position, the list of contacted addresses is checked: it must
 *    hold helpers only.
 */
import { getMode, VERSION, type Mode } from './config';
import { clip, describeFailure } from './errors';
import { createHealth } from './health';
import { loadPage } from './page/load';
import { plainText } from './page/markdown';
import { HELPER_HOSTS, PAGE_HELPERS, SEARCH_ENGINES } from './providers';
import { asHelperError } from './providers/shared';
import { searchWeb } from './search';
import { createMemoryStore } from './store';
import { Trace, type Contact } from './trace';

export interface HelperCheck {
  id: string;
  name: string;
  job: 'search' | 'page';
  answers: boolean;
  ms: number;
  note: string;
}

export interface SpeedCheck {
  what: string;
  ok: boolean;
  ms: number;
  targetMs: number;
  note: string;
}

export interface CheckReport {
  at: string;
  version: string;
  mode: Mode;
  /** Where on Vercel this ran, when known. */
  region: string | null;
  helpers: HelperCheck[];
  speed: SpeedCheck[];
  safe: { applies: boolean; ok: boolean; note: string };
  hosts: string[];
  contacts: Contact[];
  tookMs: number;
  samples?: { who: string; text: string }[];
}

const SEARCH_QUESTION = 'how to center a div with CSS flexbox';
const PLAIN_PAGE = 'https://example.com/';
/** A practice page made for tools like this one. Its quotes only appear when JavaScript runs. */
const JS_PAGE = 'https://quotes.toscrape.com/js/';
const HELPER_TIMEOUT_MS = 20_000;

async function checkSearch(trace: Trace): Promise<HelperCheck[]> {
  return Promise.all(
    SEARCH_ENGINES.map(async (engine): Promise<HelperCheck> => {
      const started = Date.now();
      try {
        const hits = await engine.search({ query: SEARCH_QUESTION, count: 5, includeSites: [], excludeSites: [] }, trace, { timeoutMs: HELPER_TIMEOUT_MS });
        const first = hits[0];
        const answers = hits.length > 0;
        return {
          id: engine.id,
          name: engine.name,
          job: 'search',
          answers,
          ms: Date.now() - started,
          note: first ? `${hits.length} results. First: ${clip(first.title || first.url, 70)}` : 'answered, but with no results',
        };
      } catch (err) {
        const e = asHelperError(engine.id, err);
        return { id: engine.id, name: engine.name, job: 'search', answers: false, ms: Date.now() - started, note: clip(describeFailure(e), 160) };
      }
    }),
  );
}

async function checkPages(trace: Trace): Promise<HelperCheck[]> {
  return Promise.all(
    PAGE_HELPERS.map(async (way): Promise<HelperCheck> => {
      const started = Date.now();
      try {
        const raw = await way.load({ url: PLAIN_PAGE, format: 'markdown', browser: false }, trace, { timeoutMs: HELPER_TIMEOUT_MS });
        const text = plainText(raw.markdown ?? raw.html ?? raw.rawHtml ?? '');
        const answers = /example domain/i.test(`${raw.title ?? ''} ${text}`);
        return {
          id: way.id,
          name: way.name,
          job: 'page',
          answers,
          ms: Date.now() - started,
          note: answers ? `read example.com (${text.length} characters)` : `answered, but not with the page: ${clip(text, 90)}`,
        };
      } catch (err) {
        const e = asHelperError(way.id, err);
        return { id: way.id, name: way.name, job: 'page', answers: false, ms: Date.now() - started, note: clip(describeFailure(e), 160) };
      }
    }),
  );
}

async function timed(what: string, targetMs: number, run: () => Promise<string>): Promise<SpeedCheck> {
  const started = Date.now();
  try {
    const note = await run();
    return { what, ok: true, ms: Date.now() - started, targetMs, note };
  } catch (err) {
    return { what, ok: false, ms: Date.now() - started, targetMs, note: clip(err instanceof Error ? err.message : String(err), 220) };
  }
}

export async function runChecks(options: { debug?: boolean } = {}): Promise<CheckReport> {
  const started = Date.now();
  const mode = getMode();
  const trace = new Trace(options.debug === true);

  // Helpers one job after the other, so no helper gets two requests in the same instant.
  const helpers = [...(await checkSearch(trace)), ...(await checkPages(trace))];

  // The real tools, with an empty memory of their own, so nothing is answered from memory by accident.
  const store = createMemoryStore();
  const health = createHealth(store);
  const safeTarget = mode === 'full' ? 2_000 : 10_000;
  const speed: SpeedCheck[] = [];
  speed.push(
    await timed('search_web', 3_000, async () => {
      const out = await searchWeb({ query: 'next.js hydration error how to fix' }, trace, { store, health });
      const both = out.results.filter((r) => r.foundBy.length > 1).length;
      return `${out.results.length} results from ${out.engines.filter((e) => e.ok).map((e) => e.id).join(' + ') || 'no engine'}, ${both} found by more than one engine`;
    }),
  );
  speed.push(
    await timed('fetch_url, ordinary page', safeTarget, async () => {
      const { doc } = await loadPage({ url: PLAIN_PAGE }, trace, { store, health, budgetMs: 30_000 });
      if (!/example domain/i.test(doc.content)) throw new Error(`loaded by ${doc.wayName}, but the text was not the page's`);
      return `loaded by ${doc.wayName}, ${doc.content.length} characters`;
    }),
  );
  speed.push(
    await timed('fetch_url, same page again', 1_000, async () => {
      const { cached } = await loadPage({ url: PLAIN_PAGE }, trace, { store, health, budgetMs: 30_000 });
      if (!cached) throw new Error('the page was loaded again instead of coming from memory');
      return "from Scrapy's 15-minute memory";
    }),
  );
  speed.push(
    await timed('fetch_url, page that needs JavaScript', 10_000, async () => {
      const { doc } = await loadPage({ url: JS_PAGE }, trace, { store, health, budgetMs: 30_000 });
      if (!/einstein/i.test(doc.content)) throw new Error(`loaded by ${doc.wayName}, but the content built by JavaScript is missing`);
      return `loaded by ${doc.wayName}, content built by JavaScript is there`;
    }),
  );

  const hosts = trace.hosts();
  const strangers = hosts.filter((h) => !HELPER_HOSTS.includes(h));
  const safe =
    mode === 'safe'
      ? strangers.length === 0
        ? { applies: true, ok: true, note: `Only free helpers were contacted: ${hosts.join(', ') || 'none'}.` }
        : { applies: true, ok: false, note: `Addresses that are not helpers were contacted: ${strangers.join(', ')}.` }
      : { applies: false, ok: true, note: `Position is "${mode}", so Scrapy may contact a page's own site.` };

  return {
    at: new Date().toISOString(),
    version: VERSION,
    mode,
    region: process.env.VERCEL_REGION ?? null,
    helpers,
    speed,
    safe,
    hosts,
    contacts: trace.contacts,
    tookMs: Date.now() - started,
    ...(options.debug ? { samples: trace.samples } : {}),
  };
}
