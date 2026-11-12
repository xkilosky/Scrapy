/**
 * The fresh keys of the owner: made on the dashboard, shown once, booked by
 * their seal-print, and turned off there. And the address behind it,
 * /api/keys.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GET as listKeys, POST as keysPost } from '@/app/api/keys/route';
import { agentKey, createKeyBook, getKeyBook, keyFits, keyPrint, makeKey, mintKey, newSession, resetKeyBook, SESSION_COOKIE } from '@/lib/owner';
import type { SharedLayer } from '@/lib/store';

const PASSWORD = 'four quiet green rivers';
const OTHER = 'a brand new password';

beforeEach(() => {
  process.env.SCRAPY_PASSWORD = PASSWORD;
  resetKeyBook();
});

afterEach(() => {
  delete process.env.SCRAPY_PASSWORD;
  delete process.env.VERCEL_ENV;
  delete process.env.SCRAPY_OPEN;
  resetKeyBook();
});

/** A request as the logged-in browser of the owner sends it. */
async function owned(path: string, init: RequestInit = {}): Promise<Request> {
  const pass = newSession() ?? '';
  return new Request(`https://scrapy.test${path}`, {
    ...init,
    headers: { cookie: `${SESSION_COOKIE}=${pass}`, 'sec-fetch-site': 'same-origin', ...(init.headers ?? {}) },
  });
}

describe('a fresh key', () => {
  it('is a new random one every time, and each one fits', async () => {
    const a = makeKey() ?? '';
    const b = makeKey() ?? '';
    expect(a).toMatch(/^scrapy_/);
    expect(a).not.toBe(b);
    expect(a).not.toBe(agentKey());
    expect(await keyFits(a)).toBe(true);
    expect(await keyFits(b)).toBe(true);
    expect(await keyFits(a.slice(0, -1) + (a.endsWith('A') ? 'B' : 'A'))).toBe(false);
    // The key is not booked at "make": booking happens in mintKey only.
    expect((await createKeyBook().list()).length).toBe(0);
  });

  it('keeps nothing that would give it away: not the key, not the password', async () => {
    const key = (await mintKey('Claude on my laptop')) ?? '';
    expect(key.startsWith('scrapy_')).toBe(true);
    expect(key).not.toContain(PASSWORD);
    // The book holds the seal-print and the note, never the key.
    const book = await getKeyBook().list();
    expect(book.length).toBe(1);
    expect(book[0]?.note).toBe('Claude on my laptop');
    expect(book[0]?.print).toBe(keyPrint(key));
    expect(book[0]?.off).toBe(false);
    expect(book[0]?.print.length).toBeGreaterThan(30);
  });

  it('stops working when the password changes, like every key', async () => {
    const key = (await mintKey('Cursor')) ?? '';
    expect(await keyFits(key)).toBe(true);
    process.env.SCRAPY_PASSWORD = OTHER;
    expect(await keyFits(key)).toBe(false);
  });

  it('stops working the moment it is turned off, but only that one', async () => {
    const book = getKeyBook();
    const mine = (await mintKey('one')) ?? '';
    const other = (await mintKey('two')) ?? '';
    const first = agentKey() ?? '';
    expect(await book.off(keyPrint(mine))).toBe(true);
    expect(await keyFits(mine)).toBe(false);
    expect(await keyFits(other)).toBe(true);
    expect(await keyFits(first)).toBe(true);
    // Turning it off twice is harmless, and there is nothing to find for one that is not in the book.
    expect(await book.off(keyPrint(mine))).toBe(true);
    expect(await book.off(keyPrint('scrapy_nevermade'))).toBe(false);
  });

  it('is turned off on every copy of Scrapy at once, through the shared book', async () => {
    // Two servers, sharing one memory, as on Vercel.
    const memory = new Map<string, unknown>();
    const layer: SharedLayer = {
      get: async (k) => memory.get(k) ?? null,
      set: async (k, v) => void memory.set(k, v),
      delete: async (k) => void memory.delete(k),
    };
    const a = createKeyBook(async () => layer);
    const b = createKeyBook(async () => layer);
    const key = makeKey() ?? '';
    await a.remember(keyPrint(key), 'server A minted it');
    // Without any new word from A, B's book already holds the mint.
    expect((await b.list()).some((e) => e.print === keyPrint(key) && e.note === 'server A minted it' && e.off === false)).toBe(true);
    // B reads the shared memory, knows the key as live — and must not trust that reading forever.
    expect(await b.blocks(keyPrint(key))).toBe(false);
    expect(await keyFits(key)).toBe(true);
    await a.off(keyPrint(key));
    expect(await b.blocks(keyPrint(key))).toBe(true);
    // B learned from the shared memory, and remembers the note too.
    expect((await b.list()).map((e) => e.note)).toEqual(['server A minted it']);
  });

  it('the first key can be turned off too, for when it got out', async () => {
    const book = getKeyBook();
    const first = agentKey() ?? '';
    expect(await book.off(keyPrint(first))).toBe(false); // never minted: nothing to turn off
    await book.remember(keyPrint(first), 'the first key');
    expect(await book.off(keyPrint(first))).toBe(true);
    expect(await keyFits(first)).toBe(false);
    const fresh = (await mintKey('fresh')) ?? '';
    expect(await keyFits(fresh)).toBe(true);
  });
});

describe('the keys address', () => {
  it('asks a stranger to log in first', async () => {
    const answer = await listKeys(new Request('https://scrapy.test/api/keys'));
    expect(answer.status).toBe(401);
    expect(((await answer.json()) as { login?: boolean }).login).toBe(true);
    const posted = await keysPost(new Request('https://scrapy.test/api/keys', { method: 'POST', body: '{"action":"make"}' }));
    expect(posted.status).toBe(401);
  });

  it('lists the first key and the made ones to the logged-in owner', async () => {
    const made = await keysPost(await owned('/api/keys', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'make', note: 'Claude' }) }));
    expect(made.status).toBe(200);
    const { ok, key, print } = (await made.json()) as { ok: boolean; key: string; print: string };
    expect(ok).toBe(true);
    expect(key).toMatch(/^scrapy_/);
    expect(print).toBe(keyPrint(key));

    const answer = await listKeys(await owned('/api/keys'));
    const body = (await answer.json()) as { ok: boolean; first: { print: string; off: boolean }; mints: { print: string; note: string; off: boolean }[] };
    expect(answer.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.first.print).toBe(keyPrint(agentKey() ?? ''));
    expect(body.first.off).toBe(false);
    expect(body.mints.length).toBe(1);
    expect(body.mints[0]).toMatchObject({ print, note: 'Claude', off: false });
    // The key itself is in no answer after its making.
    expect(JSON.stringify(body)).not.toContain(key);
  });

  it('turns a key off for the owner, and the key opens nothing afterwards', async () => {
    const made = (await (await keysPost(await owned('/api/keys', { method: 'POST', body: JSON.stringify({ action: 'make', note: '' }) }))).json()) as { key: string; print: string };
    expect(await keyFits(made.key)).toBe(true);
    const off = await keysPost(await owned('/api/keys', { method: 'POST', body: JSON.stringify({ action: 'off', print: made.print }) }));
    expect(off.status).toBe(200);
    expect(((await off.json()) as { found: boolean }).found).toBe(true);
    expect(await keyFits(made.key)).toBe(false);
    const again = (await (await keysPost(await owned('/api/keys', { method: 'POST', body: JSON.stringify({ action: 'off', print: made.print }) }))).json()) as { found: boolean };
    expect(again.found).toBe(true); // still in the book, still off
  });

  it('answers a page of another site with 403, logged in or not', async () => {
    const cross = { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' };
    const answer = await keysPost(await owned('/api/keys', { method: 'POST', headers: { ...cross }, body: JSON.stringify({ action: 'make' }) }));
    expect(answer.status).toBe(403);
  });

  it('has no keys where there is no password', async () => {
    delete process.env.SCRAPY_PASSWORD;
    process.env.SCRAPY_OPEN = '1';
    const answer = await listKeys(new Request('https://scrapy.test/api/keys'));
    expect(((await answer.json()) as { personal: boolean }).personal).toBe(false);
    const made = await keysPost(new Request('https://scrapy.test/api/keys', { method: 'POST', headers: { 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ action: 'make' }) }));
    expect(made.status).toBe(400);
    expect(((await made.json()) as { error?: string }).error).toContain('no password');
  });

  it('refuses what it does not know', async () => {
    const answer = await keysPost(await owned('/api/keys', { method: 'POST', body: '{"action":"dream"}' }));
    expect(answer.status).toBe(400);
    const bad = await keysPost(await owned('/api/keys', { method: 'POST', body: 'not json' }));
    expect(bad.status).toBe(400);
  });
});
