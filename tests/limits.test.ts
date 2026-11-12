import { afterEach, describe, expect, it } from 'vitest';
import { ScrapyError } from '../lib/errors';
import { createHealth } from '../lib/health';
import { createLimiter, visitorOf } from '../lib/limits';
import { createMemoryStore, keyOf } from '../lib/store';
import { runTool } from '../lib/tools';

afterEach(() => {
  delete process.env.SCRAPY_VISITOR_PER_MINUTE;
  delete process.env.SCRAPY_DAILY_CALLS;
});

describe('the speed limit for each visitor', () => {
  it('tells a visitor to slow down, and lets them back in after a minute', async () => {
    process.env.SCRAPY_VISITOR_PER_MINUTE = '3';
    let now = Date.parse('2026-11-11T10:00:00Z');
    const limiter = createLimiter(createMemoryStore(() => now), () => now);
    for (let i = 0; i < 3; i++) await limiter.check('1.2.3.4');
    const err = await limiter.check('1.2.3.4').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScrapyError);
    expect(err).toMatchObject({ reason: 'slow_down' });
    expect((err as ScrapyError).message).toMatch(/^Slow down: the limit is 3 calls per minute for each visitor\./);

    // Another visitor is not affected.
    await expect(limiter.check('5.6.7.8')).resolves.toBeUndefined();

    now += 61_000;
    await expect(limiter.check('1.2.3.4')).resolves.toBeUndefined();
  });
});

describe('the daily ceiling', () => {
  it('stops everybody when the day is used up, and starts again the next day', async () => {
    process.env.SCRAPY_DAILY_CALLS = '5';
    let now = Date.parse('2026-11-11T10:00:00Z');
    const limiter = createLimiter(createMemoryStore(() => now), () => now);
    for (let i = 0; i < 5; i++) await limiter.check(`visitor-${i}`);
    await expect(limiter.check('someone-new')).rejects.toMatchObject({ reason: 'daily_limit' });
    expect(limiter.usage()).toMatchObject({ today: 5, dailyCalls: 5 });

    now = Date.parse('2026-11-12T00:00:05Z');
    await expect(limiter.check('someone-new')).resolves.toBeUndefined();
    expect(limiter.usage().today).toBe(1);
  });

  it('counts the calls of other servers too', async () => {
    process.env.SCRAPY_DAILY_CALLS = '100';
    const now = Date.parse('2026-11-11T10:00:00Z');
    const store = createMemoryStore(() => now);
    await store.set('calls:2026-11-11', 100, 3_600);
    const limiter = createLimiter(store, () => now);
    await expect(limiter.check('v')).rejects.toMatchObject({ reason: 'daily_limit' });
  });
});

describe('runTool', () => {
  it('applies the limits before doing any work, and answers with a plain sentence', async () => {
    process.env.SCRAPY_VISITOR_PER_MINUTE = '1';
    const limiter = createLimiter(createMemoryStore());
    const first = await runTool('fetch_url', { url: 'http://localhost/' }, 'v1', { limiter });
    expect(first).toMatchObject({ ok: false, reason: 'private_address' });
    const second = await runTool('fetch_url', { url: 'http://localhost/' }, 'v1', { limiter });
    expect(second).toMatchObject({ ok: false, reason: 'slow_down' });
    expect(second.trace.contacts).toHaveLength(0);
  });

  it('explains wrong input and unknown tools', async () => {
    const limiter = createLimiter(createMemoryStore());
    const bad = await runTool('search_web', { query: 'x', max_results: 500 }, 'v', { limiter });
    expect(bad).toMatchObject({ ok: false, reason: 'bad_input' });
    expect(bad.text).toMatch(/^The input for search_web is not right\. "max_results" is 500\. It must be: integer, 1 to 20\. Parameters of search_web: query \(/);
    const unknown = await runTool('nope', {}, 'v', { limiter });
    expect(unknown.text).toBe('There is no tool called "nope". The tools are: search_web, fetch_url.');
  });
});

describe('small pieces', () => {
  it('reads the visitor address from the request', () => {
    expect(visitorOf(new Request('https://x.example/', { headers: { 'x-real-ip': '9.9.9.9', 'x-forwarded-for': '1.1.1.1, 2.2.2.2' } }))).toBe('9.9.9.9');
    expect(visitorOf(new Request('https://x.example/', { headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2' } }))).toBe('1.1.1.1');
    expect(visitorOf(new Request('https://x.example/'))).toBe('unknown');
  });

  it('makes stable, distinct memory keys', () => {
    expect(keyOf('k', { a: 1, b: 'x' })).toBe(keyOf('k', { a: 1, b: 'x' }));
    expect(keyOf('k', { a: 1, b: 'x' })).not.toBe(keyOf('k', { a: 1, b: 'y' }));
  });

  it('forgets on time, and rests and recovers helpers', async () => {
    let now = 1_000_000;
    const store = createMemoryStore(() => now);
    await store.set('a', 'value', 10);
    expect(await store.get('a')).toBe('value');
    now += 11_000;
    expect(await store.get('a')).toBeNull();

    const health = createHealth(store, () => now);
    expect(await health.resting('x:page')).toBe(0);
    await health.rest('x:page', 600, 'slow down');
    expect(await health.resting('x:page')).toBe(600);
    now += 601_000;
    expect(await health.resting('x:page')).toBe(0);

    await health.failed('y:page', 'broken');
    expect(await health.resting('y:page')).toBe(0);
    await health.failed('y:page', 'broken again');
    expect(await health.resting('y:page')).toBeGreaterThan(0);
  });

  it('shares a rest between servers through the shared memory', async () => {
    const now = 5_000_000;
    const store = createMemoryStore(() => now);
    await createHealth(store, () => now).rest('z:search', 900, 'limit');
    expect(await createHealth(store, () => now).resting('z:search')).toBe(900);
  });
});
