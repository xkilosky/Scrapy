/**
 * Scrapy's own download of a page.
 *
 * NEVER used in the safe position. In the middle and full-speed positions this
 * is the way that contacts the page's own site, directly from the server
 * Scrapy runs on.
 *
 * It says honestly who it is, refuses private addresses (also after a
 * redirect), and stops at a size limit.
 */
import type { LookupFunction } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { PAGE, USER_AGENT } from '../config';
import { HelperError, ScrapyError } from '../errors';
import { checkPublicUrl, resolvePublicHost, type Resolver } from '../guard';
import type { Trace } from '../trace';
import { pageStatusError } from './shared';
import type { CallOptions, PageQuery, PageWay, RawPage } from './types';

const ID = 'own';
const MAX_REDIRECTS = 5;
const READABLE = /text\/html|application\/xhtml\+xml|text\/plain|text\/markdown|application\/xml|text\/xml/i;

export interface OwnOptions {
  resolver?: Resolver;
  /** Tests only: host names that skip the private-address check, so a test server on this machine can be reached. */
  allowHosts?: string[];
}

/** Ties a connection to addresses that were already checked, so the name cannot change its answer in between. */
function pinnedLookup(addresses: string[]): LookupFunction {
  const list = addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  return ((_hostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
    const first = list[0];
    if (!first) {
      callback(new Error('no address'));
      return;
    }
    if (typeof options === 'object' && options !== null && (options as { all?: boolean }).all) callback(null, list);
    else callback(null, first.address, first.family);
  }) as unknown as LookupFunction;
}

function decode(bytes: Uint8Array, contentType: string): string {
  let charset = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1];
  if (!charset) {
    // Look for <meta charset="..."> near the top of the page.
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 2_048));
    charset = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

async function readCapped(body: AsyncIterable<Uint8Array> | null, maxBytes: number): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    if (total + chunk.byteLength > maxBytes) {
      chunks.push(chunk.subarray(0, maxBytes - total));
      total = maxBytes;
      break;
    }
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return all;
}

export async function ownDownload(query: PageQuery, trace: Trace, opts: CallOptions, own: OwnOptions = {}): Promise<RawPage> {
  let current = new URL(query.url);
  const deadline = Date.now() + opts.timeoutMs;
  const allowed = (hostname: string): boolean => own.allowHosts?.includes(hostname) === true;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let addresses: string[] | null = null;
    if (!allowed(current.hostname)) {
      try {
        addresses = await resolvePublicHost(current.hostname, own.resolver);
      } catch (err) {
        if (err instanceof ScrapyError) throw new HelperError(ID, err.reason === 'not_found' ? 'not_found' : 'refused', err.message);
        throw err;
      }
    }
    const dispatcher = new Agent({ connect: addresses ? { lookup: pinnedLookup(addresses) } : {}, connectTimeout: 10_000 });
    const timer = AbortSignal.timeout(Math.max(1_000, deadline - Date.now()));
    const signal = opts.signal ? AbortSignal.any([timer, opts.signal]) : timer;
    const started = Date.now();
    const requested = current;
    let status: number | null = null;
    let note: string | undefined;
    try {
      const res = await undiciFetch(current, {
        method: 'GET',
        redirect: 'manual',
        dispatcher,
        signal,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
          'Accept-Language': 'en',
        },
      });
      status = res.status;

      if (status >= 300 && status < 400) {
        const location = res.headers.get('location');
        await res.body?.cancel().catch(() => undefined);
        if (!location) throw new HelperError(ID, 'failed', `the site answered ${status} without saying where to go`);
        try {
          // The new address is checked exactly like the first one.
          const next = new URL(location, current);
          current = allowed(next.hostname) ? next : checkPublicUrl(next.href);
        } catch (err) {
          throw new HelperError(ID, 'refused', err instanceof Error ? err.message : 'the page redirects to an address Scrapy refuses');
        }
        note = `redirect to ${current.host}`;
        continue;
      }

      const bad = pageStatusError(ID, status);
      if (bad) {
        await res.body?.cancel().catch(() => undefined);
        throw bad;
      }
      const contentType = res.headers.get('content-type') ?? '';
      if (contentType !== '' && !READABLE.test(contentType)) {
        await res.body?.cancel().catch(() => undefined);
        throw new HelperError(ID, 'not_a_page', `this link is a file (${contentType.split(';')[0]}), not a web page`);
      }
      const bytes = await readCapped(res.body as AsyncIterable<Uint8Array> | null, PAGE.maxOwnBytes);
      const text = decode(bytes, contentType);
      if (/text\/plain|text\/markdown/i.test(contentType)) return { finalUrl: requested.href, markdown: text, status };
      return { finalUrl: requested.href, rawHtml: text, status };
    } catch (err) {
      if (err instanceof HelperError) {
        note ??= err.message;
        throw err;
      }
      if (opts.signal?.aborted) {
        note = 'stopped, another way answered first';
        throw new HelperError(ID, 'cancelled', note);
      }
      if (timer.aborted) {
        note = `no answer after ${Math.round(opts.timeoutMs / 1000)} s`;
        throw new HelperError(ID, 'timeout', note);
      }
      const cause = (err as { cause?: { code?: string; message?: string } } | null)?.cause;
      note = cause?.code ?? cause?.message ?? (err instanceof Error ? err.message : 'network error');
      if (/ENOTFOUND|EAI_AGAIN/.test(note)) throw new HelperError(ID, 'not_found', 'the site does not exist (its name could not be looked up)');
      throw new HelperError(ID, 'unreachable', `the site could not be reached (${note})`);
    } finally {
      trace.contacts.push({
        purpose: 'own download',
        method: 'GET',
        address: `${requested.origin}${requested.pathname}`,
        host: requested.host,
        status,
        ms: Date.now() - started,
        ...(note ? { note } : {}),
      });
      void dispatcher.close().catch(() => undefined);
    }
  }
  throw new HelperError(ID, 'failed', `the page redirected more than ${MAX_REDIRECTS} times`);
}

export const ownPage: PageWay = {
  id: ID,
  name: "Scrapy's own download",
  hosts: [],
  formats: ['markdown', 'html'],
  browser: false,
  own: true,
  load: (query, trace, opts) => ownDownload(query, trace, opts),
};
