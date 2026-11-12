/**
 * Behind the login page. Takes the password, and hands the browser its pass.
 *
 * There is one password and no user name: a personal Scrapy has one owner.
 */
import { access, closedResponse } from '@/lib/access';
import { ownerPassword, PASSWORD_MIN } from '@/lib/config';
import { waitText } from '@/lib/errors';
import { visitorOf } from '@/lib/limits';
import { fromAnotherSite, getLoginGuard, newSession, passwordFits, sessionCookie } from '@/lib/owner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function no(status: number, error: string, headers: Record<string, string> = {}): Response {
  return Response.json({ ok: false, error }, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

export async function POST(request: Request): Promise<Response> {
  const state = access();
  if (state === 'closed') return closedResponse();
  if (state === 'open') return no(400, 'This Scrapy has no password, so there is nothing to log in to.');
  if (fromAnotherSite(request)) return no(403, "Log in from Scrapy's own login page.");
  if (!ownerPassword().usable) {
    return no(503, `The password set for this Scrapy is too short, so nobody can log in. Its owner has to set one of at least ${PASSWORD_MIN} characters, in the setting SCRAPY_PASSWORD.`);
  }

  let typed: unknown;
  try {
    typed = ((await request.json()) as { password?: unknown } | null)?.password;
  } catch {
    return no(400, 'The request was not readable.');
  }
  if (typeof typed !== 'string' || typed.trim() === '') return no(400, 'Type the password.');

  const caller = visitorOf(request);
  const guard = getLoginGuard();
  // The try is counted before the password is looked at. Guesses sent in the same moment are counted like any others.
  const waitSec = await guard.enter(caller);
  if (waitSec > 0) return no(429, `Too many wrong passwords. Try again ${waitText(waitSec)}.`, { 'Retry-After': String(waitSec) });

  // A password is never longer than this. Anything longer is not worth the comparison.
  if (typed.length > 1_000 || !passwordFits(typed)) {
    await guard.wrong(caller);
    return no(401, 'That is not the password.');
  }
  await guard.right(caller);
  const pass = newSession();
  if (!pass) return no(503, 'The login is not set up.');
  return Response.json({ ok: true }, { headers: { 'Set-Cookie': sessionCookie(pass, request), 'Cache-Control': 'no-store' } });
}
