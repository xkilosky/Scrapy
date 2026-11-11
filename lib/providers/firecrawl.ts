/**
 * Firecrawl, through its documented no-key door.
 * https://docs.firecrawl.dev/rate-limits
 *
 * A request with no Authorization header uses the free tier. Search and page
 * reading are included. The allowance is counted per internet address per day.
 */
import { clip, HelperError } from '../errors';
import { httpCall, retryAfterSeconds, type HttpResult } from '../http';
import type { Trace } from '../trace';
import { arr, asHelperError, obj, pageStatusError, str } from './shared';
import type { CallOptions, PageQuery, PageWay, RawHit, RawPage, Recency, SearchEngine, SearchQuery } from './types';

const BASE = 'https://api.firecrawl.dev/v2';
const ID = 'firecrawl';
const TBS: Record<Recency, string> = { day: 'qdr:d', week: 'qdr:w', month: 'qdr:m', year: 'qdr:y' };

function failure(res: HttpResult, job: 'search' | 'page'): HelperError {
  const body = obj(res.json());
  const message = str(body?.error) ?? str(body?.message) ?? clip(res.text, 160);
  const code = str(body?.code) ?? '';
  if (res.status === 429) return new HelperError(ID, 'busy', clip(message, 160), retryAfterSeconds(res.headers));
  // 402 means "allowance used up". Without a key it comes back by itself, so rest for an hour.
  if (res.status === 402) return new HelperError(ID, 'busy', clip(message, 160), 3_600);
  if (res.status === 401) return new HelperError(ID, 'refused', clip(message, 160));
  if (res.status === 403) {
    // For a page, 403 is Firecrawl declining that particular site.
    return new HelperError(ID, job === 'page' ? 'blocked' : 'refused', clip(message, 160));
  }
  if (res.status === 408 || /TIMEOUT/i.test(code)) return new HelperError(ID, 'timeout', clip(message, 160));
  if (/DNS/i.test(code) || /could not be resolved|ERR_NAME_NOT_RESOLVED/i.test(message)) {
    return new HelperError(ID, 'not_found', 'the site does not exist (its name could not be looked up)');
  }
  if (res.status >= 500) return new HelperError(ID, 'failed', clip(message || `Firecrawl failed (${res.status})`, 160));
  return new HelperError(ID, 'bad_response', clip(`${res.status}: ${message}`, 160));
}

export function parseFirecrawlSearch(body: unknown): RawHit[] {
  const data = obj(body)?.data;
  const items = Array.isArray(data) ? data : arr(obj(data)?.web);
  const hits: RawHit[] = [];
  for (const item of items) {
    const r = obj(item);
    const url = str(r?.url);
    if (!r || !url) continue;
    const meta = obj(r.metadata);
    hits.push({
      url,
      title: str(r.title) ?? str(meta?.title) ?? '',
      snippet: str(r.description) ?? str(r.snippet) ?? str(meta?.description) ?? '',
    });
  }
  return hits;
}

async function search(query: SearchQuery, trace: Trace, opts: CallOptions): Promise<RawHit[]> {
  try {
    // Firecrawl accepts a list of sites to include or to leave out, not both.
    const sites = query.includeSites.length > 0 ? { includeDomains: query.includeSites } : query.excludeSites.length > 0 ? { excludeDomains: query.excludeSites } : {};
    const res = await httpCall(trace, {
      url: `${BASE}/search`,
      json: { query: query.query.slice(0, 400), limit: Math.min(20, query.count), ...sites, ...(query.recency ? { tbs: TBS[query.recency] } : {}) },
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      purpose: 'firecrawl search',
    });
    trace.sample('firecrawl search', res.text);
    const body = obj(res.json());
    if (res.status !== 200 || !body || body.success !== true) throw failure(res, 'search');
    return parseFirecrawlSearch(body);
  } catch (err) {
    throw asHelperError(ID, err);
  }
}

export function parseFirecrawlScrape(body: unknown): RawPage {
  const data = obj(obj(body)?.data);
  if (!data) throw new HelperError(ID, 'bad_response', 'the answer had no page in it');
  const meta = obj(data.metadata) ?? {};
  const status = typeof meta.statusCode === 'number' ? meta.statusCode : undefined;
  if (status !== undefined) {
    const bad = pageStatusError(ID, status);
    if (bad) throw bad;
  }
  const markdown = str(data.markdown);
  const html = str(data.html);
  if (!markdown && !html) throw new HelperError(ID, 'empty', str(meta.error) ?? 'the page came back empty');
  const finalUrl = str(meta.url) ?? str(meta.sourceURL);
  return {
    ...(markdown ? { markdown } : {}),
    ...(html && !markdown ? { html } : {}),
    ...(finalUrl ? { finalUrl } : {}),
    ...(str(meta.title) ? { title: str(meta.title) } : {}),
    ...(str(meta.description) ? { description: str(meta.description) } : {}),
    ...(str(meta.language) ? { language: str(meta.language) } : {}),
    ...(str(meta.publishedTime) ? { published: str(meta.publishedTime) } : {}),
    ...(status !== undefined ? { status } : {}),
  };
}

async function load(query: PageQuery, trace: Trace, opts: CallOptions): Promise<RawPage> {
  try {
    const res = await httpCall(trace, {
      url: `${BASE}/scrape`,
      json: {
        url: query.url,
        formats: [query.format === 'html' ? 'html' : 'markdown'],
        onlyMainContent: true,
        blockAds: true,
        removeBase64Images: true,
        timeout: Math.max(5_000, opts.timeoutMs - 3_000),
        ...(query.browser ? { waitFor: 3_000 } : {}),
      },
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      purpose: 'firecrawl page',
    });
    trace.sample('firecrawl page', res.text);
    const body = obj(res.json());
    if (res.status !== 200 || !body || body.success !== true) throw failure(res, 'page');
    return parseFirecrawlScrape(body);
  } catch (err) {
    throw asHelperError(ID, err);
  }
}

export const firecrawlSearch: SearchEngine = { id: ID, name: 'Firecrawl', hosts: ['api.firecrawl.dev'], siteFilter: true, search };

export const firecrawlPage: PageWay = { id: ID, name: 'Firecrawl', hosts: ['api.firecrawl.dev'], formats: ['markdown', 'html'], browser: true, own: false, load };
