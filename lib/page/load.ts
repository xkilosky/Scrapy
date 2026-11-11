/**
 * Loads one web page and returns its main content. Every page tool uses this.
 *
 * What makes it "intelligent":
 * - It tries the ways of loading a page in order, and remembers which way
 *   worked for a site, so the next page from that site starts with it.
 * - It checks its own result. An empty page, a "turn on JavaScript" page or a
 *   block page is not an answer, and the next way is tried.
 * - A page with very little text may only be the frame of a page that builds
 *   its content with JavaScript. It is read once more in a real browser, and
 *   the fuller of the two results is kept.
 * - When a way is slow, the next one is started alongside and the first good
 *   answer wins.
 * - A helper that says "slow down" is rested, and the others carry on.
 * - A page is remembered for 15 minutes, so several tools can use it while it
 *   is loaded only once.
 */
import { getMode, PAGE, pageOrder, REST, switchedOff, type Mode } from '../config';
import { describeFailure, HelperError, ScrapyError, waitText, type FailKind } from '../errors';
import { checkPublicUrl } from '../guard';
import { getHealth, type Health } from '../health';
import { OWN_DOWNLOAD, PAGE_HELPERS } from '../providers';
import { asHelperError } from '../providers/shared';
import type { PageFormat, PageWay, RawPage } from '../providers/types';
import { getStore, type Store } from '../store';
import type { Trace } from '../trace';
import { cleanPage, tidyFragment } from './clean';
import { headings, plainText, tidyMarkdown } from './markdown';
import { judge } from './quality';

export interface PageDoc {
  /** The link as it was asked for. */
  url: string;
  /** The link after any redirects. */
  finalUrl: string;
  title: string;
  description?: string;
  language?: string;
  published?: string;
  format: PageFormat;
  /** The whole main content, as Markdown or as tidy HTML. Not cut into parts. */
  content: string;
  /** Which way loaded the page: a helper's id, or "own". */
  way: string;
  wayName: string;
  loadMs: number;
  loadedAt: number;
  notes: string[];
}

export interface LoadInput {
  url: string;
  format?: PageFormat;
  browser?: boolean;
  /** Skip the 15-minute memory and load the page again. */
  fresh?: boolean;
}

export interface LoadResult {
  doc: PageDoc;
  cached: boolean;
}

export interface LoadDeps {
  helpers: PageWay[];
  own: PageWay;
  store: Store;
  health: Health;
  mode: Mode;
  order: string[];
  off: Set<string>;
  wayTimeoutMs: number;
  hedgeAfterMs: number;
  budgetMs: number;
}

function defaults(): LoadDeps {
  return {
    helpers: PAGE_HELPERS,
    own: OWN_DOWNLOAD,
    store: getStore(),
    health: getHealth(),
    mode: getMode(),
    order: pageOrder(),
    off: switchedOff(),
    wayTimeoutMs: PAGE.wayTimeoutMs,
    hedgeAfterMs: PAGE.hedgeAfterMs,
    budgetMs: PAGE.budgetMs,
  };
}

interface Attempt {
  way: string;
  kind: FailKind;
  note: string;
  retryAfterSec?: number;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function webUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** Turns what a way returned into a finished page, and judges it. Throws a HelperError when it is not a usable page. */
function finish(raw: RawPage, requested: URL, format: PageFormat, way: PageWay, loadMs: number): PageDoc {
  const finalUrl = webUrl(raw.finalUrl) ?? requested.href;
  let title = (raw.title ?? '').replace(/\s+/g, ' ').trim();
  let description = raw.description?.trim() || undefined;
  let language = raw.language?.trim() || undefined;
  let published = raw.published?.trim() || undefined;
  let markdown: string;
  let html: string | undefined;

  if (raw.rawHtml !== undefined) {
    const cleaned = cleanPage(raw.rawHtml, finalUrl);
    markdown = cleaned.markdown;
    html = cleaned.html;
    title ||= cleaned.title;
    description ??= cleaned.description;
    language ??= cleaned.language;
    published ??= cleaned.published;
  } else if (raw.html !== undefined) {
    const tidied = tidyFragment(raw.html, finalUrl);
    markdown = tidied.markdown;
    html = tidied.html;
  } else {
    markdown = tidyMarkdown(raw.markdown ?? '');
  }

  const verdict = judge({ markdown, title });
  if (!verdict.ok) throw new HelperError(way.id, verdict.kind, verdict.why);

  const heads = headings(markdown);
  if (title === '') title = heads[0]?.text ?? requested.hostname;

  let content: string;
  if (format === 'html') {
    if (html === undefined) throw new HelperError(way.id, 'bad_response', 'no HTML came back');
    // The page title leads the content, as it does on the page.
    content = /<h1[\s>]/i.test(html) ? html : `<h1>${escapeHtml(title)}</h1>\n${html}`;
  } else {
    content = heads.some((h) => h.level === 1) ? markdown : `# ${title}\n\n${markdown}`;
  }

  const notes: string[] = [];
  if (content.length > PAGE.maxChars) {
    content = content.slice(0, PAGE.maxChars);
    notes.push(`This page is extremely long. Only its first ${PAGE.maxChars.toLocaleString('en-US')} characters are kept.`);
  }

  return {
    url: requested.href,
    finalUrl,
    title,
    ...(description ? { description } : {}),
    ...(language ? { language } : {}),
    ...(published ? { published } : {}),
    format,
    content,
    way: way.id,
    wayName: way.name,
    loadMs,
    loadedAt: Date.now(),
    notes,
  };
}

/** What Scrapy remembers about a site: which way worked, and whether it took a real browser. */
interface SiteMemory {
  way: string;
  browser: boolean;
}

async function plan(
  deps: LoadDeps,
  format: PageFormat,
  askedForBrowser: boolean,
  memoryKey: string,
): Promise<{ ways: PageWay[]; resting: { id: string; sec: number }[]; remembered: SiteMemory | null; browser: boolean }> {
  const remembered = await deps.store.get<SiteMemory>(memoryKey);
  // A site that needed a real browser last time gets one straight away.
  const browser = askedForBrowser || remembered?.browser === true;

  const rank = (id: string): number => {
    const at = deps.order.indexOf(id);
    return at === -1 ? deps.order.length : at;
  };
  let helpers = deps.helpers.filter((w) => !w.own && w.formats.includes(format) && !deps.off.has(w.id)).sort((a, b) => rank(a.id) - rank(b.id));
  if (browser) helpers = [...helpers.filter((w) => w.browser), ...helpers.filter((w) => !w.browser)];

  // The safe position: helpers only. Scrapy's own download is not even on the list.
  const own = deps.mode === 'safe' || deps.off.has('own') ? [] : [deps.own];
  let ways: PageWay[];
  if (deps.mode === 'full' && !browser) ways = [...own, ...helpers];
  else ways = [...helpers, ...own];

  const favourite = remembered ? ways.find((w) => w.id === remembered.way) : undefined;
  if (favourite && (!browser || favourite.browser)) ways = [favourite, ...ways.filter((w) => w !== favourite)];

  const usable: PageWay[] = [];
  const resting: { id: string; sec: number }[] = [];
  for (const way of ways) {
    const sec = way.own ? 0 : await deps.health.resting(`${way.id}:page`);
    if (sec > 0) resting.push({ id: way.id, sec });
    else usable.push(way);
  }
  return { ways: usable, resting, remembered: remembered ?? null, browser };
}

function explain(attempts: Attempt[], resting: { id: string; sec: number }[], browser: boolean): ScrapyError {
  const tried = [...attempts.map((a) => `${a.way}: ${a.note}`), ...resting.map((r) => `${r.id}: resting, back ${waitText(r.sec)}`)].join('; ');
  const detail = tried ? ` (Tried: ${tried})` : '';
  const kinds = attempts.map((a) => a.kind);
  const has = (kind: FailKind): boolean => kinds.includes(kind);
  const real = kinds.filter((k) => k !== 'cancelled');

  if (has('not_found')) return new ScrapyError('not_found', `Not found: this page does not exist.${detail}`);
  if (has('login')) return new ScrapyError('login', `Needs a login: this page asks for a login or a subscription. Scrapy does not get around logins.${detail}`);
  if (has('not_a_page')) return new ScrapyError('not_a_page', `This link is a file, not a web page. Scrapy reads web pages only.${detail}`);

  const waits = [...attempts.filter((a) => a.kind === 'busy').map((a) => a.retryAfterSec ?? REST.busySec), ...resting.map((r) => r.sec)];
  if (real.length === 0 || real.every((k) => k === 'busy' || k === 'refused')) {
    const wait = waits.length > 0 ? Math.min(...waits) : REST.busySec;
    return new ScrapyError('busy', `The free services that load pages are busy. Try again ${waitText(wait)}.${detail}`, wait);
  }
  if (real.every((k) => k === 'unreachable')) {
    return new ScrapyError('failed', `The free services that load pages could not be reached. Try again in a minute.${detail}`, 60);
  }
  if (has('blocked')) return new ScrapyError('blocked', `Blocked by the site: it refused to show this page to an automated reader.${detail}`);
  if (has('empty') || has('needs_js')) {
    const hint = browser ? '' : ' Try again with browser set to true.';
    return new ScrapyError('empty', `The page came back empty. It may build its content with JavaScript.${hint}${detail}`);
  }
  if (real.every((k) => k === 'timeout')) return new ScrapyError('too_slow', `Took too long: the page did not load in time. Try again.${detail}`);
  return new ScrapyError('failed', `Could not load this page.${detail}`);
}

/**
 * Runs the ways one after another. A slow way gets company: after hedgeAfterMs
 * the next way starts too, and the first usable answer wins.
 */
async function race(
  ways: PageWay[],
  attempt: (way: PageWay, signal: AbortSignal) => Promise<PageDoc>,
  cfg: { hedgeAfterMs: number; budgetMs: number },
): Promise<{ doc: PageDoc | null; attempts: Attempt[] }> {
  type Settled = { way: PageWay; doc: PageDoc } | { way: PageWay; error: HelperError };
  const stop = new AbortController();
  const attempts: Attempt[] = [];
  const running = new Map<string, Promise<Settled>>();
  const queue = [...ways];
  const deadline = Date.now() + cfg.budgetMs;
  let logins = 0;

  const start = (): void => {
    const way = queue.shift();
    if (!way) return;
    running.set(
      way.id,
      attempt(way, stop.signal).then(
        (doc): Settled => ({ way, doc }),
        (err): Settled => ({ way, error: asHelperError(way.id, err) }),
      ),
    );
  };

  start();
  let hedgeAt = cfg.hedgeAfterMs > 0 ? Date.now() + cfg.hedgeAfterMs : Number.POSITIVE_INFINITY;

  try {
    while (running.size > 0) {
      const wakeAt = Math.min(deadline, queue.length > 0 ? hedgeAt : Number.POSITIVE_INFINITY);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const tick = new Promise<'tick'>((resolve) => {
        timer = setTimeout(() => resolve('tick'), Math.max(0, wakeAt - Date.now()));
      });
      const first = await Promise.race([...running.values(), tick]);
      if (timer !== undefined) clearTimeout(timer);

      if (first === 'tick') {
        if (Date.now() >= deadline) break;
        start();
        hedgeAt = Date.now() + cfg.hedgeAfterMs;
        continue;
      }

      running.delete(first.way.id);
      if ('doc' in first) return { doc: first.doc, attempts };

      const { error } = first;
      if (error.kind !== 'cancelled') {
        attempts.push({ way: first.way.id, kind: error.kind, note: describeFailure(error), ...(error.retryAfterSec !== undefined ? { retryAfterSec: error.retryAfterSec } : {}) });
      }
      // "Does not exist" is final. No other way will find the page.
      if (error.kind === 'not_found' || error.kind === 'not_a_page') break;
      // A login wall is the same for every reader. One second opinion, then stop.
      if (error.kind === 'login' && ++logins >= 2) break;
      // A page that needs JavaScript goes to the ways that use a real browser next.
      if (error.kind === 'needs_js' || error.kind === 'empty') {
        queue.sort((a, b) => Number(b.browser) - Number(a.browser));
      }
      if (running.size === 0 && Date.now() < deadline) {
        start();
        hedgeAt = Date.now() + cfg.hedgeAfterMs;
      }
    }
    for (const id of running.keys()) attempts.push({ way: id, kind: 'timeout', note: 'ran out of time' });
    return { doc: null, attempts };
  } finally {
    stop.abort();
  }
}

export async function loadPage(input: LoadInput, trace: Trace, overrides: Partial<LoadDeps> = {}): Promise<LoadResult> {
  const deps = { ...defaults(), ...overrides };
  const format: PageFormat = input.format === 'html' ? 'html' : 'markdown';
  const browser = input.browser === true;
  const requested = checkPublicUrl(input.url);

  const cacheKey = `page:${format}:${browser ? 'browser' : 'plain'}:${requested.href}`;
  const missingKey = `missing:${requested.href}`;
  if (!input.fresh) {
    const remembered = await deps.store.get<PageDoc>(cacheKey);
    if (remembered) {
      trace.cache = 'hit';
      return { doc: remembered, cached: true };
    }
    const missing = await deps.store.get<{ reason: 'not_found'; message: string }>(missingKey);
    if (missing) {
      trace.cache = 'hit';
      throw new ScrapyError(missing.reason, missing.message);
    }
  }
  trace.cache = 'miss';

  const memoryKey = `site:${format}:${requested.host}`;
  const deadline = Date.now() + deps.budgetMs;
  const planned = await plan(deps, format, browser, memoryKey);
  const { ways, resting, remembered } = planned;
  for (const r of resting) trace.step(r.id, false, 0, `resting, back ${waitText(r.sec)}`);
  if (ways.length === 0) throw explain([], resting, browser);

  const attempt = async (way: PageWay, signal: AbortSignal, useBrowser: boolean, label: string): Promise<PageDoc> => {
    // Belt and braces for the safe position: the own download must never run in it.
    if (way.own && deps.mode === 'safe') throw new HelperError(way.id, 'refused', 'own download is switched off in the safe position');
    const started = Date.now();
    const id = `${way.id}:page`;
    try {
      const raw = await way.load({ url: requested.href, format, browser: useBrowser }, trace, { timeoutMs: deps.wayTimeoutMs, signal });
      const doc = finish(raw, requested, format, way, Date.now() - started);
      if (!way.own) deps.health.succeeded(id, doc.loadMs);
      trace.step(label, true, doc.loadMs, `${doc.content.length.toLocaleString('en-US')} characters`);
      return doc;
    } catch (err) {
      const error = asHelperError(way.id, err);
      const ms = Date.now() - started;
      if (!way.own) {
        if (error.kind === 'busy') await deps.health.rest(id, error.retryAfterSec ?? REST.busySec, error.message);
        else if (error.kind === 'refused') await deps.health.rest(id, 3_600, error.message);
        else if (error.kind === 'unreachable' || error.kind === 'bad_response') await deps.health.failed(id, error.message);
      }
      trace.step(label, false, ms, describeFailure(error));
      throw error;
    }
  };

  const raced = await race(ways, (way, signal) => attempt(way, signal, planned.browser, way.id), { hedgeAfterMs: deps.hedgeAfterMs, budgetMs: deps.budgetMs });
  if (!raced.doc) {
    const failure = explain(raced.attempts, resting, browser);
    if (failure.reason === 'not_found') await deps.store.set(missingKey, { reason: 'not_found', message: failure.message }, 300);
    throw failure;
  }
  let doc = raced.doc;
  let usedBrowser = planned.browser;

  // The second reading. Only when no real browser was used yet, the page looks thin, and there is time left.
  const firstLength = plainText(doc.content).length;
  const timeLeft = deadline - Date.now();
  if (!planned.browser && firstLength < PAGE.thinChars && timeLeft > 4_000) {
    // The way that just answered goes first when it can use a real browser: it is known to be reachable.
    const browserWay = [...ways].sort((a, b) => Number(b.id === doc.way) - Number(a.id === doc.way)).find((w) => w.browser && !w.own);
    if (browserWay) {
      const limit = AbortSignal.timeout(Math.min(PAGE.secondOpinionMs, timeLeft - 2_000));
      const second = await attempt(browserWay, limit, true, `${browserWay.id}, in a real browser`).catch(() => null);
      const secondLength = second ? plainText(second.content).length : 0;
      if (second && secondLength >= Math.max(firstLength * 1.5, firstLength + 200)) {
        second.notes.push('The first reading had very little text, so the page was read again in a real browser.');
        doc = second;
        usedBrowser = true;
      }
    }
  }

  await deps.store.set(cacheKey, doc, PAGE.cacheSec);
  // Remember what worked for this site, when it was not simply the first way on the list.
  const first = ways[0];
  const changed = remembered?.way !== doc.way || (remembered?.browser ?? false) !== usedBrowser;
  const worthIt = remembered !== null || usedBrowser !== browser || (first !== undefined && doc.way !== first.id);
  if (changed && worthIt) await deps.store.set(memoryKey, { way: doc.way, browser: usedBrowser } satisfies SiteMemory, 24 * 3_600);
  return { doc, cached: false };
}
