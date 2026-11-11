/**
 * Open or closed.
 *
 * On Vercel, Scrapy's public address (Vercel calls it "production") stays
 * closed until the owner opens it with the setting SCRAPY_OPEN=1. A closed
 * Scrapy answers every tool call with one sentence and contacts nobody.
 *
 * Test addresses are always open: Vercel shows them only to people logged in
 * to the owner's account. A developer's own machine is always open too.
 */
export function isOpen(): boolean {
  if (process.env.VERCEL_ENV !== 'production') return true;
  return process.env.SCRAPY_OPEN === '1';
}

export const CLOSED_TEXT = 'Scrapy is closed at this address. Its owner has not opened it yet.';

/** The answer of a closed Scrapy to the check page. */
export function closedResponse(): Response {
  return Response.json({ ok: false, open: false, text: CLOSED_TEXT, error: CLOSED_TEXT }, { status: 403 });
}

/** The answer of a closed Scrapy to an agent, in the form MCP expects for an error. */
export function closedMcpResponse(): Response {
  return Response.json({ jsonrpc: '2.0', error: { code: -32001, message: CLOSED_TEXT }, id: null }, { status: 403 });
}
