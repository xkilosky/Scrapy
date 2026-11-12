import { afterEach, describe, expect, it } from 'vitest';
import { GET as docs } from '@/app/api/docs/route';
import { GET as status } from '@/app/api/status/route';
import { POST as check } from '@/app/api/check/route';
import { POST as mcp } from '@/app/api/mcp/route';
import { POST as tryTool } from '@/app/api/try/route';
import { GET as llms } from '@/app/llms.txt/route';
import { rulebook } from '@/lib/docs';
import { isOpen } from '@/lib/access';
import { setFetch } from '@/lib/http';

afterEach(() => {
  delete process.env.VERCEL_ENV;
  delete process.env.SCRAPY_OPEN;
  setFetch(null);
});

const post = (path: string, body: unknown): Request =>
  new Request(`https://scrapy.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) });

describe('open or closed', () => {
  it('is open on a test address and on a developer machine', () => {
    expect(isOpen()).toBe(true);
    process.env.VERCEL_ENV = 'preview';
    expect(isOpen()).toBe(true);
    process.env.VERCEL_ENV = 'development';
    expect(isOpen()).toBe(true);
  });

  it('is closed on the public address until the owner opens it', () => {
    process.env.VERCEL_ENV = 'production';
    expect(isOpen()).toBe(false);
    process.env.SCRAPY_OPEN = '0';
    expect(isOpen()).toBe(false);
    process.env.SCRAPY_OPEN = '1';
    expect(isOpen()).toBe(true);
  });

  it('when closed, turns every caller away and contacts nobody', async () => {
    process.env.VERCEL_ENV = 'production';
    const contacted: string[] = [];
    setFetch(async (input) => {
      contacted.push(String(input));
      return new Response('{}');
    });

    const agent = await mcp(post('/api/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_web', arguments: { query: 'x' } } }));
    expect(agent.status).toBe(403);
    expect(await agent.json()).toMatchObject({ jsonrpc: '2.0', error: { message: 'Scrapy is closed at this address. Its owner has not opened it yet.' } });

    const tried = await tryTool(post('/api/try', { tool: 'fetch_url', args: { url: 'https://example.com' } }));
    expect(tried.status).toBe(403);
    expect(await tried.json()).toMatchObject({ ok: false, open: false });

    const checked = await check(post('/api/check', {}));
    expect(checked.status).toBe(403);

    const info = (await (await status()).json()) as Record<string, unknown>;
    expect(info).toEqual({ name: 'scrapy', version: '0.1.0', open: false, message: 'Scrapy is closed at this address. Its owner has not opened it yet.' });

    // The docs are part of Scrapy: closed too.
    const rules = await llms(new Request('https://scrapy.test/llms.txt'));
    expect(rules.status).toBe(403);
    expect(await rules.text()).toBe('Scrapy is closed at this address. Its owner has not opened it yet.\n');
    const pages = await docs();
    expect(pages.status).toBe(403);
    expect(await pages.json()).toMatchObject({ ok: false, open: false, text: 'Scrapy is closed at this address. Its owner has not opened it yet.' });

    expect(contacted).toEqual([]);
  });

  it('where it is open, gives the rulebook as plain text, with the address of this Scrapy in it', async () => {
    const rules = await llms(new Request('http://10.1.2.3:3000/llms.txt', { headers: { 'x-forwarded-host': 'my-scrapy.example', 'x-forwarded-proto': 'https' } }));
    expect(rules.status).toBe(200);
    expect(rules.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    const text = await rules.text();
    expect(text).toBe(rulebook({ address: 'https://my-scrapy.example/api/mcp' }));
    expect(text).toContain('MCP address: https://my-scrapy.example/api/mcp (Streamable HTTP, no key needed).');

    const pages = await docs();
    expect(pages.status).toBe(200);
    expect(pages.headers.get('cache-control')).toBe('no-store');
    const payload = (await pages.json()) as { tools: { name: string }[]; rulebook: string; facts: { limits: { perMinute: number } } };
    expect(payload.tools.map((t) => t.name)).toEqual(['search_web', 'fetch_url']);
    expect(payload.rulebook).toBe(rulebook());
    expect(payload.facts.limits.perMinute).toBe(30);
  });

  it('when opened, answers', async () => {
    process.env.VERCEL_ENV = 'production';
    process.env.SCRAPY_OPEN = '1';
    const info = (await (await status()).json()) as Record<string, unknown>;
    expect(info.open).toBe(true);
    expect(info.mode).toBe('safe');
    const tried = await tryTool(post('/api/try', { tool: 'fetch_url', args: { url: 'http://localhost/' } }));
    expect(tried.status).toBe(200);
    expect(await tried.json()).toMatchObject({ ok: false, reason: 'private_address' });
  });
});
