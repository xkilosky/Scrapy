/**
 * Behind the "Live feed": the log of tool calls.
 *
 * GET /api/logs            the calls that are kept, oldest first
 * GET /api/logs?rev=...    the same, or "nothing changed" when the rev still fits
 * GET /api/logs?id=...     the answer of one call, as the agent got it
 * GET /api/logs?probe=1    whether the shared memory that carries the log works here:
 *                          "works", "silent" (it does not give back what it was given),
 *                          "missing" (Vercel has not handed it to this server), or
 *                          "none" (there is none: not on Vercel, or switched off)
 *
 * The page asks every few seconds, so "nothing changed" is the common answer
 * and is kept as cheap as possible: one small read of the shared memory.
 */
import { closedResponse, isOpen } from '@/lib/access';
import { LOGS, logsOn, logsSetting, onVercel } from '@/lib/config';
import { getLogBook, isLogId } from '@/lib/logs';
import { sharedIsReal } from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function answer(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function GET(request: Request): Promise<Response> {
  if (!isOpen()) return closedResponse();
  if (!logsOn()) {
    // "public": off because this is a public address. "setting": switched off with SCRAPY_LOGS=off.
    return answer({ on: false, why: logsSetting() === 'off' ? 'setting' : 'public' });
  }
  const book = getLogBook();
  const query = new URL(request.url).searchParams;

  const id = query.get('id');
  if (id !== null) {
    const text = isLogId(id) ? await book.answer(id) : null;
    if (text === null) return answer({ on: true, found: false });
    // The shape an agent receives over MCP.
    return answer({ on: true, found: true, response: { content: [{ type: 'text', text }] } });
  }

  if (query.get('probe') === '1') {
    // "missing": on Vercel, but Vercel has not handed this server its shared memory. Asking the
    // stand-in that is used instead would only show that this server can talk to itself.
    const shared = onVercel() && process.env.SCRAPY_SHARED_CACHE !== 'off' && !sharedIsReal() ? 'missing' : await book.probe();
    return answer({ on: true, shared });
  }

  const { rev, entries } = await book.read(query.get('rev'));
  return answer({ on: true, rev, entries, keep: LOGS.keep, hours: LOGS.hours, where: onVercel() ? 'vercel' : 'memory' });
}
