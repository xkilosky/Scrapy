/** Small pieces the helper files share. */
import { HelperError } from '../errors';
import { HttpFailure } from '../http';
import { RemoteFailure } from '../mcpCall';

/** Turns a network failure into a HelperError. Anything else is passed on as it is. */
export function asHelperError(helper: string, err: unknown): HelperError {
  if (err instanceof HelperError) return err;
  if (err instanceof HttpFailure) return new HelperError(helper, err.kind, err.message);
  if (err instanceof RemoteFailure) return new HelperError(helper, err.kind, err.message, err.retryAfterSec);
  return new HelperError(helper, 'failed', err instanceof Error ? err.message : String(err));
}

/** What to report when a helper says the page's own site answered with an error status. */
export function pageStatusError(helper: string, status: number): HelperError | null {
  if (status < 400) return null;
  if (status === 404 || status === 410) return new HelperError(helper, 'not_found', `the page does not exist (the site answered ${status})`);
  if (status === 401 || status === 407) return new HelperError(helper, 'login', `the page needs a login (the site answered ${status})`);
  if (status === 403 || status === 429 || status === 451) return new HelperError(helper, 'blocked', `the site refused the request (it answered ${status})`);
  if (status >= 500) return new HelperError(helper, 'failed', `the site itself is failing (it answered ${status})`);
  return new HelperError(helper, 'failed', `the site answered ${status}`);
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

export function obj(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** A host name without "www.", lower case. Accepts a bare domain or a full link. */
export function bareDomain(site: string): string {
  let s = site.trim().toLowerCase();
  s = s.replace(/^[a-z]+:\/\//, '');
  s = s.split(/[/?#]/)[0] ?? s;
  s = s.replace(/^www\./, '').replace(/:\d+$/, '');
  return s;
}

const STOP_WORDS = new Set(
  'a an and are as at be but by can do does for from how i if in is it its my of on or so that the their this to was what when where which who why will with you your'.split(' '),
);

/** Short keyword queries (at most six words each) made from a question. */
export function keywordQueries(question: string): string[] {
  const words = question
    .replace(/["“”'`()[\]{}]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length <= 6) return [words.join(' ')];
  const content = words.filter((w) => !STOP_WORDS.has(w.toLowerCase()));
  const pool = content.length >= 3 ? content : words;
  const out = [pool.slice(0, 6).join(' ')];
  if (pool.length > 6) out.push(pool.slice(-6).join(' '));
  return [...new Set(out)];
}
