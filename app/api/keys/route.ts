/**
 * Behind the "Keys" part of the dashboard: the owner makes a fresh key, sees
 * which keys are live, and turns a key off.
 *
 * Only a browser that has logged in may do this (refusal below), and a page
 * on another site is turned away, exactly like at "Log out". The key itself
 * is answerable only once, right when it is made: Scrapy keeps only its
 * seal-print in the book of keys.
 */
import { access, refusal } from '@/lib/access';
import { agentKey, fromAnotherSite, getKeyBook, keyPrint, mintKey } from '@/lib/owner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function answer(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function GET(request: Request): Promise<Response> {
  const turnedAway = refusal(request);
  if (turnedAway) return turnedAway;
  const first = agentKey();
  const book = getKeyBook();
  const mints = await book.list();
  return answer({
    ok: true,
    personal: access() === 'personal',
    first: first === null ? null : { print: keyPrint(first), off: await book.blocks(keyPrint(first)) },
    mints,
  });
}

export async function POST(request: Request): Promise<Response> {
  // A page on another site has no business making or turning off keys, logged in or not. The same rule as at "Log out".
  if (fromAnotherSite(request)) return answer({ ok: false, error: "Keys are made and turned off on Scrapy's own pages." }, 403);
  const turnedAway = refusal(request);
  if (turnedAway) return turnedAway;
  let body: { action?: unknown; note?: unknown; print?: unknown };
  try {
    body = (await request.json()) as { action?: unknown; note?: unknown; print?: unknown };
  } catch {
    return answer({ ok: false, error: 'The request was not readable.' }, 400);
  }
  if (body.action === 'make') {
    const key = await mintKey(typeof body.note === 'string' ? body.note : '');
    if (key === null) return answer({ ok: false, error: 'There is no password, so there are no keys.' }, 400);
    return answer({ ok: true, key, print: keyPrint(key) });
  }
  if (body.action === 'off') {
    const print = typeof body.print === 'string' ? body.print : '';
    if (print.length === 0 || print.length > 100) return answer({ ok: false, error: 'Which key?' }, 400);
    return answer({ ok: true, found: await getKeyBook().off(print) });
  }
  return answer({ ok: false, error: 'Unknown action.' }, 400);
}
