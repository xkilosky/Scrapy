/**
 * Who may use Scrapy. There are three states.
 *
 * - personal: a password is set (SCRAPY_PASSWORD). Scrapy then answers to its
 *   owner alone, on every kind of address. The dashboard and the log are for a
 *   browser that has logged in. The MCP address is for an AI that sends the
 *   owner's key. See lib/owner.ts.
 * - open: no password, and the address is private anyway: a developer's own
 *   machine, or one of Vercel's test addresses, which Vercel shows only to
 *   people logged in to the owner's account. Everybody who gets there may use
 *   Scrapy. With SCRAPY_OPEN=1, Vercel's public address is open like this too.
 * - closed: no password, on Vercel's public address ("production"). A closed
 *   Scrapy answers every tool call with one sentence and contacts nobody.
 *
 * In every state, the home page and the docs can be read by anybody.
 */
import { ownerPassword } from './config';
import { carriesKey, loggedIn } from './owner';

export type Access = 'personal' | 'open' | 'closed';

export function access(): Access {
  if (ownerPassword().set) return 'personal';
  if (process.env.VERCEL_ENV === 'production' && process.env.SCRAPY_OPEN !== '1') return 'closed';
  return 'open';
}

export const CLOSED_TEXT = 'Scrapy is closed at this address. Its owner has not opened it yet.';
export const LOGIN_TEXT = 'This Scrapy is personal. Log in to use it.';
export const KEY_TEXT =
  'This Scrapy is personal: it answers only to its owner, and this request has no key, or a wrong one. Send the owner\'s key with every request, in the header "Authorization: Bearer <key>". The owner finds the key on the dashboard, under "The address for your agent".';

/** May this browser use the dashboard and what is behind it: the checks, the tools, the log? */
export function allowed(request: Request): boolean {
  const state = access();
  return state === 'open' || (state === 'personal' && loggedIn(request));
}

/** The answer of a closed Scrapy to one of its own pages. */
export function closedResponse(): Response {
  return Response.json({ ok: false, open: false, text: CLOSED_TEXT, error: CLOSED_TEXT }, { status: 403 });
}

/** The answer of a personal Scrapy to a page whose browser is not logged in. */
export function loginResponse(): Response {
  return Response.json({ ok: false, login: true, text: LOGIN_TEXT, error: LOGIN_TEXT }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
}

/** For the addresses behind the pages: the answer that turns this caller away, or null when the caller may go on. */
export function refusal(request: Request): Response | null {
  const state = access();
  if (state === 'closed') return closedResponse();
  if (state === 'personal' && !loggedIn(request)) return loginResponse();
  return null;
}

function mcpError(message: string): Response {
  return Response.json({ jsonrpc: '2.0', error: { code: -32001, message }, id: null }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
}

/** The answer of a closed Scrapy to an agent, in the form MCP expects for an error. */
export function closedMcpResponse(): Response {
  return mcpError(CLOSED_TEXT);
}

/**
 * The same for the MCP address. An agent has no login: only the key counts here.
 *
 * The answer is "403 Forbidden" also when the key is missing. With "401", many
 * AI apps start a login of their own (OAuth) that Scrapy does not have, and
 * the person sees that login fail instead of this sentence.
 */
export async function mcpRefusal(request: Request): Promise<Response | null> {
  const state = access();
  if (state === 'closed') return closedMcpResponse();
  if (state === 'personal' && !(await carriesKey(request))) return mcpError(KEY_TEXT);
  return null;
}
