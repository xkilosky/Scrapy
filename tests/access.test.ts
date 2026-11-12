/**
 * Who may use Scrapy: its owner alone (personal), everybody who gets to it
 * (open), or nobody for now (closed). And what each address answers in each case.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { GET as docs } from '@/app/api/docs/route';
import { GET as logs } from '@/app/api/logs/route';
import { GET as status } from '@/app/api/status/route';
import { POST as check } from '@/app/api/check/route';
import { POST as mcp } from '@/app/api/mcp/route';
import { POST as tryTool } from '@/app/api/try/route';
import { GET as llms } from '@/app/llms.txt/route';
import { access, allowed, CLOSED_TEXT, KEY_TEXT, LOGIN_TEXT } from '@/lib/access';
import { logsOn } from '@/lib/config';
import { addressLine, rulebook } from '@/lib/docs';
import { setFetch } from '@/lib/http';
import { agentKey, newSession, SESSION_COOKIE } from '@/lib/owner';

const PASSWORD = 'four quiet green rivers';

afterEach(() => {
  delete process.env.VERCEL_ENV;
  delete process.env.SCRAPY_OPEN;
  delete process.env.SCRAPY_PASSWORD;
  delete process.env.SCRAPY_LOGS;
  setFetch(null);
});

/** The headers a request is sent with. */
type Sent = Record<string, string>;

const post = (path: string, body: unknown, headers: Sent = {}): Request =>
  new Request(`https://scrapy.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body) });
const get = (path: string, headers: Sent = {}): Request => new Request(`https://scrapy.test${path}`, { headers });

const LIST = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
const SEARCH = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_web', arguments: { query: 'x' } } };
const READ_LOCAL = { tool: 'fetch_url', args: { url: 'http://localhost/' } };

/** The cookie of a browser that has logged in, as that browser sends it from Scrapy's own page. */
const browser = (): Sent => ({ cookie: `${SESSION_COOKIE}=${newSession() ?? ''}`, 'sec-fetch-site': 'same-origin' });
const withKey = (): Sent => ({ authorization: `Bearer ${agentKey() ?? ''}` });

/** Every address Scrapy would contact is written down, and answered with nothing. */
function watchTheNetwork(): string[] {
  const contacted: string[] = [];
  setFetch(async (input) => {
    contacted.push(String(input));
    return new Response('{}');
  });
  return contacted;
}

/** The names of the tools in an answer of the MCP address, which comes as JSON or as an event stream. */
async function toolNames(response: Response): Promise<string[]> {
  const text = await response.text();
  const data = JSON.parse(text.split('\n').find((line) => line.startsWith('data: '))?.slice(6) ?? text) as { result: { tools: { name: string }[] } };
  return data.result.tools.map((t) => t.name);
}

describe('the three states', () => {
  it('is open on a test address and on a developer machine, as long as there is no password', () => {
    expect(access()).toBe('open');
    process.env.VERCEL_ENV = 'preview';
    expect(access()).toBe('open');
    process.env.VERCEL_ENV = 'development';
    expect(access()).toBe('open');
  });

  it('is closed on the public address until the owner does something', () => {
    process.env.VERCEL_ENV = 'production';
    expect(access()).toBe('closed');
    process.env.SCRAPY_OPEN = '0';
    expect(access()).toBe('closed');
    process.env.SCRAPY_OPEN = 'yes';
    expect(access()).toBe('closed');
    process.env.SCRAPY_OPEN = '1';
    expect(access()).toBe('open');
  });

  it('is personal wherever a password is set, whatever else is set', () => {
    process.env.SCRAPY_PASSWORD = PASSWORD;
    expect(access()).toBe('personal');
    for (const env of ['production', 'preview', 'development']) {
      process.env.VERCEL_ENV = env;
      expect(access(), env).toBe('personal');
    }
    // "Open to everybody" does not win over a password.
    process.env.VERCEL_ENV = 'production';
    process.env.SCRAPY_OPEN = '1';
    expect(access()).toBe('personal');
    expect(allowed(get('/api/logs'))).toBe(false);
  });

  it('is personal, and lets nobody in, with a password too short to be used', async () => {
    process.env.SCRAPY_PASSWORD = 'short';
    expect(access()).toBe('personal');
    expect(agentKey()).toBeNull();
    const contacted = watchTheNetwork();
    for (const headers of [{}, { authorization: 'Bearer ' }, { authorization: 'Bearer null' }, { authorization: 'Bearer short' }, { 'x-scrapy-key': '' }] as Sent[]) {
      expect((await mcp(post('/api/mcp', SEARCH, headers))).status, JSON.stringify(headers)).toBe(403);
    }
    expect((await mcp(post('/api/mcp?key=', SEARCH))).status).toBe(403);
    expect((await tryTool(post('/api/try', READ_LOCAL, { cookie: `${SESSION_COOKIE}=`, 'sec-fetch-site': 'same-origin' }))).status).toBe(401);
    expect(contacted).toEqual([]);
  });
});

describe('closed', () => {
  it('turns every caller away and contacts nobody', async () => {
    process.env.VERCEL_ENV = 'production';
    const contacted = watchTheNetwork();

    const agent = await mcp(post('/api/mcp', SEARCH));
    expect(agent.status).toBe(403);
    expect(await agent.json()).toEqual({ jsonrpc: '2.0', error: { code: -32001, message: CLOSED_TEXT }, id: null });

    const tried = await tryTool(post('/api/try', { tool: 'fetch_url', args: { url: 'https://example.com' } }));
    expect(tried.status).toBe(403);
    expect(await tried.json()).toMatchObject({ ok: false, open: false });

    expect((await check(post('/api/check', {}))).status).toBe(403);
    expect((await logs(get('/api/logs'))).status).toBe(403);

    const info = (await (await status(get('/api/status'))).json()) as Record<string, unknown>;
    expect(info).toEqual({ name: 'scrapy', version: '1.0.0', release: 'G - 1.0', access: 'closed', open: false, allowed: false, message: CLOSED_TEXT });

    expect(contacted).toEqual([]);
  });

  it('cannot be opened with a key or a pass, because there is no password to make them from', async () => {
    process.env.VERCEL_ENV = 'production';
    for (const headers of [{ authorization: 'Bearer scrapy_' }, { authorization: 'Bearer null' }, { 'x-scrapy-key': 'undefined' }, { cookie: `${SESSION_COOKIE}=1.99999999999.abc.def` }] as Sent[]) {
      expect((await mcp(post('/api/mcp', LIST, headers))).status).toBe(403);
      expect((await tryTool(post('/api/try', READ_LOCAL, headers))).status).toBe(403);
    }
  });

  it('still lets anybody read the docs, and says in them that it is closed', async () => {
    process.env.VERCEL_ENV = 'production';
    const rules = await llms(get('/llms.txt'));
    expect(rules.status).toBe(200);
    expect(await rules.text()).toContain('MCP address: https://scrapy.test/api/mcp (Streamable HTTP). This Scrapy is closed for now: it answers no calls.');
    const pages = await docs();
    expect(pages.status).toBe(200);
    expect(((await pages.json()) as { facts: { access: string } }).facts.access).toBe('closed');
  });
});

describe('open', () => {
  it('gives the rulebook as plain text, with the address of this Scrapy in it', async () => {
    const rules = await llms(new Request('http://10.1.2.3:3000/llms.txt', { headers: { 'x-forwarded-host': 'my-scrapy.example', 'x-forwarded-proto': 'https' } }));
    expect(rules.status).toBe(200);
    expect(rules.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    const text = await rules.text();
    expect(text).toBe(rulebook({ address: 'https://my-scrapy.example/api/mcp' }));
    expect(text).toContain('MCP address: https://my-scrapy.example/api/mcp (Streamable HTTP, no key needed).');

    const pages = await docs();
    expect(pages.status).toBe(200);
    expect(pages.headers.get('cache-control')).toBe('no-store');
    const payload = (await pages.json()) as { tools: { name: string }[]; rulebook: string; addressLine: string; release: string; version: string; facts: { access: string; limits: { perMinute: number } } };
    expect(payload.tools.map((t) => t.name)).toEqual(['search_web', 'fetch_url']);
    expect(payload.rulebook).toBe(rulebook());
    expect(payload.addressLine).toBe('MCP address: {address} (Streamable HTTP, no key needed).');
    expect(payload.facts.access).toBe('open');
    expect(payload.facts.limits.perMinute).toBe(30);
    expect(payload.release).toBe('G - 1.0');
    expect(payload.version).toBe('1.0.0');
  });

  it('answers everybody who gets there, with no key and no login', async () => {
    process.env.VERCEL_ENV = 'production';
    process.env.SCRAPY_OPEN = '1';
    const info = (await (await status(get('/api/status'))).json()) as Record<string, unknown>;
    expect(info).toMatchObject({ access: 'open', open: true, allowed: true, mode: 'safe', release: 'G - 1.0' });
    // There is no key where there is no password.
    expect('key' in info).toBe(false);
    const tried = await tryTool(post('/api/try', READ_LOCAL));
    expect(tried.status).toBe(200);
    expect(await tried.json()).toMatchObject({ ok: false, reason: 'private_address' });
    expect(await toolNames(await mcp(post('/api/mcp', LIST)))).toEqual(['search_web', 'fetch_url']);
    // A key nobody asked for does no harm.
    expect(await toolNames(await mcp(post('/api/mcp', LIST, { authorization: 'Bearer whatever' })))).toEqual(['search_web', 'fetch_url']);
  });

  it('keeps no log on a public address, because everybody could read it', () => {
    process.env.VERCEL_ENV = 'production';
    process.env.SCRAPY_OPEN = '1';
    expect(logsOn()).toBe(false);
  });
});

describe('personal: the MCP address', () => {
  it('turns away an agent without the key, tells it why, and contacts nobody', async () => {
    process.env.SCRAPY_PASSWORD = PASSWORD;
    const contacted = watchTheNetwork();
    const none = await mcp(post('/api/mcp', SEARCH));
    // 403 and not 401: after a 401, many AI apps start a login of their own that Scrapy does not have.
    expect(none.status).toBe(403);
    expect(none.headers.get('www-authenticate')).toBeNull();
    expect(await none.json()).toEqual({ jsonrpc: '2.0', error: { code: -32001, message: KEY_TEXT }, id: null });
    expect(KEY_TEXT).toContain('personal');
    expect(KEY_TEXT).toContain('Authorization: Bearer <key>');

    const key = agentKey() ?? '';
    const wrong: Sent[] = [
      { authorization: 'Bearer wrong' },
      { authorization: `Bearer ${key.slice(0, -1)}` },
      { authorization: `Bearer ${key}x` },
      { authorization: `Bearer ${PASSWORD}` },
      { authorization: `Basic ${key}` },
      { 'x-scrapy-key': 'wrong' },
      // The pass of a browser is not the key of an agent.
      browser(),
    ];
    for (const headers of wrong) {
      const refused = await mcp(post('/api/mcp', SEARCH, headers));
      expect(refused.status, JSON.stringify(headers).slice(0, 60)).toBe(403);
      expect(((await refused.json()) as { error: { message: string } }).error.message).toBe(KEY_TEXT);
    }
    expect((await mcp(post('/api/mcp?key=wrong', SEARCH))).status).toBe(403);
    expect(contacted).toEqual([]);
  });

  it('answers an agent that sends the key, in any of the three places', async () => {
    process.env.SCRAPY_PASSWORD = PASSWORD;
    const key = agentKey() ?? '';
    expect(await toolNames(await mcp(post('/api/mcp', LIST, { authorization: `Bearer ${key}` })))).toEqual(['search_web', 'fetch_url']);
    expect(await toolNames(await mcp(post('/api/mcp', LIST, { authorization: `bearer ${key}` })))).toEqual(['search_web', 'fetch_url']);
    expect(await toolNames(await mcp(post('/api/mcp', LIST, { 'x-scrapy-key': key })))).toEqual(['search_web', 'fetch_url']);
    expect(await toolNames(await mcp(post(`/api/mcp?key=${key}`, LIST)))).toEqual(['search_web', 'fetch_url']);
    // One right key is enough, whatever an AI app puts into the other places.
    expect(await toolNames(await mcp(post(`/api/mcp?key=${key}`, LIST, { authorization: 'Bearer a-token-of-the-app' })))).toEqual(['search_web', 'fetch_url']);
  });

  it('is the same on the public address, with or without SCRAPY_OPEN', async () => {
    process.env.SCRAPY_PASSWORD = PASSWORD;
    process.env.VERCEL_ENV = 'production';
    for (const open of [undefined, '1']) {
      if (open) process.env.SCRAPY_OPEN = open;
      expect((await mcp(post('/api/mcp', LIST))).status).toBe(403);
      expect(await toolNames(await mcp(post('/api/mcp', LIST, withKey())))).toEqual(['search_web', 'fetch_url']);
    }
  });

  it('stops answering to the old key when the password changes', async () => {
    process.env.SCRAPY_PASSWORD = PASSWORD;
    const old = withKey();
    process.env.SCRAPY_PASSWORD = 'a brand new password';
    expect((await mcp(post('/api/mcp', LIST, old))).status).toBe(403);
    expect(await toolNames(await mcp(post('/api/mcp', LIST, withKey())))).toEqual(['search_web', 'fetch_url']);
  });
});

describe('personal: the dashboard and what is behind it', () => {
  it('asks a browser that is not logged in to log in, and contacts nobody', async () => {
    process.env.SCRAPY_PASSWORD = PASSWORD;
    const contacted = watchTheNetwork();
    const answers = [await tryTool(post('/api/try', { tool: 'fetch_url', args: { url: 'https://example.com' } })), await check(post('/api/check', {})), await logs(get('/api/logs')), await logs(get('/api/logs?id=abc')), await logs(get('/api/logs?probe=1'))];
    for (const answer of answers) {
      expect(answer.status).toBe(401);
      expect(answer.headers.get('cache-control')).toBe('no-store');
      expect(await answer.json()).toEqual({ ok: false, login: true, text: LOGIN_TEXT, error: LOGIN_TEXT });
    }
    expect(contacted).toEqual([]);
  });

  it('lets the browser in that has logged in', async () => {
    process.env.SCRAPY_PASSWORD = PASSWORD;
    const tried = await tryTool(post('/api/try', READ_LOCAL, browser()));
    expect(tried.status).toBe(200);
    expect(await tried.json()).toMatchObject({ ok: false, reason: 'private_address' });
    const feed = await logs(get('/api/logs', browser()));
    expect(feed.status).toBe(200);
    expect(await feed.json()).toMatchObject({ on: true });
  });

  it('does not take the key of an agent for a login: a key that got out cannot read the log', async () => {
    process.env.SCRAPY_PASSWORD = PASSWORD;
    const key = agentKey() ?? '';
    for (const headers of [withKey(), { 'x-scrapy-key': key }, { cookie: `${SESSION_COOKIE}=${key}` }] as Sent[]) {
      expect((await logs(get('/api/logs', headers))).status).toBe(401);
      expect((await tryTool(post('/api/try', READ_LOCAL, headers))).status).toBe(401);
      expect((await check(post('/api/check', {}, headers))).status).toBe(401);
    }
    expect((await logs(get(`/api/logs?key=${key}`))).status).toBe(401);
  });

  it('does not count a login for a request that another site started', async () => {
    process.env.SCRAPY_PASSWORD = PASSWORD;
    const contacted = watchTheNetwork();
    const cookie = browser().cookie ?? '';
    for (const headers of [
      { cookie, 'sec-fetch-site': 'cross-site' },
      { cookie, 'sec-fetch-site': 'same-site' },
      { cookie, origin: 'https://evil.example' },
    ] as Sent[]) {
      expect((await tryTool(post('/api/try', { tool: 'fetch_url', args: { url: 'https://example.com' } }, headers))).status).toBe(401);
      expect((await check(post('/api/check', {}, headers))).status).toBe(401);
      expect((await logs(get('/api/logs', headers))).status).toBe(401);
    }
    expect(contacted).toEqual([]);
  });

  it('keeps the log, also on the public address: only the owner can read it', () => {
    process.env.SCRAPY_PASSWORD = PASSWORD;
    process.env.VERCEL_ENV = 'production';
    expect(logsOn()).toBe(true);
    process.env.SCRAPY_LOGS = 'off';
    expect(logsOn()).toBe(false);
  });
});

describe('personal: what everybody may see', () => {
  it('tells a stranger that this Scrapy is personal, and nothing about how it is set up', async () => {
    process.env.SCRAPY_PASSWORD = PASSWORD;
    const answer = await status(get('/api/status'));
    expect(answer.headers.get('cache-control')).toBe('no-store');
    expect(await answer.json()).toEqual({ name: 'scrapy', version: '1.0.0', release: 'G - 1.0', access: 'personal', open: true, allowed: false, message: LOGIN_TEXT });
    // The key of an agent does not open it either.
    expect(await (await status(get('/api/status', withKey()))).json()).toMatchObject({ allowed: false });
    expect(JSON.stringify(await (await status(get('/api/status', withKey()))).json())).not.toContain('scrapy_');
  });

  it('gives the owner, logged in, the settings and the key for an AI', async () => {
    process.env.SCRAPY_PASSWORD = PASSWORD;
    const info = (await (await status(get('/api/status', browser()))).json()) as Record<string, unknown>;
    expect(info).toMatchObject({ access: 'personal', open: true, allowed: true, key: agentKey(), mode: 'safe', limits: { visitorPerMinute: 30, dailyCalls: 1500 } });
    expect((info.tools as { name: string }[]).map((t) => t.name)).toEqual(['search_web', 'fetch_url']);
    // Not from another site, though.
    const other = (await (await status(get('/api/status', { ...browser(), 'sec-fetch-site': 'cross-site' }))).json()) as Record<string, unknown>;
    expect(other).toMatchObject({ allowed: false });
    expect('key' in other).toBe(false);
  });

  it('lets anybody read the docs, and keeps the key and the password out of them', async () => {
    process.env.SCRAPY_PASSWORD = PASSWORD;
    process.env.VERCEL_ENV = 'production';
    const key = agentKey() ?? '';

    const pages = await docs();
    expect(pages.status).toBe(200);
    const body = await pages.text();
    const payload = JSON.parse(body) as { addressLine: string; facts: { access: string; logs: { on: boolean } }; tools: { name: string }[] };
    expect(payload.facts.access).toBe('personal');
    expect(payload.facts.logs.on).toBe(true);
    expect(payload.tools.map((t) => t.name)).toEqual(['search_web', 'fetch_url']);
    expect(payload.addressLine).toBe(addressLine('{address}'));

    const rules = await llms(get('/llms.txt'));
    expect(rules.status).toBe(200);
    const text = await rules.text();
    expect(text).toContain('MCP address: https://scrapy.test/api/mcp (Streamable HTTP). This Scrapy is personal: every request must carry its owner\'s key, in the header "Authorization: Bearer <key>".');
    expect(text).not.toContain('no key needed');

    for (const shown of [body, text]) {
      expect(shown).not.toContain(key);
      expect(shown).not.toContain(key.slice(7));
      expect(shown).not.toContain(PASSWORD);
    }
  });

  it('says the same about the address in the rulebook an agent reads over MCP', () => {
    expect(addressLine('https://s.example/api/mcp', 'open')).toBe('MCP address: https://s.example/api/mcp (Streamable HTTP, no key needed).');
    expect(addressLine('https://s.example/api/mcp', 'personal')).toContain('every request must carry its owner\'s key');
    expect(addressLine('https://s.example/api/mcp', 'closed')).toContain('closed for now');
  });
});
