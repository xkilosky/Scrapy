import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HelperError } from '../lib/errors';
import { ownDownload } from '../lib/providers/own';
import { Trace } from '../lib/trace';

let server: Server;
let base = '';
const seen: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push(`${req.headers.host ?? ''}${req.url ?? ''}`);
    const url = req.url ?? '/';
    if (url === '/page') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<html><head><title>Hello</title></head><body><main><h1>Hello</h1><p>${'Real words on a real page. '.repeat(10)}</p></main></body></html>`);
    } else if (url === '/agent') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(req.headers['user-agent'] ?? '');
    } else if (url === '/hop1') {
      res.writeHead(302, { location: '/hop2' });
      res.end();
    } else if (url === '/hop2') {
      res.writeHead(301, { location: '/page' });
      res.end();
    } else if (url === '/to-private') {
      // Tries to send the reader to another name for this same machine.
      res.writeHead(302, { location: `http://localhost:${(server.address() as AddressInfo).port}/secret` });
      res.end();
    } else if (url === '/loop') {
      res.writeHead(302, { location: '/loop' });
      res.end();
    } else if (url === '/latin1') {
      res.writeHead(200, { 'content-type': 'text/html; charset=iso-8859-1' });
      res.end(Buffer.from('<html><body><p>caf\xe9 cr\xe8me</p></body></html>', 'latin1'));
    } else if (url === '/pdf') {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end('%PDF-1.7');
    } else if (url === '/huge') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('x'.repeat(6_000_000));
    } else if (url === '/missing') {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end('<h1>Not found</h1>');
    } else if (url === '/forbidden') {
      res.writeHead(403);
      res.end('no');
    } else {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<p>secret</p>');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const opts = { timeoutMs: 5_000 };
const local = { allowHosts: ['127.0.0.1'] };
const get = (path: string, trace = new Trace()) => ownDownload({ url: `${base}${path}`, format: 'markdown', browser: false }, trace, opts, local);
const failure = async (run: Promise<unknown>): Promise<HelperError> => {
  const err = await run.catch((e: unknown) => e);
  if (err instanceof HelperError) return err;
  throw new Error(`expected a HelperError, got ${String(err)}`);
};

describe("Scrapy's own download", () => {
  it('downloads a page and says honestly who it is', async () => {
    const trace = new Trace();
    const page = await get('/page', trace);
    expect(page.rawHtml).toContain('<h1>Hello</h1>');
    expect(page.status).toBe(200);
    expect(trace.contacts).toMatchObject([{ purpose: 'own download', method: 'GET', status: 200 }]);
    expect((await get('/agent')).markdown).toMatch(/^Scrapy\/\d+\.\d+\.\d+ \(\+https:\/\/github\.com\/xkilosky\/Scrapy\)$/);
  });

  it('follows redirects and reports the final address', async () => {
    const trace = new Trace();
    const page = await get('/hop1', trace);
    expect(page.finalUrl).toBe(`${base}/page`);
    expect(trace.contacts.map((c) => c.status)).toEqual([302, 301, 200]);
  });

  it('refuses a redirect to a private address, and never contacts it', async () => {
    seen.length = 0;
    const err = await failure(get('/to-private'));
    expect(err.kind).toBe('refused');
    expect(err.message).toMatch(/private or internal address/);
    expect(seen.some((s) => s.includes('/secret'))).toBe(false);
  });

  it('refuses a private address given directly, and a public-looking name that points to one', async () => {
    const direct = await failure(ownDownload({ url: `${base}/page`, format: 'markdown', browser: false }, new Trace(), opts));
    expect(direct.kind).toBe('refused');
    seen.length = 0;
    const sneaky = await failure(ownDownload({ url: 'http://sneaky.example.com/page', format: 'markdown', browser: false }, new Trace(), opts, { resolver: async () => ['127.0.0.1'] }));
    expect(sneaky.kind).toBe('refused');
    expect(seen).toHaveLength(0);
  });

  it('gives up on an endless redirect', async () => {
    expect((await failure(get('/loop'))).message).toMatch(/redirected more than 5 times/);
  });

  it('reads pages that are not written in UTF-8', async () => {
    expect((await get('/latin1')).rawHtml).toContain('café crème');
  });

  it('refuses files that are not web pages, and stops at the size limit', async () => {
    expect(await failure(get('/pdf'))).toMatchObject({ kind: 'not_a_page' });
    const huge = await get('/huge');
    expect(huge.rawHtml?.length).toBe(5_000_000);
  });

  it('reports what the site answered', async () => {
    expect(await failure(get('/missing'))).toMatchObject({ kind: 'not_found' });
    expect(await failure(get('/forbidden'))).toMatchObject({ kind: 'blocked' });
  });

  it('reports a site that does not exist', async () => {
    const err = await failure(
      ownDownload({ url: 'http://no-such-site.example.com/', format: 'markdown', browser: false }, new Trace(), opts, {
        resolver: async () => {
          throw new Error('ENOTFOUND');
        },
      }),
    );
    expect(err.kind).toBe('not_found');
  });
});
