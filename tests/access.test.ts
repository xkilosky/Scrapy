import { afterEach, describe, expect, it } from 'vitest';
import { GET as status } from '@/app/api/status/route';
import { POST as check } from '@/app/api/check/route';
import { POST as mcp } from '@/app/api/mcp/route';
import { POST as tryTool } from '@/app/api/try/route';
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

    expect(contacted).toEqual([]);
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
