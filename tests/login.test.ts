/**
 * Logging in and out: the two addresses behind the login page.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { POST as login } from '@/app/api/login/route';
import { POST as logout } from '@/app/api/logout/route';
import { GET as status } from '@/app/api/status/route';
import { POST as tryTool } from '@/app/api/try/route';
import { CLOSED_TEXT } from '@/lib/access';
import { agentKey, LOGIN_LIMITS, resetLoginGuard, SESSION_COOKIE, SESSION_DAYS, sessionFits } from '@/lib/owner';

const PASSWORD = 'four quiet green rivers';

beforeEach(() => {
  process.env.SCRAPY_PASSWORD = PASSWORD;
  resetLoginGuard();
});

afterEach(() => {
  delete process.env.SCRAPY_PASSWORD;
  delete process.env.VERCEL_ENV;
  delete process.env.SCRAPY_OPEN;
});

/** A login request as Scrapy's own login page sends it. */
function typed(password: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://scrapy.test/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', 'x-real-ip': '198.51.100.1', ...headers },
    body: JSON.stringify({ password }),
  });
}

/** The pass in the cookie that an answer sets, or null. */
function passOf(response: Response): string | null {
  const cookie = response.headers.get('set-cookie');
  return cookie?.startsWith(`${SESSION_COOKIE}=`) ? (cookie.slice(SESSION_COOKIE.length + 1).split(';')[0] ?? null) : null;
}

const said = async (response: Response): Promise<string> => ((await response.json()) as { error?: string }).error ?? '';

describe('logging in', () => {
  it('hands the browser a pass for the right password, and the pass opens the dashboard', async () => {
    const answer = await login(typed(PASSWORD));
    expect(answer.status).toBe(200);
    expect(answer.headers.get('cache-control')).toBe('no-store');
    const cookie = answer.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`Max-Age=${SESSION_DAYS * 24 * 3600}`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('Path=/');
    const pass = passOf(answer);
    expect(sessionFits(pass)).toBe(true);
    // The answer itself says "ok" and nothing more: no key, no password.
    expect(await answer.json()).toEqual({ ok: true });

    const browser = { cookie: `${SESSION_COOKIE}=${pass ?? ''}`, 'sec-fetch-site': 'same-origin' };
    const info = (await (await status(new Request('https://scrapy.test/api/status', { headers: browser }))).json()) as Record<string, unknown>;
    expect(info).toMatchObject({ access: 'personal', allowed: true, key: agentKey() });
    const tried = await tryTool(new Request('https://scrapy.test/api/try', { method: 'POST', headers: { ...browser, 'content-type': 'application/json' }, body: JSON.stringify({ tool: 'fetch_url', args: { url: 'http://localhost/' } }) }));
    expect(tried.status).toBe(200);
  });

  it('forgives spaces around the password, which a pasted password often has', async () => {
    expect((await login(typed(`  ${PASSWORD}\n`))).status).toBe(200);
  });

  it('turns a wrong password away, with no pass', async () => {
    for (const wrong of [PASSWORD.slice(0, -1), `${PASSWORD}!`, PASSWORD.toUpperCase(), 'x'.repeat(5_000)]) {
      resetLoginGuard();
      const answer = await login(typed(wrong));
      expect(answer.status, wrong.slice(0, 30)).toBe(401);
      expect(answer.headers.get('set-cookie')).toBeNull();
      expect(await said(answer)).toBe('That is not the password.');
    }
  });

  it('does not take the key of an AI for the password', async () => {
    const answer = await login(typed(agentKey()));
    expect(answer.status).toBe(401);
    expect(answer.headers.get('set-cookie')).toBeNull();
  });

  it('asks for the password when none was typed, and does not count that as a guess', async () => {
    for (let i = 0; i < LOGIN_LIMITS.perCaller + 2; i++) {
      for (const nothing of ['', '   ', null, 12345, ['a'], { a: 1 }]) {
        const answer = await login(typed(nothing));
        expect(answer.status).toBe(400);
        expect(await said(answer)).toBe('Type the password.');
        expect(answer.headers.get('set-cookie')).toBeNull();
      }
    }
    const unreadable = await login(new Request('https://scrapy.test/api/login', { method: 'POST', headers: { 'sec-fetch-site': 'same-origin', 'x-real-ip': '198.51.100.1' }, body: 'password=abc' }));
    expect(unreadable.status).toBe(400);
    expect(await said(unreadable)).toBe('The request was not readable.');
    // After all of that, the right password still works at once.
    expect((await login(typed(PASSWORD))).status).toBe(200);
  });

  it(`makes an address wait after ${LOGIN_LIMITS.perCaller} wrong passwords, even with the right one, and lets other addresses in`, async () => {
    for (let i = 0; i < LOGIN_LIMITS.perCaller; i++) expect((await login(typed(`wrong guess ${i}`))).status).toBe(401);
    const sixth = await login(typed('wrong again'));
    expect(sixth.status).toBe(429);
    expect(sixth.headers.get('retry-after')).toBe(String(LOGIN_LIMITS.callerMinutes * 60));
    expect(await said(sixth)).toBe(`Too many wrong passwords. Try again in about ${LOGIN_LIMITS.callerMinutes} minutes.`);

    // The wait holds for the right password too. Otherwise the wait would tell a guesser nothing, and cost nothing.
    const right = await login(typed(PASSWORD));
    expect(right.status).toBe(429);
    expect(right.headers.get('set-cookie')).toBeNull();

    // The owner, at another address, is not held up by it.
    expect((await login(typed(PASSWORD, { 'x-real-ip': '198.51.100.2' }))).status).toBe(200);
  });

  it('counts guesses sent in the same moment like guesses sent one by one', async () => {
    const answers = await Promise.all(Array.from({ length: 40 }, (_, i) => login(typed(`guess number ${i}`))));
    const codes = answers.map((a) => a.status);
    expect(codes.filter((c) => c === 401)).toHaveLength(LOGIN_LIMITS.perCaller);
    expect(codes.filter((c) => c === 429)).toHaveLength(40 - LOGIN_LIMITS.perCaller);
    expect(answers.every((a) => a.headers.get('set-cookie') === null)).toBe(true);
  });

  it('does not let the right password through in a burst once the tries are used up', async () => {
    // The right password is the last of many sent together. It gets no pass: the wait is on.
    const answers = await Promise.all([...Array.from({ length: 20 }, (_, i) => login(typed(`guess number ${i}`))), login(typed(PASSWORD))]);
    expect(answers[answers.length - 1]?.status).toBe(429);
    expect(answers.some((a) => a.headers.get('set-cookie') !== null)).toBe(false);
  });

  it('starts counting again after the right password', async () => {
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < LOGIN_LIMITS.perCaller - 1; i++) expect((await login(typed('a wrong one'))).status).toBe(401);
      expect((await login(typed(PASSWORD))).status).toBe(200);
    }
  });

  it(`pauses for everybody after ${LOGIN_LIMITS.everyone} wrong passwords from many addresses`, async () => {
    for (let i = 0; i < LOGIN_LIMITS.everyone; i++) {
      expect((await login(typed('guess', { 'x-real-ip': `203.0.${Math.floor(i / 4)}.${i % 4}` }))).status, `guess ${i}`).toBe(401);
    }
    const next = await login(typed(PASSWORD, { 'x-real-ip': '198.51.100.99' }));
    expect(next.status).toBe(429);
    expect(next.headers.get('retry-after')).toBe(String(LOGIN_LIMITS.everyoneMinutes * 60));
    expect(next.headers.get('set-cookie')).toBeNull();
  });

  it('does not log a browser in from a page of another site', async () => {
    for (const headers of [{ 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }]) {
      const answer = await login(typed(PASSWORD, headers));
      expect(answer.status).toBe(403);
      expect(answer.headers.get('set-cookie')).toBeNull();
    }
    const older = await login(new Request('https://scrapy.test/api/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify({ password: PASSWORD }) }));
    expect(older.status).toBe(403);
    expect(older.headers.get('set-cookie')).toBeNull();
  });

  it('says so when the password that was set is too short to be used', async () => {
    process.env.SCRAPY_PASSWORD = 'short';
    const answer = await login(typed('short'));
    expect(answer.status).toBe(503);
    expect(answer.headers.get('set-cookie')).toBeNull();
    expect(await said(answer)).toContain('too short');
    expect(await said(await login(typed('short')))).toContain('at least 10 characters');
  });

  it('has nothing to log in to where there is no password', async () => {
    delete process.env.SCRAPY_PASSWORD;
    const open = await login(typed('anything'));
    expect(open.status).toBe(400);
    expect(open.headers.get('set-cookie')).toBeNull();
    expect(await said(open)).toBe('This Scrapy has no password, so there is nothing to log in to.');
    // Not even with an empty password, or with the word a missing setting turns into.
    for (const nothing of ['', 'undefined', 'null']) expect(passOf(await login(typed(nothing)))).toBeNull();

    process.env.VERCEL_ENV = 'production';
    const closed = await login(typed('anything'));
    expect(closed.status).toBe(403);
    expect(closed.headers.get('set-cookie')).toBeNull();
    expect(await said(closed)).toBe(CLOSED_TEXT);
  });
});

describe('logging out', () => {
  it('takes the pass back', async () => {
    const answer = await logout(new Request('https://scrapy.test/api/logout', { method: 'POST' }));
    expect(answer.status).toBe(200);
    expect(answer.headers.get('set-cookie')).toBe(`${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax; Secure`);
    expect(await answer.json()).toEqual({ ok: true });
  });

  it('cannot be done to the owner by a page of another site', async () => {
    for (const headers of [{ 'sec-fetch-site': 'cross-site' }, { origin: 'https://evil.example' }] as Record<string, string>[]) {
      const answer = await logout(new Request('https://scrapy.test/api/logout', { method: 'POST', headers }));
      expect(answer.status).toBe(403);
      expect(answer.headers.get('set-cookie')).toBeNull();
    }
  });
});
