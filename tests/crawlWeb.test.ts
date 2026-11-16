import { describe, expect, it } from 'vitest';
import type { PageWay } from '@/lib/providers/types';
import { webDeepFetch } from '@/lib/tools/crawlWeb';
import { Trace } from '@/lib/trace';

function pageWay(pages: Record<string, { title: string; html: string }>): PageWay {
  return {
    id: 'fixture', name: 'Fixture', hosts: [], formats: ['markdown', 'html'], browser: false, own: false,
    async load(query) {
      const page = pages[new URL(query.url).pathname];
      if (!page) throw new Error('missing fixture page');
      return { title: page.title, finalUrl: query.url, rawHtml: `<html><head><title>${page.title}</title></head><body><h1>${page.title}</h1><p>${'Readable page text. '.repeat(40)}</p>${page.html}</body></html>` };
    },
  };
}

const trace = () => new Trace();

describe('web_deep_fetch', () => {
  it('crawls breadth first, respects the page limit, and stays on the exact host by default', async () => {
    const helper = pageWay({
      '/': { title: 'Home', html: '<a href="/first">First</a><a href="/second">Second</a><a href="https://other.example/offsite">Offsite</a><a href="http://127.0.0.1/private">Private</a>' },
      '/first': { title: 'First page', html: '<a href="/third">Third</a>' },
      '/second': { title: 'Second page', html: '' },
    });
    const answer = await webDeepFetch({ url: 'https://docs.example.com/', max_pages: 2 }, trace(), { helpers: [helper], order: ['fixture'] });
    expect(answer).toContain('Crawled 2 pages from https://docs.example.com (same domain only).');
    expect(answer).toContain('Home');
    expect(answer).toContain('First page');
    expect(answer).not.toContain('https://outside.example.com/offsite');
    expect(answer).not.toContain('127.0.0.1');
    expect(answer).toContain('2-page limit');
  });

  it('can follow a link on another public host when explicitly allowed', async () => {
    const helper = pageWay({
      '/': { title: 'Home', html: '<a href="https://outside.example.com/other">Other</a>' },
      '/other': { title: 'Other page', html: '' },
    });
    const answer = await webDeepFetch({ url: 'https://docs.other.com/', max_pages: 2, same_domain_only: false }, trace(), { helpers: [helper], order: ['fixture'] });
    expect(answer).toContain('Crawled 2 pages from https://docs.other.com.');
    expect(answer).toContain('Other page');
  });

  it('validates the start URL before making any page request', async () => {
    await expect(webDeepFetch({ url: 'http://127.0.0.1/' }, trace())).rejects.toThrow(/^Refused:/);
  });
});
