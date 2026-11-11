/**
 * The only door to the network. Every outgoing request goes through here, so
 * every address Scrapy contacts ends up in the trace.
 */
import { USER_AGENT } from './config';
import type { Trace } from './trace';

export type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;

let override: FetchFn | null = null;

/** Tests replace the network with saved answers. Pass null to restore it. */
export function setFetch(fn: FetchFn | null): void {
  override = fn;
}

function currentFetch(): FetchFn {
  return override ?? ((input, init) => globalThis.fetch(input, init));
}

export class HttpFailure extends Error {
  readonly kind: 'timeout' | 'unreachable' | 'cancelled';

  constructor(kind: 'timeout' | 'unreachable' | 'cancelled', message: string) {
    super(message);
    this.name = 'HttpFailure';
    this.kind = kind;
  }
}

export interface HttpRequest {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  /** Sent as a JSON body. */
  json?: unknown;
  timeoutMs: number;
  /** Shown in the trace, for example "tavily search". */
  purpose: string;
  maxBytes?: number;
  /** Lets a caller give up early, for example when another way already answered. */
  signal?: AbortSignal;
}

export interface HttpResult {
  status: number;
  headers: Headers;
  text: string;
  ms: number;
  /** The body as JSON, or undefined when it is not JSON. */
  json(): unknown;
}

function describeNetworkError(err: unknown): string {
  const e = err as { message?: string; cause?: { code?: string; message?: string } } | null;
  return e?.cause?.code ?? e?.cause?.message ?? e?.message ?? 'network error';
}

function addressOf(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    if (total + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - total));
      total = maxBytes;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8').decode(all);
}

function withTimeout(timeoutMs: number, outer?: AbortSignal): { signal: AbortSignal; timedOut: () => boolean; done: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = outer ? AbortSignal.any([controller.signal, outer]) : controller.signal;
  return {
    signal,
    timedOut: () => controller.signal.aborted,
    done: () => clearTimeout(timer),
  };
}

export async function httpCall(trace: Trace, req: HttpRequest): Promise<HttpResult> {
  const started = Date.now();
  const url = new URL(req.url);
  const method = req.method ?? (req.json === undefined ? 'GET' : 'POST');
  const guard = withTimeout(req.timeoutMs, req.signal);
  let status: number | null = null;
  let note: string | undefined;
  try {
    const headers: Record<string, string> = { 'User-Agent': USER_AGENT, ...req.headers };
    if (req.json !== undefined && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    const res = await currentFetch()(req.url, {
      method,
      headers,
      body: req.json === undefined ? undefined : JSON.stringify(req.json),
      signal: guard.signal,
      redirect: 'follow',
    });
    status = res.status;
    const text = await readCapped(res, req.maxBytes ?? 8_000_000);
    return {
      status,
      headers: res.headers,
      text,
      ms: Date.now() - started,
      json() {
        try {
          return JSON.parse(text) as unknown;
        } catch {
          return undefined;
        }
      },
    };
  } catch (err) {
    if (guard.timedOut()) {
      note = `no answer after ${Math.round(req.timeoutMs / 1000)} s`;
      throw new HttpFailure('timeout', note);
    }
    if (req.signal?.aborted) {
      note = 'stopped, another way answered first';
      throw new HttpFailure('cancelled', note);
    }
    note = describeNetworkError(err);
    throw new HttpFailure('unreachable', note);
  } finally {
    guard.done();
    trace.contacts.push({ purpose: req.purpose, method, address: addressOf(url), host: url.host, status, ms: Date.now() - started, ...(note ? { note } : {}) });
  }
}

export interface TracedFetchOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  /** Called for every answer that is not a success, with the start of its body. */
  onBad?: (status: number, headers: Headers, body: string) => void;
}

/**
 * A fetch function for libraries that want their own (the MCP client). It
 * records every request in the trace like httpCall does.
 */
export function tracedFetch(trace: Trace, purpose: string, opts: TracedFetchOptions): FetchFn {
  return async (input, init) => {
    const started = Date.now();
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const outer = init?.signal ?? undefined;
    const signals = [outer, opts.signal].filter((s): s is AbortSignal => Boolean(s));
    const guard = withTimeout(opts.timeoutMs, signals.length > 0 ? AbortSignal.any(signals) : undefined);
    let status: number | null = null;
    let note: string | undefined;
    try {
      const headers = new Headers(init?.headers);
      if (!headers.has('User-Agent')) headers.set('User-Agent', USER_AGENT);
      const res = await currentFetch()(input, { ...init, headers, signal: guard.signal });
      status = res.status;
      if (!res.ok && opts.onBad) {
        const body = await res
          .clone()
          .text()
          .catch(() => '');
        opts.onBad(res.status, res.headers, body.slice(0, 600));
      }
      return res;
    } catch (err) {
      note = guard.timedOut() ? `no answer after ${Math.round(opts.timeoutMs / 1000)} s` : describeNetworkError(err);
      throw err;
    } finally {
      // The time limit covers the wait for the answer to start. The body may keep streaming after it.
      guard.done();
      trace.contacts.push({ purpose, method, address: addressOf(url), host: url.host, status, ms: Date.now() - started, ...(note ? { note } : {}) });
    }
  };
}

/** Seconds from a Retry-After header, or undefined. */
export function retryAfterSeconds(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (!raw) return undefined;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return Math.ceil(n);
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  return undefined;
}
