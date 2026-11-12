/**
 * Every setting of Scrapy in one place.
 * None of these is a key or a password. Scrapy needs no account anywhere.
 */

export const VERSION = '0.1.0';
export const REPO_URL = 'https://github.com/xkilosky/Scrapy';

/** How Scrapy names itself to every service and site it talks to. */
export const USER_AGENT = `Scrapy/${VERSION} (+${REPO_URL})`;

/**
 * The one big setting: how web pages get loaded.
 *
 * - safe:   Scrapy never downloads the page itself. It only asks the free helper services.
 * - middle: helpers first, Scrapy's own download when they are busy.
 * - full:   Scrapy's own download first, helpers for pages that need a real browser.
 *
 * Set with the environment variable SCRAPY_MODE. Anything else means "safe".
 */
export type Mode = 'safe' | 'middle' | 'full';

export function getMode(): Mode {
  const raw = (process.env.SCRAPY_MODE ?? '').trim().toLowerCase();
  if (raw === 'middle') return 'middle';
  if (raw === 'full' || raw === 'full-speed' || raw === 'fullspeed') return 'full';
  return 'safe';
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function envList(name: string): string[] | null {
  const raw = process.env[name];
  if (!raw) return null;
  const items = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return items.length > 0 ? items : null;
}

export const SEARCH = {
  defaultCount: 8,
  maxCount: 20,
  /** No more than this many results from one site. */
  perSite: 3,
  /** How long one search engine may take. */
  engineTimeoutMs: 9_000,
  /** Once one engine has answered, how much longer the other one gets. */
  graceMs: 2_500,
  /** With fewer usable results than this, the remaining engines are asked too. */
  enoughResults: 5,
  cacheSec: 900,
} as const;

export const PAGE = {
  /** Long pages are returned in parts of about this many characters. */
  partChars: 20_000,
  cacheSec: 900,
  /** How long one way of loading a page may take. */
  wayTimeoutMs: 25_000,
  /** With no answer after this long, the next way is started alongside. 0 switches this off. */
  hedgeAfterMs: 6_000,
  /** The whole fetch gives up after this long. */
  budgetMs: 45_000,
  maxHelperBytes: 8_000_000,
  maxOwnBytes: 5_000_000,
  /** Pages longer than this are cut, with a note. */
  maxChars: 1_500_000,
  /** A page with less text than this looks thin, and is read once more in a real browser to be sure. */
  thinChars: 500,
  /** How long that second reading may take. */
  secondOpinionMs: 15_000,
  /** How long Scrapy remembers which way of loading worked for a site. */
  siteMemorySec: 24 * 3_600,
} as const;

export const REST = {
  /** A helper that says "slow down" without saying for how long rests this long. */
  busySec: 600,
  /** A helper that failed twice in a row rests this long. */
  failSec: 90,
  failsBeforeRest: 2,
} as const;

/** The log of tool calls behind the "Live feed". */
export const LOGS = {
  /** How many calls are kept. Older ones are forgotten. */
  keep: 100,
  /** A call is forgotten after this many hours, even when fewer than "keep" came after it. */
  hours: 24,
  /** An answer longer than this is cut in the log (never in what the agent gets). */
  maxAnswerChars: 60_000,
  /** At least this long between two writes of the list to the shared memory. A burst of calls is written in one go. */
  writeGapMs: 1_000,
  /** A caller who is over a limit is listed once in this long, not for every refused call. */
  refusalGapMs: 60_000,
} as const;

/**
 * Is the log on?
 *
 * The log holds what was asked and what was answered, and everybody who can
 * open Scrapy's page can read it. So it is on where that page is private: on a
 * developer's machine and on Vercel's test addresses, which need the owner's
 * Vercel login. On Vercel's public address ("production") it is off.
 *
 * SCRAPY_LOGS=off switches it off everywhere. SCRAPY_LOGS=on switches it on
 * everywhere, the public address included: only for an address that strangers
 * cannot open.
 */
export function logsSetting(): 'on' | 'off' | 'auto' {
  const raw = (process.env.SCRAPY_LOGS ?? '').trim().toLowerCase();
  if (raw === 'off' || raw === '0' || raw === 'no' || raw === 'false') return 'off';
  if (raw === 'on' || raw === '1' || raw === 'yes' || raw === 'true') return 'on';
  return 'auto';
}

export function logsOn(): boolean {
  const setting = logsSetting();
  if (setting !== 'auto') return setting === 'on';
  return process.env.VERCEL_ENV !== 'production';
}

export function limits(): { visitorPerMinute: number; dailyCalls: number } {
  return {
    visitorPerMinute: envInt('SCRAPY_VISITOR_PER_MINUTE', 30, 1, 100_000),
    dailyCalls: envInt('SCRAPY_DAILY_CALLS', 1_500, 1, 10_000_000),
  };
}

/**
 * The first two are asked at once, the other two are the fallback. The order
 * comes from the first live measurement from Vercel (2026-11-11): Exa 0.7 s,
 * Parallel 0.9 s, Tavily 1.1 s, Firecrawl 1.8 s and more.
 */
export const DEFAULT_SEARCH_ORDER = ['tavily', 'exa', 'parallel', 'firecrawl'] as const;

/** Whose description of a page is shown when several engines found it. Best first. */
export const SNIPPET_ORDER = ['tavily', 'exa', 'firecrawl', 'parallel'] as const;
export const DEFAULT_PAGE_ORDER = ['jina', 'firecrawl', 'tavily', 'parallel', 'exa'] as const;

/** The order in which search engines are tried. Change with SCRAPY_SEARCH_ORDER=exa,tavily,... */
export function searchOrder(): string[] {
  return envList('SCRAPY_SEARCH_ORDER') ?? [...DEFAULT_SEARCH_ORDER];
}

/** The order in which page helpers are tried. Change with SCRAPY_PAGE_ORDER=firecrawl,jina,... */
export function pageOrder(): string[] {
  return envList('SCRAPY_PAGE_ORDER') ?? [...DEFAULT_PAGE_ORDER];
}

/** Helpers listed in SCRAPY_OFF=jina,exa are never used. Handy for testing the fallback. */
export function switchedOff(): Set<string> {
  return new Set(envList('SCRAPY_OFF') ?? []);
}

export function onVercel(): boolean {
  return process.env.VERCEL === '1';
}
