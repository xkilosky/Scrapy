/**
 * Calls one tool on somebody else's MCP server. Two of the free helpers (Exa
 * and Parallel) offer their no-key door only this way.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { waitUntil } from '@vercel/functions';
import { USER_AGENT, VERSION } from './config';
import { clip } from './errors';
import { retryAfterSeconds, tracedFetch } from './http';
import type { Trace } from './trace';

export interface RemoteAnswer {
  /** All text blocks of the answer, joined. */
  text: string;
  structured: unknown;
  isError: boolean;
  meta: Record<string, unknown>;
}

export type RemoteFailKind = 'busy' | 'refused' | 'timeout' | 'unreachable' | 'bad_response' | 'cancelled';

export class RemoteFailure extends Error {
  readonly kind: RemoteFailKind;
  readonly retryAfterSec: number | undefined;
  readonly status: number | null;

  constructor(kind: RemoteFailKind, message: string, status: number | null, retryAfterSec?: number) {
    super(message);
    this.name = 'RemoteFailure';
    this.kind = kind;
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }
}

export interface RemoteCall {
  endpoint: string;
  tool: string;
  args: Record<string, unknown>;
  timeoutMs: number;
  purpose: string;
  signal?: AbortSignal;
}

export async function callRemoteTool(trace: Trace, call: RemoteCall): Promise<RemoteAnswer> {
  const started = Date.now();
  const left = (): number => Math.max(1_000, call.timeoutMs - (Date.now() - started));
  let badStatus: number | null = null;
  let badBody = '';
  let retryAfter: number | undefined;

  const transport = new StreamableHTTPClientTransport(new URL(call.endpoint), {
    fetch: tracedFetch(trace, call.purpose, {
      timeoutMs: call.timeoutMs,
      signal: call.signal,
      onBad: (status, headers, body) => {
        // 405 is the normal answer of a server that keeps no open stream. It is not a failure.
        if (status === 405) return;
        badStatus = status;
        badBody = body;
        retryAfter = retryAfterSeconds(headers);
      },
    }),
    requestInit: { headers: { 'User-Agent': USER_AGENT } },
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1_000, maxReconnectionDelay: 1_000, reconnectionDelayGrowFactor: 1 },
  });
  const client = new Client({ name: 'scrapy', version: VERSION });

  try {
    await client.connect(transport, { timeout: left(), signal: call.signal });
    const result = await client.callTool({ name: call.tool, arguments: call.args }, { timeout: left(), maxTotalTimeout: left(), signal: call.signal });
    const blocks = Array.isArray(result.content) ? result.content : [];
    const text = blocks
      .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
      .filter(Boolean)
      .join('\n');
    return {
      text,
      structured: result.structuredContent,
      isError: result.isError === true,
      meta: (result._meta ?? {}) as Record<string, unknown>,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = badStatus as number | null;
    if (call.signal?.aborted) throw new RemoteFailure('cancelled', 'stopped, another way answered first', status);
    if (status === 429) throw new RemoteFailure('busy', clip(badBody || 'too many requests', 200), status, retryAfter);
    if (status === 401 || status === 403) throw new RemoteFailure('refused', clip(badBody || `refused (${status})`, 200), status);
    if (status !== null && status >= 500) throw new RemoteFailure('unreachable', `the service failed (${status})`, status);
    if (/tim(ed|e) ?out|aborted/i.test(message) || Date.now() - started >= call.timeoutMs - 50) {
      throw new RemoteFailure('timeout', `no answer after ${Math.round((Date.now() - started) / 1000)} s`, status);
    }
    if (status !== null) throw new RemoteFailure('bad_response', clip(`${status}: ${badBody || message}`, 200), status);
    if (/fetch failed|network|ECONN|ENOTFOUND|EAI_AGAIN|socket|certificate/i.test(message)) {
      const cause = (err as { cause?: { code?: string } } | null)?.cause?.code;
      throw new RemoteFailure('unreachable', cause ?? clip(message, 160), status);
    }
    throw new RemoteFailure('bad_response', clip(message, 200), status);
  } finally {
    // Say goodbye properly (a server that keeps sessions can then forget this one),
    // but do not make the caller wait for it.
    const goodbye = transport
      .terminateSession()
      .catch(() => undefined)
      .then(() => client.close())
      .catch(() => undefined);
    try {
      waitUntil(goodbye);
    } catch {
      // Not running on Vercel. The goodbye still happens, nobody waits for it.
    }
  }
}
