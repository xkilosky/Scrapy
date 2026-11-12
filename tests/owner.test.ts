/**
 * The owner of a personal Scrapy: the password, the key for an AI, the pass
 * of a browser, and the brake on guessing.
 */
import { createHmac, scryptSync } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { ownerPassword, PASSWORD_MIN } from '@/lib/config';
import {
  agentKey,
  carriesKey,
  cookieOf,
  createLoginGuard,
  type LoginGuard,
  fromAnotherSite,
  keyFits,
  keyFrom,
  keysFrom,
  loggedIn,
  LOGIN_LIMITS,
  newSession,
  noSessionCookie,
  passwordFits,
  SESSION_COOKIE,
  SESSION_DAYS,
  sessionCookie,
  sessionFits,
} from '@/lib/owner';
import type { SharedLayer } from '@/lib/store';

const PASSWORD = 'four quiet green rivers';
const OTHER = 'another long password';

afterEach(() => {
  delete process.env.SCRAPY_PASSWORD;
  delete process.env.SCRAPY_FRAMED;
  delete process.env.VERCEL;
});

const get = (path = '/api/logs', headers: Record<string, string> = {}): Request => new Request(`https://scrapy.test${path}`, { headers });

describe('the password', () => {
  it('is the setting SCRAPY_PASSWORD, without the spaces around it', () => {
    expect(ownerPassword()).toEqual({ set: false, usable: false, value: '' });
    process.env.SCRAPY_PASSWORD = '   ';
    expect(ownerPassword().set).toBe(false);
    process.env.SCRAPY_PASSWORD = `  ${PASSWORD}\n`;
    expect(ownerPassword()).toEqual({ set: true, usable: true, value: PASSWORD });
  });

  it(`cannot be used when it is shorter than ${PASSWORD_MIN} characters`, () => {
    process.env.SCRAPY_PASSWORD = 'x'.repeat(PASSWORD_MIN - 1);
    expect(ownerPassword()).toMatchObject({ set: true, usable: false });
    expect(passwordFits('x'.repeat(PASSWORD_MIN - 1))).toBe(false);
    expect(agentKey()).toBeNull();
    expect(newSession()).toBeNull();
    process.env.SCRAPY_PASSWORD = 'x'.repeat(PASSWORD_MIN);
    expect(ownerPassword().usable).toBe(true);
    expect(passwordFits('x'.repeat(PASSWORD_MIN))).toBe(true);
  });

  it('fits only when it is typed exactly, give or take the spaces around it', () => {
    process.env.SCRAPY_PASSWORD = PASSWORD;
    expect(passwordFits(PASSWORD)).toBe(true);
    expect(passwordFits(` ${PASSWORD} `)).toBe(true);
    expect(passwordFits(PASSWORD.toUpperCase())).toBe(false);
    expect(passwordFits(PASSWORD.slice(0, -1))).toBe(false);
    expect(passwordFits(`${PASSWORD}x`)).toBe(false);
    expect(passwordFits('')).toBe(false);
  });

  it('never fits while no password is set, not even nothing', () => {
    expect(passwordFits('')).toBe(false);
    expect(passwordFits('undefined')).toBe(false);
    process.env.SCRAPY_PASSWORD = '';
    expect(passwordFits('')).toBe(false);
  });
});

describe('the key for an AI', () => {
  it('stays the same from one release to the next: an update does not lock an AI out', () => {
    // Written down once, for this password. A change to how the key is made shows up here.
    process.env.SCRAPY_PASSWORD = PASSWORD;
    expect(agentKey()).toBe('scrapy_aH0p9YJ6U3gFOFNcqbrbU3mVEVQOHwOO');
  });

  it('is made apart from what signs a pass: the key tells nothing about a pass', () => {
    process.env.SCRAPY_PASSWORD = PASSWORD;
    // Worked out here once more, step by step, the way lib/owner.ts describes it.
    const stretched = scryptSync(PASSWORD, 'scrapy owner v1', 32, { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const forKey = createHmac('sha256', stretched).update('scrapy agent key v1').digest();
    const forPass = createHmac('sha256', stretched).update('scrapy session v1').digest();
    expect(agentKey()).toBe(`scrapy_${forKey.toString('base64url').slice(0, 32)}`);

    const body = `1.${Math.floor(Date.now() / 1000) + 3_600}.abcdefghijkl`;
    const signedWith = (secret: Buffer): string => `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
    // Only the pass's own secret signs a pass.
    expect(sessionFits(signedWith(forPass))).toBe(true);
    // Not what the key is made of, not the key itself, not the password.
    expect(sessionFits(signedWith(forKey))).toBe(false);
    expect(sessionFits(signedWith(Buffer.from(agentKey() ?? '')))).toBe(false);
    expect(sessionFits(signedWith(Buffer.from(PASSWORD)))).toBe(false);
    expect(sessionFits(signedWith(stretched))).toBe(false);
  });

  it('is made from the password: the same each time, and another one for another password', () => {
    process.env.SCRAPY_PASSWORD = PASSWORD;
    const key = agentKey() ?? '';
    expect(key).toMatch(/^scrapy_[A-Za-z0-9_-]{32}$/);
    expect(agentKey()).toBe(key);
    process.env.SCRAPY_PASSWORD = OTHER;
    const other = agentKey() ?? '';
    expect(other).toMatch(/^scrapy_[A-Za-z0-9_-]{32}$/);
    expect(other).not.toBe(key);
    // Back to the first password: the first key again. Nothing is stored anywhere.
    process.env.SCRAPY_PASSWORD = PASSWORD;
    expect(agentKey()).toBe(key);
  });

  it('does not give the password away', () => {
    process.env.SCRAPY_PASSWORD = PASSWORD;
    const key = agentKey() ?? '';
    expect(key).not.toContain(PASSWORD);
    expect(key).not.toContain(Buffer.from(PASSWORD).toString('base64url').slice(0, 8));
  });

  it('fits only as a whole, and never while no password is set', async () => {
    expect(agentKey()).toBeNull();
    expect(await keyFits(null)).toBe(false);
    expect(await keyFits('')).toBe(false);
    expect(await keyFits('scrapy_')).toBe(false);
    expect(await keyFits('null')).toBe(false);

    process.env.SCRAPY_PASSWORD = PASSWORD;
    const key = agentKey() ?? '';
    expect(await keyFits(key)).toBe(true);
    expect(await keyFits(key.slice(0, -1))).toBe(false);
    expect(await keyFits(`${key}x`)).toBe(false);
    expect(await keyFits(key.toUpperCase())).toBe(false);
    expect(await keyFits(null)).toBe(false);
    expect(await keyFits('')).toBe(false);
    // The password itself is not the key.
    expect(await keyFits(PASSWORD)).toBe(false);

    process.env.SCRAPY_PASSWORD = OTHER;
    expect(await keyFits(key)).toBe(false);
  });

  it('is read from the Authorization header, from x-scrapy-key, or from the end of the address', () => {
    expect(keyFrom(get('/api/mcp'))).toBeNull();
    expect(keyFrom(get('/api/mcp', { authorization: 'Bearer abc' }))).toBe('abc');
    expect(keyFrom(get('/api/mcp', { authorization: 'bearer   abc  ' }))).toBe('abc');
    expect(keyFrom(get('/api/mcp', { 'x-scrapy-key': ' def ' }))).toBe('def');
    expect(keyFrom(get('/api/mcp?key=ghi'))).toBe('ghi');
    // The header comes first, then Scrapy's own header, then the address.
    expect(keyFrom(get('/api/mcp?key=ghi', { authorization: 'Bearer abc', 'x-scrapy-key': 'def' }))).toBe('abc');
    expect(keyFrom(get('/api/mcp?key=ghi', { 'x-scrapy-key': 'def' }))).toBe('def');
    // Another kind of Authorization is not a key.
    expect(keyFrom(get('/api/mcp', { authorization: 'Basic abc' }))).toBeNull();
    expect(keyFrom(get('/api/mcp', { authorization: 'Bearer' }))).toBeNull();
    expect(keyFrom(get('/api/mcp?key=ghi', { authorization: 'Basic abc' }))).toBe('ghi');
    expect(keysFrom(get('/api/mcp?key=ghi', { authorization: 'Bearer abc', 'x-scrapy-key': 'def' }))).toEqual(['abc', 'def', 'ghi']);
    expect(keysFrom(get('/api/mcp?key=', { authorization: 'Bearer ', 'x-scrapy-key': '  ' }))).toEqual([]);
  });

  it('is enough in one of the three places, whatever an app puts into the others', async () => {
    process.env.SCRAPY_PASSWORD = PASSWORD;
    const key = agentKey() ?? '';
    expect(await carriesKey(get('/api/mcp', { authorization: `Bearer ${key}` }))).toBe(true);
    expect(await carriesKey(get('/api/mcp', { 'x-scrapy-key': key }))).toBe(true);
    expect(await carriesKey(get(`/api/mcp?key=${key}`))).toBe(true);
    // An app that sends a token of its own in the Authorization header, with the owner's key at the end of the address.
    expect(await carriesKey(get(`/api/mcp?key=${key}`, { authorization: 'Bearer some-token-of-the-app' }))).toBe(true);
    expect(await carriesKey(get('/api/mcp?key=wrong', { authorization: 'Bearer wrong', 'x-scrapy-key': key }))).toBe(true);
    // No right key anywhere: no.
    expect(await carriesKey(get('/api/mcp'))).toBe(false);
    expect(await carriesKey(get('/api/mcp?key=wrong', { authorization: 'Bearer wrong', 'x-scrapy-key': 'wrong' }))).toBe(false);
    expect(await carriesKey(get(`/api/mcp?other=${key}`, { cookie: `key=${key}`, 'x-key': key, authorization: `Basic ${key}` }))).toBe(false);
    // And never while there is no usable password.
    process.env.SCRAPY_PASSWORD = 'short';
    expect(await carriesKey(get('/api/mcp?key=', { authorization: 'Bearer null' }))).toBe(false);
    delete process.env.SCRAPY_PASSWORD;
    expect(await carriesKey(get(`/api/mcp?key=${key}`))).toBe(false);
  });
});

describe('the pass of a browser', () => {
  const NOW = Date.parse('2026-11-12T12:00:00Z');
  const DAY = 24 * 3_600_000;

  it(`is good for ${SESSION_DAYS} days, and not a second longer`, () => {
    process.env.SCRAPY_PASSWORD = PASSWORD;
    const pass = newSession(NOW) ?? '';
    expect(pass).toMatch(/^1\.\d+\.[A-Za-z0-9_-]{12}\.[A-Za-z0-9_-]{43}$/);
    expect(sessionFits(pass, NOW)).toBe(true);
    expect(sessionFits(pass, NOW + SESSION_DAYS * DAY - 1_000)).toBe(true);
    expect(sessionFits(pass, NOW + SESSION_DAYS * DAY)).toBe(false);
    expect(sessionFits(pass, NOW + 400 * DAY)).toBe(false);
  });

  it('is different every time, and each one fits', () => {
    process.env.SCRAPY_PASSWORD = PASSWORD;
    const a = newSession(NOW) ?? '';
    const b = newSession(NOW) ?? '';
    expect(a).not.toBe(b);
    expect(sessionFits(a, NOW)).toBe(true);
    expect(sessionFits(b, NOW)).toBe(true);
  });

  it('cannot be made longer, or made up', async () => {
    process.env.SCRAPY_PASSWORD = PASSWORD;
    const pass = newSession(NOW) ?? '';
    const [version, expires, nonce, mark] = pass.split('.') as [string, string, string, string];

    // A later end, with the old mark.
    expect(sessionFits([version, String(Number(expires) + 1), nonce, mark].join('.'), NOW)).toBe(false);
    // An end that never comes.
    expect(sessionFits([version, '99999999999', nonce, mark].join('.'), NOW)).toBe(false);
    expect(sessionFits([version, 'Infinity', nonce, mark].join('.'), NOW)).toBe(false);
    // Another mark, no mark, another version.
    expect(sessionFits([version, expires, nonce, `${mark.slice(0, -1)}${mark.endsWith('A') ? 'B' : 'A'}`].join('.'), NOW)).toBe(false);
    expect(sessionFits([version, expires, nonce, ''].join('.'), NOW)).toBe(false);
    expect(sessionFits([version, expires, nonce].join('.'), NOW)).toBe(false);
    expect(sessionFits(['2', expires, nonce, mark].join('.'), NOW)).toBe(false);
    // Nothing, rubbish, and something very long.
    for (const junk of [null, undefined, '', '.', '...', 'abc', '1.2.3.4', 'x'.repeat(5_000)]) expect(sessionFits(junk, NOW), String(junk).slice(0, 20)).toBe(false);
    // The key of an AI is not a pass, and a pass is not a key.
    expect(sessionFits(agentKey(), NOW)).toBe(false);
    expect(await keyFits(pass)).toBe(false);
  });

  it('ends for every browser when the password changes', () => {
    process.env.SCRAPY_PASSWORD = PASSWORD;
    const pass = newSession(NOW) ?? '';
    process.env.SCRAPY_PASSWORD = OTHER;
    expect(sessionFits(pass, NOW)).toBe(false);
    delete process.env.SCRAPY_PASSWORD;
    expect(sessionFits(pass, NOW)).toBe(false);
    process.env.SCRAPY_PASSWORD = PASSWORD;
    expect(sessionFits(pass, NOW)).toBe(true);
  });

  it('travels in a cookie that scripts cannot read and other sites cannot send', () => {
    const cookie = sessionCookie('PASS', get('/api/login'));
    expect(cookie).toBe(`${SESSION_COOKIE}=PASS; Max-Age=${SESSION_DAYS * 24 * 3600}; Path=/; HttpOnly; SameSite=Lax; Secure`);
    // On a developer's machine there is no https. A browser would drop a Secure cookie there.
    expect(sessionCookie('PASS', new Request('http://localhost:3000/api/login'))).toBe(`${SESSION_COOKIE}=PASS; Max-Age=${SESSION_DAYS * 24 * 3600}; Path=/; HttpOnly; SameSite=Lax`);
    // Behind a proxy, the proxy says how the browser came.
    expect(sessionCookie('PASS', new Request('http://10.0.0.5:3000/api/login', { headers: { 'x-forwarded-proto': 'https' } }))).toContain('; Secure');
    // On Vercel it is always https.
    process.env.VERCEL = '1';
    expect(sessionCookie('PASS', new Request('http://internal/api/login'))).toContain('; Secure');
  });

  it('is taken back by "Log out" with a cookie of the same kind that ends at once', () => {
    expect(noSessionCookie(get('/api/logout'))).toBe(`${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax; Secure`);
  });

  it('with SCRAPY_FRAMED=1, uses the kind of cookie a browser lets into a frame, but never on Vercel', () => {
    process.env.SCRAPY_FRAMED = '1';
    expect(sessionCookie('PASS', new Request('http://localhost:3000/api/login'))).toBe(`${SESSION_COOKIE}=PASS; Max-Age=${SESSION_DAYS * 24 * 3600}; Path=/; HttpOnly; SameSite=None; Secure; Partitioned`);
    expect(noSessionCookie(new Request('http://localhost:3000/api/logout'))).toBe(`${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=None; Secure; Partitioned`);
    process.env.VERCEL = '1';
    expect(sessionCookie('PASS', get('/api/login'))).toContain('SameSite=Lax; Secure');
    expect(sessionCookie('PASS', get('/api/login'))).not.toContain('Partitioned');
  });

  it('is found among the other cookies of a request', () => {
    expect(cookieOf(get('/', { cookie: `a=1; ${SESSION_COOKIE}=1.2.3.4; b=2` }), SESSION_COOKIE)).toBe('1.2.3.4');
    expect(cookieOf(get('/', { cookie: `${SESSION_COOKIE}=only` }), SESSION_COOKIE)).toBe('only');
    expect(cookieOf(get('/', { cookie: `x${SESSION_COOKIE}=no; ${SESSION_COOKIE}x=no` }), SESSION_COOKIE)).toBeNull();
    expect(cookieOf(get('/', { cookie: 'a=1' }), SESSION_COOKIE)).toBeNull();
    expect(cookieOf(get('/'), SESSION_COOKIE)).toBeNull();
  });
});

describe('a request from another site', () => {
  it('is told apart by what the browser says about it', () => {
    // Scrapy's own page, or an address typed in.
    expect(fromAnotherSite(get('/api/try', { 'sec-fetch-site': 'same-origin' }))).toBe(false);
    expect(fromAnotherSite(get('/api/logs', { 'sec-fetch-site': 'none' }))).toBe(false);
    // Another site, and also another address that only shares the last part of its name.
    expect(fromAnotherSite(get('/api/try', { 'sec-fetch-site': 'cross-site' }))).toBe(true);
    expect(fromAnotherSite(get('/api/try', { 'sec-fetch-site': 'same-site' }))).toBe(true);
  });

  it('with an older browser, is told apart by the page the request came from', () => {
    expect(fromAnotherSite(get('/api/try', { origin: 'https://scrapy.test' }))).toBe(false);
    expect(fromAnotherSite(get('/api/try', { origin: 'https://evil.example' }))).toBe(true);
    expect(fromAnotherSite(get('/api/try', { origin: 'null' }))).toBe(true);
    // Behind a proxy, Scrapy sees an inner address. The proxy passes on the name the browser used.
    expect(fromAnotherSite(new Request('http://10.0.0.5:3000/api/try', { headers: { origin: 'https://my-scrapy.example', 'x-forwarded-host': 'my-scrapy.example' } }))).toBe(false);
    expect(fromAnotherSite(new Request('http://10.0.0.5:3000/api/try', { headers: { origin: 'https://evil.example', 'x-forwarded-host': 'my-scrapy.example' } }))).toBe(true);
    // Nothing said at all: a plain GET of an older browser, or a program. The cookie decides.
    expect(fromAnotherSite(get('/api/logs'))).toBe(false);
  });

  it('does not count as logged in, even with the pass', () => {
    process.env.SCRAPY_PASSWORD = PASSWORD;
    const cookie = `${SESSION_COOKIE}=${newSession() ?? ''}`;
    expect(loggedIn(get('/api/try', { cookie, 'sec-fetch-site': 'same-origin' }))).toBe(true);
    expect(loggedIn(get('/api/try', { cookie }))).toBe(true);
    expect(loggedIn(get('/api/try', { cookie, 'sec-fetch-site': 'cross-site' }))).toBe(false);
    expect(loggedIn(get('/api/try', { cookie, origin: 'https://evil.example' }))).toBe(false);
    // And without the pass, nobody is.
    expect(loggedIn(get('/api/try', { 'sec-fetch-site': 'same-origin' }))).toBe(false);
    expect(loggedIn(get('/api/try', { cookie: `${SESSION_COOKIE}=1.99999999999.abc.def` }))).toBe(false);
    // The key of an AI does not log a browser in.
    expect(loggedIn(get('/api/try', { authorization: `Bearer ${agentKey() ?? ''}` }))).toBe(false);
  });
});

describe('the brake on guessing the password', () => {
  const MINUTE = 60_000;

  /** A stand-in for Vercel's shared memory, with a clock. */
  function sharedMemory(now: () => number): SharedLayer & { size(): number } {
    const kept = new Map<string, { value: unknown; until: number }>();
    return {
      async get(key) {
        const hit = kept.get(key);
        return hit && hit.until > now() ? hit.value : null;
      },
      async set(key, value, ttlSec) {
        kept.set(key, { value, until: now() + ttlSec * 1000 });
      },
      async delete(key) {
        kept.delete(key);
      },
      size: () => kept.size,
    };
  }

  /** One wrong password from this caller, as the login address handles it. Answers the wait it was told, 0 when it got a try. */
  async function guess(guard: LoginGuard, caller: string): Promise<number> {
    const waitSec = await guard.enter(caller);
    if (waitSec === 0) await guard.wrong(caller);
    return waitSec;
  }

  it(`makes one address wait after ${LOGIN_LIMITS.perCaller} wrong passwords, and leaves the others alone`, async () => {
    let t = 1_000_000;
    const guard = createLoginGuard(async () => null, () => t);
    for (let i = 0; i < LOGIN_LIMITS.perCaller; i++) {
      expect(await guard.wait('1.1.1.1')).toBe(0);
      expect(await guess(guard, '1.1.1.1')).toBe(0);
    }
    expect(await guard.wait('1.1.1.1')).toBe(LOGIN_LIMITS.callerMinutes * 60);
    expect(await guard.enter('1.1.1.1')).toBe(LOGIN_LIMITS.callerMinutes * 60);
    expect(await guard.wait('2.2.2.2')).toBe(0);
    expect(await guard.enter('2.2.2.2')).toBe(0);

    // The wait gets shorter, and ends.
    t += 5 * MINUTE;
    expect(await guard.wait('1.1.1.1')).toBe((LOGIN_LIMITS.callerMinutes - 5) * 60);
    t += (LOGIN_LIMITS.callerMinutes - 5) * MINUTE;
    expect(await guard.wait('1.1.1.1')).toBe(0);
    expect(await guard.enter('1.1.1.1')).toBe(0);
  });

  it('does not count a refused try: waiting does not make the wait longer', async () => {
    let t = 1_000_000;
    const guard = createLoginGuard(async () => null, () => t);
    for (let i = 0; i < LOGIN_LIMITS.perCaller; i++) await guess(guard, '1.1.1.1');
    t += 14 * MINUTE;
    for (let i = 0; i < 50; i++) expect(await guard.enter('1.1.1.1')).toBe((LOGIN_LIMITS.callerMinutes - 14) * 60);
    t += MINUTE;
    expect(await guard.enter('1.1.1.1')).toBe(0);
  });

  it('gives guesses sent in the same moment no more tries than guesses sent one by one', async () => {
    // Each look at the shared memory takes a moment, like on Vercel. All fifty requests are inside that moment together.
    const slow: SharedLayer = {
      get: async () => {
        await new Promise((r) => setTimeout(r, 5));
        return null;
      },
      set: async () => undefined,
      delete: async () => undefined,
    };
    const guard = createLoginGuard(async () => slow);
    const answers = await Promise.all(Array.from({ length: 50 }, () => guess(guard, '1.1.1.1')));
    expect(answers.filter((waitSec) => waitSec === 0)).toHaveLength(LOGIN_LIMITS.perCaller);
    expect(answers.filter((waitSec) => waitSec > 0)).toHaveLength(50 - LOGIN_LIMITS.perCaller);

    // The same from many addresses at once: the count for everybody holds too.
    const many = createLoginGuard(async () => slow);
    const all = await Promise.all(Array.from({ length: 400 }, (_, i) => guess(many, `10.0.${Math.floor(i / 200)}.${i % 200}`)));
    expect(all.filter((waitSec) => waitSec === 0)).toHaveLength(LOGIN_LIMITS.everyone);
  });

  it('costs the shared memory next to nothing when the login is hammered', async () => {
    const t = 1_000_000;
    let reads = 0;
    let writes = 0;
    const counted: SharedLayer = {
      get: async () => {
        reads += 1;
        await new Promise((r) => setTimeout(r, 2));
        return null;
      },
      set: async () => void (writes += 1),
      delete: async () => void (writes += 1),
    };
    const guard = createLoginGuard(async () => counted, () => t);

    // A hundred guesses in the same moment share one look at each of the two counts.
    await Promise.all(Array.from({ length: 100 }, () => guess(guard, '1.1.1.1')));
    expect(reads).toBe(2);
    // Only the guesses that were looked at are written down: two small writes each.
    expect(writes).toBe(LOGIN_LIMITS.perCaller * 2);

    // From now on this caller has to wait. Nothing is read and nothing is written for it, however often it asks.
    reads = 0;
    writes = 0;
    for (let i = 0; i < 500; i++) expect(await guard.enter('1.1.1.1')).toBeGreaterThan(0);
    for (let i = 0; i < 500; i++) expect(await guard.wait('1.1.1.1')).toBeGreaterThan(0);
    expect(reads).toBe(0);
    expect(writes).toBe(0);

    // The same once the login is paused for everybody: callers never seen before cost nothing either.
    const paused = createLoginGuard(async () => counted, () => t);
    for (let i = 0; i < LOGIN_LIMITS.everyone; i++) await guess(paused, `10.1.${Math.floor(i / 4)}.${i % 4}`);
    reads = 0;
    writes = 0;
    for (let i = 0; i < 500; i++) expect(await paused.enter(`172.16.0.${i}`)).toBeGreaterThan(0);
    expect(reads).toBe(0);
    expect(writes).toBe(0);
  });

  it('counts a try from the moment it starts, also while its password is still being looked at', async () => {
    const guard = createLoginGuard(async () => null);
    // Five tries are booked, none has ended yet.
    for (let i = 0; i < LOGIN_LIMITS.perCaller; i++) expect(await guard.enter('1.1.1.1')).toBe(0);
    expect(await guard.enter('1.1.1.1')).toBeGreaterThan(0);
  });

  it('starts the count of an address again after the right password', async () => {
    const guard = createLoginGuard(async () => null);
    for (let i = 0; i < LOGIN_LIMITS.perCaller - 1; i++) await guess(guard, '1.1.1.1');
    expect(await guard.enter('1.1.1.1')).toBe(0);
    await guard.right('1.1.1.1');
    for (let i = 0; i < LOGIN_LIMITS.perCaller - 1; i++) expect(await guess(guard, '1.1.1.1')).toBe(0);
    expect(await guard.wait('1.1.1.1')).toBe(0);
    await guess(guard, '1.1.1.1');
    expect(await guard.wait('1.1.1.1')).toBeGreaterThan(0);
  });

  it('gives the try of a right password back: logging in does not use up the tries of everybody', async () => {
    const guard = createLoginGuard(async () => null);
    // The owner logs in many times, from many places. None of it counts.
    for (let i = 0; i < LOGIN_LIMITS.everyone * 3; i++) {
      expect(await guard.enter(`home ${i % 7}`), `login ${i}`).toBe(0);
      await guard.right(`home ${i % 7}`);
    }
    expect(await guard.wait('anybody')).toBe(0);
  });

  it(`pauses the login for everybody after ${LOGIN_LIMITS.everyone} wrong passwords, however many addresses they came from`, async () => {
    let t = 1_000_000;
    const guard = createLoginGuard(async () => null, () => t);
    // A guesser who changes address before any address has to wait.
    for (let i = 0; i < LOGIN_LIMITS.everyone; i++) {
      const caller = `10.0.${Math.floor(i / 4)}.${i % 4}`;
      expect(await guard.wait(caller), `guess ${i}`).toBe(0);
      expect(await guess(guard, caller)).toBe(0);
    }
    expect(await guard.wait('10.9.9.9')).toBe(LOGIN_LIMITS.everyoneMinutes * 60);
    expect(await guard.enter('the owner')).toBe(LOGIN_LIMITS.everyoneMinutes * 60);
    // Nothing a caller does lifts the pause, not even saying "that was right" without a try to its name.
    await guard.right('the owner');
    await guard.right('10.0.0.1');
    expect(await guard.wait('the owner')).toBeGreaterThan(0);
    t += LOGIN_LIMITS.everyoneMinutes * MINUTE;
    expect(await guard.wait('the owner')).toBe(0);
    expect(await guard.enter('the owner')).toBe(0);
  });

  it('counts together with the other servers, through the shared memory', async () => {
    const t = 1_000_000;
    const shared = sharedMemory(() => t);
    const one = createLoginGuard(async () => shared, () => t);
    const two = createLoginGuard(async () => shared, () => t);
    // The guesses land on two servers in turn. Neither sees five of them itself.
    for (let i = 0; i < LOGIN_LIMITS.perCaller; i++) expect(await guess(i % 2 === 0 ? one : two, '1.1.1.1')).toBe(0);
    expect(await one.wait('1.1.1.1')).toBeGreaterThan(0);
    expect(await two.wait('1.1.1.1')).toBeGreaterThan(0);
    expect(await two.enter('1.1.1.1')).toBeGreaterThan(0);
    // A third server that has never seen this address knows too.
    expect(await createLoginGuard(async () => shared, () => t).enter('1.1.1.1')).toBeGreaterThan(0);
    // The right password clears the count for all of them.
    const fresh = sharedMemory(() => t);
    const a = createLoginGuard(async () => fresh, () => t);
    const b = createLoginGuard(async () => fresh, () => t);
    for (let i = 0; i < LOGIN_LIMITS.perCaller - 1; i++) await guess(a, '3.3.3.3');
    expect(await b.enter('3.3.3.3')).toBe(0);
    await b.right('3.3.3.3');
    expect(await guess(b, '3.3.3.3')).toBe(0);
    expect(await b.wait('3.3.3.3')).toBe(0);
  });

  it('never counts less because the shared memory says less', async () => {
    const t = 1_000_000;
    let behind: unknown = null;
    const shared: SharedLayer = { get: async () => behind, set: async () => undefined, delete: async () => undefined };
    const guard = createLoginGuard(async () => shared, () => t);
    // Four wrong passwords, counted here. The shared memory is behind: it has heard of one only.
    for (let i = 0; i < LOGIN_LIMITS.perCaller - 1; i++) expect(await guess(guard, '1.1.1.1')).toBe(0);
    behind = { n: 1, until: t + 60 * MINUTE };
    // The next one is this caller's fifth and last try, not its second.
    expect(await guess(guard, '1.1.1.1')).toBe(0);
    expect(await guard.enter('1.1.1.1')).toBe(LOGIN_LIMITS.callerMinutes * 60);
    expect(await guard.wait('1.1.1.1')).toBe(LOGIN_LIMITS.callerMinutes * 60);
    // And it counts more when the shared memory says more.
    behind = { n: LOGIN_LIMITS.everyone, until: t + 7 * MINUTE };
    expect(await guard.enter('2.2.2.2')).toBe(7 * 60);
  });

  it('keeps no internet address in the shared memory, only a mark made from it', async () => {
    const t = 1_000_000;
    const names: string[] = [];
    const shared: SharedLayer = {
      get: async () => null,
      set: async (key) => void names.push(key),
      delete: async () => undefined,
    };
    await guess(createLoginGuard(async () => shared, () => t), '203.0.113.77');
    expect(names).toHaveLength(2);
    expect(names.join(' ')).not.toContain('203.0.113.77');
    expect(names[0]).toMatch(/^login:[0-9a-f]{24}$/);
    expect(names[1]).toBe('login:all');
  });

  it('does not take a count from the shared memory that is not one, or that has run out', async () => {
    const t = 1_000_000;
    for (const stored of ['99', 99, { n: '99', until: t + MINUTE }, { n: 99 }, { n: 99, until: t - 1 }, null, [99]]) {
      const odd: SharedLayer = { get: async () => stored, set: async () => undefined, delete: async () => undefined };
      expect(await createLoginGuard(async () => odd, () => t).enter('1.1.1.1'), JSON.stringify(stored)).toBe(0);
    }
    const real: SharedLayer = { get: async () => ({ n: 99, until: t + MINUTE }), set: async () => undefined, delete: async () => undefined };
    expect(await createLoginGuard(async () => real, () => t).enter('1.1.1.1')).toBe(60);
  });

  it('still brakes when the shared memory fails', async () => {
    const broken: SharedLayer = {
      get: async () => {
        throw new Error('down');
      },
      set: async () => {
        throw new Error('down');
      },
      delete: async () => {
        throw new Error('down');
      },
    };
    for (const shared of [async () => broken, async () => Promise.reject(new Error('no layer'))]) {
      const guard = createLoginGuard(shared as () => Promise<SharedLayer | null>);
      for (let i = 0; i < LOGIN_LIMITS.perCaller; i++) expect(await guess(guard, '1.1.1.1')).toBe(0);
      expect(await guard.wait('1.1.1.1')).toBeGreaterThan(0);
      expect(await guard.enter('1.1.1.1')).toBeGreaterThan(0);
      await guard.right('1.1.1.1');
      expect(await guard.wait('1.1.1.1')).toBe(0);
    }
  });
});
