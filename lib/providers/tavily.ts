/**
 * Tavily, through its documented no-key door.
 * https://docs.tavily.com/documentation/keyless
 *
 * One header switches the door on. There is no account and no key. Search and
 * page reading are included. The allowance is shared and not published.
 */
import { REST } from '../config';
import { clip, HelperError } from '../errors';
import { httpCall, retryAfterSeconds, type HttpResult } from '../http';
import type { Trace } from '../trace';
import { arr, asHelperError, obj, str } from './shared';
import type { CallOptions, PageQuery, PageWay, RawHit, RawPage, SearchEngine, SearchQuery } from './types';

const BASE = 'https://api.tavily.com';
const HEADERS = { 'X-Tavily-Access-Mode': 'keyless', 'X-Client-Name': 'scrapy' };
const ID = 'tavily';

function failure(res: HttpResult): HelperError {
  const body = obj(res.json());
  // The no-key door reports its limits as { error: { code, message, retry_after_seconds } }.
  const envelope = obj(body?.error);
  if (envelope && typeof envelope.code === 'string') {
    const text = `${envelope.code} ${str(envelope.message) ?? ''}`;
    const wait = typeof envelope.retry_after_seconds === 'number' ? envelope.retry_after_seconds : undefined;
    if (/limit|cap|quota|rate|exceed|too many/i.test(text)) return new HelperError(ID, 'busy', clip(text, 160), wait);
    return new HelperError(ID, 'refused', clip(text, 160));
  }
  const detail = str(obj(body?.detail)?.error) ?? str(body?.detail) ?? str(body?.message) ?? clip(res.text, 160);
  if (res.status === 429 || res.status === 432 || res.status === 433) {
    return new HelperError(ID, 'busy', detail, retryAfterSeconds(res.headers) ?? REST.busySec);
  }
  if (res.status === 401 || res.status === 403) return new HelperError(ID, 'refused', detail);
  if (res.status >= 500) return new HelperError(ID, 'failed', `Tavily failed (${res.status})`);
  return new HelperError(ID, 'bad_response', `${res.status}: ${detail}`);
}

export function parseTavilySearch(body: unknown): RawHit[] {
  const hits: RawHit[] = [];
  for (const item of arr(obj(body)?.results)) {
    const r = obj(item);
    const url = str(r?.url);
    if (!r || !url) continue;
    hits.push({ url, title: str(r.title) ?? '', snippet: str(r.content) ?? '', ...(str(r.published_date) ? { published: str(r.published_date) } : {}) });
  }
  return hits;
}

async function search(query: SearchQuery, trace: Trace, opts: CallOptions): Promise<RawHit[]> {
  try {
    const res = await httpCall(trace, {
      url: `${BASE}/search`,
      headers: HEADERS,
      json: {
        query: query.query.slice(0, 400),
        max_results: Math.min(20, query.count),
        search_depth: 'basic',
        ...(query.includeSites.length > 0 ? { include_domains: query.includeSites } : {}),
        ...(query.excludeSites.length > 0 ? { exclude_domains: query.excludeSites } : {}),
        ...(query.recency ? { time_range: query.recency } : {}),
      },
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      purpose: 'tavily search',
    });
    trace.sample('tavily search', res.text);
    const body = res.json();
    if (res.status !== 200 || !Array.isArray(obj(body)?.results)) throw failure(res);
    return parseTavilySearch(body);
  } catch (err) {
    throw asHelperError(ID, err);
  }
}

export function parseTavilyExtract(body: unknown): RawPage {
  const root = obj(body);
  const first = obj(arr(root?.results)[0]);
  const content = str(first?.raw_content);
  if (first && content) {
    return { markdown: content, ...(str(first.url) ? { finalUrl: str(first.url) } : {}), ...(str(first.title) ? { title: str(first.title) } : {}) };
  }
  const failed = obj(arr(root?.failed_results)[0]);
  const why = str(failed?.error) ?? 'no content came back';
  if (/\b404\b|not found|does not exist/i.test(why)) throw new HelperError(ID, 'not_found', clip(why, 160));
  if (/\b(401|403|429)\b|forbidden|denied|blocked|captcha/i.test(why)) throw new HelperError(ID, 'blocked', clip(why, 160));
  if (/time|timed out/i.test(why)) throw new HelperError(ID, 'timeout', clip(why, 160));
  throw new HelperError(ID, 'failed', clip(why, 160));
}

async function load(query: PageQuery, trace: Trace, opts: CallOptions): Promise<RawPage> {
  try {
    const res = await httpCall(trace, {
      url: `${BASE}/extract`,
      headers: HEADERS,
      json: { urls: [query.url], format: 'markdown', extract_depth: query.browser ? 'advanced' : 'basic' },
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      purpose: 'tavily page',
    });
    trace.sample('tavily page', res.text);
    const body = res.json();
    if (res.status !== 200 || !obj(body) || (!Array.isArray(obj(body)?.results) && !Array.isArray(obj(body)?.failed_results))) throw failure(res);
    return parseTavilyExtract(body);
  } catch (err) {
    throw asHelperError(ID, err);
  }
}

export const tavilySearch: SearchEngine = { id: ID, name: 'Tavily', hosts: ['api.tavily.com'], siteFilter: true, search };

export const tavilyPage: PageWay = { id: ID, name: 'Tavily', hosts: ['api.tavily.com'], formats: ['markdown'], browser: false, own: false, load };
