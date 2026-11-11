/**
 * Jina Reader. Put a link behind https://r.jina.ai/ and it returns the page as
 * Markdown, read in a real browser. Works with no key, at a lower speed limit.
 * https://github.com/jina-ai/reader
 */
import { clip, HelperError } from '../errors';
import { httpCall, retryAfterSeconds, type HttpResult } from '../http';
import type { Trace } from '../trace';
import { asHelperError, obj, pageStatusError, str } from './shared';
import type { CallOptions, PageQuery, PageWay, RawPage } from './types';

const BASE = 'https://r.jina.ai/';
const ID = 'jina';

function failure(res: HttpResult): HelperError {
  const body = obj(res.json());
  const code = typeof body?.code === 'number' ? body.code : res.status;
  const name = str(body?.name) ?? '';
  const message = str(body?.readableMessage) ?? str(body?.message) ?? clip(res.text, 160);
  const text = `${name} ${message}`;
  if (code === 429 || /RateLimit/i.test(name)) return new HelperError(ID, 'busy', clip(message, 160), retryAfterSeconds(res.headers));
  if (code === 402 || /InsufficientBalance/i.test(name)) return new HelperError(ID, 'busy', clip(message, 160), 3_600);
  if (code === 401) return new HelperError(ID, 'refused', clip(message, 160));
  if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND|could not be resolved|Invalid (TLD|url|domain)/i.test(text)) {
    return new HelperError(ID, 'not_found', 'the site does not exist (its name could not be looked up)');
  }
  if (code === 403 || code === 451 || /SecurityCompromise|blocked/i.test(text)) return new HelperError(ID, 'blocked', clip(message, 160));
  if (/timeout|timed out/i.test(text) || code === 504) return new HelperError(ID, 'timeout', clip(message, 160));
  if (code >= 500) return new HelperError(ID, 'failed', clip(message || `Jina failed (${code})`, 160));
  return new HelperError(ID, 'failed', clip(`${code}: ${message}`, 160));
}

export function parseJina(body: unknown, format: 'markdown' | 'html'): RawPage {
  const data = obj(obj(body)?.data);
  if (!data) throw new HelperError(ID, 'bad_response', 'the answer had no page in it');
  // Jina still returns the error page, with a warning such as "Target URL returned error 404: Not Found".
  const warning = str(data.warning) ?? '';
  const status = /returned error (\d{3})/i.exec(warning)?.[1];
  if (status) {
    const bad = pageStatusError(ID, Number(status));
    if (bad) throw bad;
  }
  const finalUrl = str(data.url);
  const common = {
    ...(finalUrl ? { finalUrl } : {}),
    ...(str(data.title) ? { title: str(data.title) } : {}),
    ...(str(data.description) ? { description: str(data.description) } : {}),
    ...(str(data.publishedTime) ? { published: str(data.publishedTime) } : {}),
  };
  if (format === 'html') {
    const html = str(data.html) ?? str(data.content);
    if (!html) throw new HelperError(ID, 'empty', 'the page came back empty');
    return { ...common, rawHtml: html };
  }
  const markdown = str(data.content) ?? str(data.text);
  if (!markdown) throw new HelperError(ID, 'empty', 'the page came back empty');
  return { ...common, markdown };
}

async function load(query: PageQuery, trace: Trace, opts: CallOptions): Promise<RawPage> {
  try {
    const res = await httpCall(trace, {
      url: `${BASE}${query.url}`,
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...(query.format === 'html' ? { 'X-Respond-With': 'html' } : {}),
        ...(query.browser ? { 'X-Engine': 'browser' } : {}),
      },
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      purpose: 'jina page',
    });
    trace.sample('jina page', res.text);
    const body = obj(res.json());
    if (!body) throw new HelperError(ID, 'bad_response', `${res.status}: ${clip(res.text, 120)}`);
    if (res.status !== 200 || !obj(body.data)) throw failure(res);
    return parseJina(body, query.format);
  } catch (err) {
    throw asHelperError(ID, err);
  }
}

export const jinaPage: PageWay = { id: ID, name: 'Jina Reader', hosts: ['r.jina.ai'], formats: ['markdown', 'html'], browser: true, own: false, load };
