/**
 * The log of tool calls behind the "Live feed".
 * The shared memory is a stand-in that counts what it is asked, and can misbehave on request.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { GET as logs } from '@/app/api/logs/route';
import { logsOn } from '@/lib/config';
import { createLogBook, entryOf, getLogBook, isLogId, logCall, methodOf, newLogId, resetLogBook, type LogEntry } from '@/lib/logs';
import type { SharedLayer } from '@/lib/store';
import { sharedIsReal, sharedKeyName } from '@/lib/store';
import type { TraceReport } from '@/lib/trace';

interface FakeShared extends SharedLayer {
  data: Map<string, unknown>;
  reads: string[];
  writes: string[];
  deletes: string[];
  /** Units as Vercel counts them: 8 KB each. */
  writeUnits: number;
  mode: 'ok' | 'throws' | 'silent';
}

function fakeShared(): FakeShared {
  const shared: FakeShared = {
    data: new Map(),
    reads: [],
    writes: [],
    deletes: [],
    writeUnits: 0,
    mode: 'ok',
    async get(key) {
      shared.reads.push(key);
      if (shared.mode === 'throws') throw new Error('shared memory is down');
      // Like the real one: what comes back is a copy, made through JSON.
      return shared.data.has(key) ? JSON.parse(JSON.stringify(shared.data.get(key))) : null;
    },
    async set(key, value) {
      shared.writes.push(key);
      if (shared.mode === 'throws') throw new Error('shared memory is down');
      if (shared.mode === 'silent') return;
      const text = JSON.stringify(value);
      shared.writeUnits += Math.ceil(text.length / 8192);
      shared.data.set(key, JSON.parse(text));
    },
    async delete(key) {
      shared.deletes.push(key);
      shared.data.delete(key);
    },
  };
  return shared;
}

let seq = 0;
function entry(at: number, over: Partial<LogEntry> = {}): LogEntry {
  seq += 1;
  return {
    id: newLogId(at),
    at,
    tool: 'search_web',
    from: 'agent',
    input: `question ${seq}`,
    options: {},
    ok: true,
    tier: 1,
    method: 'Tier 1 (Fast HTTP)',
    by: ['Tavily', 'Exa'],
    steps: [{ way: 'tavily search', ok: true, ms: 310, note: '8 results' }],
    ms: 400,
    chars: 1_000,
    ...over,
  };
}

const T0 = Date.UTC(2026, 10, 11, 11, 45, 2);
const inputs = (list: LogEntry[] | null): string[] => (list ?? []).map((e) => e.input);

afterEach(() => {
  delete process.env.VERCEL_ENV;
  delete process.env.SCRAPY_LOGS;
  delete process.env.SCRAPY_OPEN;
  resetLogBook();
});

describe('one server', () => {
  it('keeps a call and its answer, with no shared memory at all', async () => {
    const book = createLogBook({ now: () => T0 });
    const e = entry(T0, { input: 'how to fix hydration error' });
    await book.record(e, 'the answer');
    const first = await book.read();
    expect(inputs(first.entries)).toEqual(['how to fix hydration error']);
    expect(await book.answer(e.id)).toBe('the answer');
    expect(await book.answer(newLogId(T0))).toBeNull();
    expect(await book.probe()).toBe('none');
  });

  it('says "nothing changed" as long as nothing changed', async () => {
    const book = createLogBook({ now: () => T0, writeGapMs: 0 });
    await book.record(entry(T0), 'a');
    const first = await book.read();
    expect(first.entries).toHaveLength(1);
    expect(await book.read(first.rev)).toEqual({ rev: first.rev, entries: null });
    await book.record(entry(T0 + 1), 'b');
    const third = await book.read(first.rev);
    expect(third.entries).toHaveLength(2);
    expect(third.rev).not.toBe(first.rev);
  });

  it('lists calls in the order they arrived, whatever order they finished in', async () => {
    const book = createLogBook({ now: () => T0 + 10_000, writeGapMs: 0 });
    await book.record(entry(T0 + 5_000, { input: 'arrived second, finished first' }), 'x');
    await book.record(entry(T0 + 1_000, { input: 'arrived first, took long' }), 'x');
    expect(inputs((await book.read()).entries)).toEqual(['arrived first, took long', 'arrived second, finished first']);
  });

  it('keeps only the newest calls, and forgets a call when it is too old', async () => {
    let now = T0;
    const book = createLogBook({ now: () => now, keep: 3, hours: 1, writeGapMs: 0 });
    const made: LogEntry[] = [];
    for (let i = 0; i < 5; i++) {
      const e = entry(T0 + i * 1_000, { input: `call ${i}` });
      made.push(e);
      await book.record(e, `answer ${i}`);
    }
    expect(inputs((await book.read()).entries)).toEqual(['call 2', 'call 3', 'call 4']);
    expect(await book.answer(made[0]!.id)).toBeNull();
    expect(await book.answer(made[4]!.id)).toBe('answer 4');
    now = T0 + 3_600_000 + 3_500;
    expect(inputs((await book.read()).entries)).toEqual(['call 4']);
    now = T0 + 2 * 3_600_000;
    expect((await book.read()).entries).toEqual([]);
  });

  it('cuts a very long answer in the log, and says so', async () => {
    const book = createLogBook({ now: () => T0, maxAnswerChars: 20 });
    const e = entry(T0);
    await book.record(e, 'x'.repeat(50));
    expect(await book.answer(e.id)).toBe(`${'x'.repeat(20)}\n\n(Cut in the log: 30 more characters. The agent got all of it.)`);
  });

  it('lists a caller who is over a limit once in a while, not every time', () => {
    let now = T0;
    const book = createLogBook({ now: () => now, refusalGapMs: 60_000 });
    expect(book.shouldListRefusal('1.2.3.4')).toBe(true);
    expect(book.shouldListRefusal('1.2.3.4')).toBe(false);
    expect(book.shouldListRefusal('5.6.7.8')).toBe(true);
    now += 59_000;
    expect(book.shouldListRefusal('1.2.3.4')).toBe(false);
    now += 2_000;
    expect(book.shouldListRefusal('1.2.3.4')).toBe(true);
  });
});

describe('several servers and the shared memory', () => {
  it('lets a server read what another server wrote', async () => {
    const shared = fakeShared();
    const opts = { shared: async () => shared, now: () => T0 + 60_000, writeGapMs: 0 };
    const mcp = createLogBook(opts);
    const tryBox = createLogBook(opts);
    const feed = createLogBook(opts);

    const a = entry(T0, { input: 'from the agent' });
    const b = entry(T0 + 1_000, { input: 'from the try box', from: 'page' });
    await mcp.record(a, 'answer a');
    await tryBox.record(b, 'answer b');

    const seen = await feed.read();
    expect(inputs(seen.entries)).toEqual(['from the agent', 'from the try box']);
    expect(seen.entries?.[1]?.from).toBe('page');
    expect(await feed.answer(a.id)).toBe('answer a');
    expect(await feed.answer(b.id)).toBe('answer b');
  });

  it('asks the shared memory for one small value when nothing changed', async () => {
    const shared = fakeShared();
    const opts = { shared: async () => shared, now: () => T0, writeGapMs: 0 };
    const writer = createLogBook(opts);
    const feed = createLogBook(opts);
    await writer.record(entry(T0), 'a');

    const first = await feed.read();
    expect(first.entries).toHaveLength(1);
    shared.reads.length = 0;
    for (let i = 0; i < 5; i++) expect((await feed.read(first.rev)).entries).toBeNull();
    expect(shared.reads).toEqual(['log:head', 'log:head', 'log:head', 'log:head', 'log:head']);

    await writer.record(entry(T0 + 1), 'b');
    shared.reads.length = 0;
    expect((await feed.read(first.rev)).entries).toHaveLength(2);
    expect(shared.reads).toEqual(['log:head', 'log:list']);
  });

  it('puts its own calls back when another server overwrote the list', async () => {
    const shared = fakeShared();
    const opts = { shared: async () => shared, now: () => T0 + 60_000, writeGapMs: 0 };
    const a = createLogBook(opts);
    const feed = createLogBook(opts);
    await a.record(entry(T0, { input: 'a1' }), 'x');
    // Another server wrote at the same moment and did not see a1: the list now holds only its call.
    const other = entry(T0 + 500, { input: 'b1' });
    shared.data.set('log:list', { rev: 'other', entries: [other] });
    shared.data.set('log:head', { rev: 'other' });
    expect(inputs((await feed.read()).entries)).toEqual(['b1']);
    // With its next call, the first server puts a1 back.
    await a.record(entry(T0 + 1_000, { input: 'a2' }), 'x');
    expect(inputs((await feed.read()).entries)).toEqual(['a1', 'b1', 'a2']);
  });

  it('asks again when the shared memory hands out an older list than its head promises', async () => {
    const shared = fakeShared();
    const opts = { shared: async () => shared, now: () => T0 + 60_000, writeGapMs: 0 };
    const writer = createLogBook(opts);
    const feed = createLogBook(opts);
    await writer.record(entry(T0, { input: 'one' }), 'x');
    const staleList = shared.data.get('log:list');
    await writer.record(entry(T0 + 1_000, { input: 'two' }), 'x');
    const freshList = shared.data.get('log:list');

    shared.data.set('log:list', staleList);
    const first = await feed.read();
    expect(inputs(first.entries)).toEqual(['one']);
    shared.data.set('log:list', freshList);
    expect(inputs((await feed.read(first.rev)).entries)).toEqual(['one', 'two']);
  });

  it('drops the answers of calls that fell off the list', async () => {
    const shared = fakeShared();
    const book = createLogBook({ shared: async () => shared, now: () => T0 + 60_000, keep: 2, writeGapMs: 0 });
    const made = [entry(T0), entry(T0 + 1), entry(T0 + 2)];
    for (const e of made) await book.record(e, 'answer');
    expect(shared.data.has(`log:answer:${made[0]!.id}`)).toBe(false);
    expect(shared.deletes).toEqual([`log:answer:${made[0]!.id}`]);
    expect(shared.data.has(`log:answer:${made[1]!.id}`)).toBe(true);
    expect(shared.data.has(`log:answer:${made[2]!.id}`)).toBe(true);
  });

  it('keeps the sentence of a failed call in the list, and stores no separate answer for it', async () => {
    const shared = fakeShared();
    const book = createLogBook({ shared: async () => shared, now: () => T0, writeGapMs: 0 });
    const e = entry(T0, { ok: false, tier: null, method: 'Not started', by: [], text: 'Refused: a private address.' });
    await book.record(e, 'Refused: a private address.');
    expect(shared.writes).toEqual(['log:list', 'log:head']);
    expect((await createLogBook({ shared: async () => shared, now: () => T0 }).read()).entries?.[0]?.text).toBe('Refused: a private address.');
  });

  it('writes a burst of calls in one go', async () => {
    const shared = fakeShared();
    const book = createLogBook({ shared: async () => shared, writeGapMs: 60 });
    const t = Date.now();
    await Promise.all([0, 1, 2, 3, 4, 5].map((i) => book.record(entry(t + i, { ok: false, text: 'failed' }), 'failed')));
    // Six calls at the same moment: one write carries them all.
    expect(shared.writes.filter((k) => k === 'log:list')).toHaveLength(1);
    expect((await book.read()).entries).toHaveLength(6);
    expect(await entriesInNow(shared)).toHaveLength(6);
  });

  it('does not keep a call waiting for the calls that come after it', async () => {
    const shared = fakeShared();
    const book = createLogBook({ shared: async () => shared, writeGapMs: 80 });
    const t = Date.now();
    const started = Date.now();
    const first = book.record(entry(t, { ok: false, text: 'failed' }), 'failed');
    // More calls keep arriving for a while.
    const later: Promise<void>[] = [];
    const more = setInterval(() => later.push(book.record(entry(Date.now(), { ok: false, text: 'failed' }), 'failed')), 20);
    await first;
    const firstDoneAfter = Date.now() - started;
    await new Promise((resolve) => setTimeout(resolve, 300));
    clearInterval(more);
    await Promise.all(later);
    // The first call was done at once, long before the stream of later calls ended.
    expect(firstDoneAfter).toBeLessThan(60);
    expect(later.length).toBeGreaterThan(8);
    expect(await entriesInNow(shared)).toHaveLength(later.length + 1);
  });

  it('leaves a pause between two writes, so calls that follow each other closely share a write', async () => {
    const shared = fakeShared();
    const book = createLogBook({ shared: async () => shared, writeGapMs: 120 });
    const t = Date.now();
    const done: Promise<void>[] = [];
    // Ten calls, one every 15 ms: each arrives after the write before it has long finished.
    for (let i = 0; i < 10; i++) {
      done.push(book.record(entry(t + i, { ok: false, text: 'failed' }), 'failed'));
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    await Promise.all(done);
    const listWrites = shared.writes.filter((k) => k === 'log:list').length;
    expect(listWrites).toBeGreaterThanOrEqual(2);
    expect(listWrites).toBeLessThanOrEqual(3);
    expect(await entriesInNow(shared)).toHaveLength(10);
  });

  it('stays within a few units of the free allowance for each call', async () => {
    const shared = fakeShared();
    const book = createLogBook({ shared: async () => shared, now: () => T0 + 3_600_000, writeGapMs: 0 });
    // Text that does not compress better than real pages do: words in a shuffled order.
    const words = 'the page was read by a helper and cleaned of menus ads banners so an agent can use hydration error server client render mismatch fix'.split(' ');
    let state = 7;
    const prose = (chars: number): string => {
      let out = '';
      while (out.length < chars) {
        state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
        out += `${words[state % words.length]}${state % 9 === 0 ? `${state % 9_973}. ` : ' '}`;
      }
      return out.slice(0, chars);
    };
    // A full list of 100 calls, every one with a different question.
    for (let i = 0; i < 100; i++) {
      await book.record(entry(T0 + i * 1_000, { input: prose(60), options: { max_results: '5', recency: 'week' } }), prose(4_000));
    }
    // One more call with the list full, answered with a whole part of a long page (20,000 characters).
    const before = shared.writeUnits;
    await book.record(entry(T0 + 200_000, { input: 'one more call with the list full' }), prose(20_500));
    expect(shared.writeUnits - before).toBeLessThanOrEqual(5);
  });

  it('never fails a call when the shared memory is down, and shows what this server has', async () => {
    const shared = fakeShared();
    shared.mode = 'throws';
    const book = createLogBook({ shared: async () => shared, now: () => T0, writeGapMs: 0 });
    const e = entry(T0, { input: 'still here' });
    await expect(book.record(e, 'answer')).resolves.toBeUndefined();
    expect(inputs((await book.read()).entries)).toEqual(['still here']);
    expect(await book.answer(e.id)).toBe('answer');
    expect(await book.probe()).toBe('silent');
    // When it comes back, the next write carries everything.
    shared.mode = 'ok';
    await book.record(entry(T0 + 1, { input: 'later' }), 'answer');
    expect(inputs(await entriesIn(shared))).toEqual(['still here', 'later']);
    expect(shared.data.has(`log:answer:${e.id}`)).toBe(true);
  });

  it('tells a working shared memory from one that swallows what it is given', async () => {
    const shared = fakeShared();
    const book = createLogBook({ shared: async () => shared });
    expect(await book.probe()).toBe('works');
    shared.mode = 'silent';
    expect(await book.probe()).toBe('silent');
  });

  it('ignores anything in the shared memory that is not a call', async () => {
    const shared = fakeShared();
    const good = entry(T0, { input: 'a real call' });
    shared.data.set('log:head', { rev: 'x' });
    shared.data.set('log:list', { rev: 'x', entries: [null, 'text', { id: 7 }, { id: 'abc', at: 'yesterday', tool: 'search_web' }, good, { id: newLogId(T0 + 5), at: T0 + 5, tool: 'fetch_url' }] });
    const seen = (await createLogBook({ shared: async () => shared, now: () => T0 + 10 }).read()).entries ?? [];
    expect(seen.map((e) => e.tool)).toEqual(['search_web', 'fetch_url']);
    // An entry from an older Scrapy, with fields missing, is filled in.
    expect(seen[1]).toMatchObject({ from: 'agent', input: '', options: {}, ok: false, tier: null, by: [], steps: [], ms: 0, chars: 0 });
    shared.data.set('log:list', 'not a list at all');
    expect((await createLogBook({ shared: async () => shared, now: () => T0 + 10 }).read()).entries).toEqual([]);
  });
});

/** As entriesIn, for calls that carry the real time of day. */
async function entriesInNow(shared: FakeShared): Promise<LogEntry[]> {
  return (await createLogBook({ shared: async () => shared }).read()).entries ?? [];
}

/** The list as it lies in the shared memory, read the way any server would read it. */
async function entriesIn(shared: FakeShared): Promise<LogEntry[]> {
  return (await createLogBook({ shared: async () => shared, now: () => T0 + 60_000 }).read()).entries ?? [];
}

function trace(over: Partial<TraceReport> = {}): TraceReport {
  return { totalMs: 400, cache: 'miss', route: null, steps: [], contacts: [], hosts: [], ...over };
}

describe('what is written down about a call', () => {
  it('names the method the way the feed shows it', () => {
    expect(methodOf(true, trace({ route: { by: ['Tavily', 'Exa'], browser: false } }))).toEqual({ tier: 1, method: 'Tier 1 (Fast HTTP)', by: ['Tavily', 'Exa'] });
    expect(methodOf(true, trace({ route: { by: ['Jina Reader'], browser: true } }))).toEqual({ tier: 2, method: 'Tier 2 (Real browser)', by: ['Jina Reader'] });
    expect(methodOf(true, trace({ cache: 'hit', route: { by: ['Jina Reader'], browser: false } }))).toEqual({ tier: 0, method: 'Memory', by: ['Jina Reader'] });
    // A failure that Scrapy remembered is still an answer from memory.
    expect(methodOf(false, trace({ cache: 'hit' }))).toEqual({ tier: 0, method: 'Memory', by: [] });
    const steps = [
      { way: 'jina', ok: false, ms: 0, note: 'resting, back in about 5 minutes' },
      { way: 'firecrawl', ok: false, ms: 40, note: 'could not be reached (ECONNRESET)' },
      { way: 'tavily', ok: false, ms: 0, note: 'could not be reached (ECONNRESET)' },
    ];
    expect(methodOf(false, trace({ steps }))).toEqual({ tier: null, method: 'None worked (2 tried)', by: [] });
    expect(methodOf(false, trace({ cache: 'off' }))).toEqual({ tier: null, method: 'Not started', by: [] });
    expect(methodOf(true, trace())).toEqual({ tier: null, method: 'Not recorded', by: [] });
  });

  it('takes the question of a search and the link of a page as the main thing, the rest as options', () => {
    const search = entryOf({
      tool: 'search_web',
      rawArgs: { query: '  how to fix\n hydration error ', max_results: 5, include_sites: ['react.dev', 'nextjs.org'], recency: 'week' },
      from: 'agent',
      at: T0,
      ok: true,
      text: 'x'.repeat(3_204),
      trace: trace({ route: { by: ['Tavily', 'Exa'], browser: false }, steps: [{ way: 'tavily search', ok: true, ms: 310, note: '8 results' }] }),
    });
    expect(search).toMatchObject({
      at: T0,
      tool: 'search_web',
      from: 'agent',
      input: 'how to fix hydration error',
      options: { max_results: '5', include_sites: 'react.dev, nextjs.org', recency: 'week' },
      ok: true,
      tier: 1,
      method: 'Tier 1 (Fast HTTP)',
      by: ['Tavily', 'Exa'],
      steps: [{ way: 'tavily search', ok: true, ms: 310, note: '8 results' }],
      ms: 400,
      chars: 3_204,
    });
    expect(search.text).toBeUndefined();
    expect(isLogId(search.id)).toBe(true);

    const page = entryOf({ tool: 'fetch_url', rawArgs: { url: 'https://example.com/a', browser: true }, from: 'page', at: T0, ok: false, text: 'Not found: the page does not exist.', trace: trace() });
    expect(page).toMatchObject({ tool: 'fetch_url', from: 'page', input: 'https://example.com/a', options: { browser: 'true' }, ok: false, text: 'Not found: the page does not exist.' });
  });

  it('shortens what is long, and copes with input that is not what a tool expects', () => {
    const long = entryOf({ tool: 'search_web', rawArgs: { query: 'q'.repeat(900) }, from: 'agent', at: T0, ok: false, text: 'e'.repeat(5_000), trace: trace() });
    expect(long.input).toHaveLength(300);
    expect(long.input.endsWith('…')).toBe(true);
    expect(long.text).toHaveLength(600);
    expect(long.chars).toBe(5_000);

    expect(entryOf({ tool: 'nope', rawArgs: { anything: [1, 2] }, from: 'page', at: T0, ok: false, text: 'no', trace: trace() })).toMatchObject({ tool: 'nope', input: '{"anything":[1,2]}', options: {} });
    expect(entryOf({ tool: 'search_web', rawArgs: 'just text', from: 'agent', at: T0, ok: false, text: 'no', trace: trace() }).input).toBe('');
    expect(entryOf({ tool: 'fetch_url', rawArgs: { url: 42 }, from: 'agent', at: T0, ok: false, text: 'no', trace: trace() }).input).toBe('{"url":42}');
  });

  it('gives later calls ids that sort later, and never the same id twice', () => {
    const ids = [newLogId(T0), newLogId(T0), newLogId(T0 + 1), newLogId(T0 + 60_000)];
    expect(new Set(ids).size).toBe(4);
    expect(ids.every(isLogId)).toBe(true);
    expect(ids[2]! > ids[0]! && ids[2]! > ids[1]! && ids[3]! > ids[2]!).toBe(true);
    expect(isLogId('../../etc/passwd')).toBe(false);
    expect(isLogId('')).toBe(false);
  });
});

describe('where the log is on', () => {
  it('is on where the page is private, and off on the public address', () => {
    expect(logsOn()).toBe(true);
    process.env.VERCEL_ENV = 'preview';
    expect(logsOn()).toBe(true);
    process.env.VERCEL_ENV = 'development';
    expect(logsOn()).toBe(true);
    process.env.VERCEL_ENV = 'production';
    expect(logsOn()).toBe(false);
  });

  it('follows the setting when there is one', () => {
    process.env.SCRAPY_LOGS = 'off';
    expect(logsOn()).toBe(false);
    process.env.VERCEL_ENV = 'production';
    process.env.SCRAPY_LOGS = 'on';
    expect(logsOn()).toBe(true);
    process.env.SCRAPY_LOGS = 'something else';
    expect(logsOn()).toBe(false);
  });

  it('writes nothing down when it is off', async () => {
    const book = createLogBook({ now: () => T0 });
    const call = { tool: 'search_web', rawArgs: { query: 'secret' }, from: 'agent' as const, at: T0, ok: true, text: 'answer', trace: trace({ route: { by: ['Tavily'], browser: false } }) };
    process.env.SCRAPY_LOGS = 'off';
    logCall(call, book);
    expect((await book.read()).entries).toEqual([]);
    delete process.env.SCRAPY_LOGS;
    logCall(call, book);
    expect(inputs((await book.read()).entries)).toEqual(['secret']);
  });
});

describe('the address behind the feed', () => {
  const get = async (query = ''): Promise<{ status: number; body: Record<string, unknown>; cache: string | null }> => {
    const res = await logs(new Request(`https://scrapy.test/api/logs${query}`));
    return { status: res.status, body: (await res.json()) as Record<string, unknown>, cache: res.headers.get('cache-control') };
  };
  const call = (input: string, at: number, ok = true) => ({ tool: 'search_web', rawArgs: { query: input }, from: 'agent' as const, at, ok, text: ok ? `answer to ${input}` : 'It failed.', trace: trace({ route: { by: ['Tavily'], browser: false } }) });

  it('lists the calls, then says "nothing changed" until there is a new one', async () => {
    const now = Date.now();
    logCall(call('first', now - 2_000));
    logCall(call('second', now - 1_000));
    const first = await get();
    expect(first.status).toBe(200);
    expect(first.cache).toBe('no-store');
    expect(first.body).toMatchObject({ on: true, keep: 100, hours: 24, where: 'memory' });
    expect(inputs(first.body.entries as LogEntry[])).toEqual(['first', 'second']);

    const again = await get(`?rev=${encodeURIComponent(String(first.body.rev))}`);
    expect(again.body).toMatchObject({ on: true, rev: first.body.rev, entries: null });

    logCall(call('third', now));
    const third = await get(`?rev=${encodeURIComponent(String(first.body.rev))}`);
    expect(inputs(third.body.entries as LogEntry[])).toEqual(['first', 'second', 'third']);
  });

  it('gives the answer of a call in the shape an agent receives', async () => {
    logCall(call('the question', Date.now()));
    logCall(call('a failing one', Date.now(), false));
    const list = (await get()).body.entries as LogEntry[];
    const found = await get(`?id=${list[0]!.id}`);
    expect(found.body).toEqual({ on: true, found: true, response: { content: [{ type: 'text', text: 'answer to the question' }] } });
    // A failed call carries its sentence in the list. Nothing more is kept for it.
    expect(list[1]).toMatchObject({ ok: false, text: 'It failed.' });
    expect((await get(`?id=${list[1]!.id}`)).body).toEqual({ on: true, found: false });
    expect((await get(`?id=${newLogId(Date.now())}`)).body).toEqual({ on: true, found: false });
    expect((await get('?id=..%2F..%2Fsecret')).body).toEqual({ on: true, found: false });
  });

  it('reports whether a shared memory carries the log', async () => {
    expect((await get('?probe=1')).body).toEqual({ on: true, shared: 'none' });
  });

  it('does not take the stand-in inside the process for the shared memory', async () => {
    // As if on Vercel, but without Vercel handing over its shared memory.
    process.env.VERCEL = '1';
    try {
      expect(sharedIsReal()).toBe(false);
      expect((await get('?probe=1')).body).toEqual({ on: true, shared: 'missing' });
      // Switched off on purpose is said as such.
      process.env.SCRAPY_SHARED_CACHE = 'off';
      expect((await get('?probe=1')).body).toEqual({ on: true, shared: 'none' });
      delete process.env.SCRAPY_SHARED_CACHE;

      // Handed over the way a running server gets it: with the request.
      const key = Symbol.for('@vercel/request-context');
      const holder = globalThis as unknown as Record<symbol, unknown>;
      const kept = new Map<string, unknown>();
      const told: { name?: string; ttl?: number }[] = [];
      holder[key] = {
        get: () => ({
          cache: {
            get: async (k: string) => kept.get(k) ?? null,
            set: async (k: string, v: unknown, options: { name?: string; ttl?: number }) => {
              told.push(options);
              kept.set(k, JSON.parse(JSON.stringify(v)));
            },
            delete: async (k: string) => void kept.delete(k),
          },
        }),
      };
      try {
        expect(sharedIsReal()).toBe(true);
        expect((await get('?probe=1')).body).toEqual({ on: true, shared: 'works' });
        // What was written went to the memory Vercel handed over, under a name made by Scrapy.
        expect([...kept.keys()].every((k) => /^scrapy\$[0-9a-f]{40}$/.test(k))).toBe(true);
        expect(kept.size).toBe(1);

        // A whole call through it: Vercel is told the kind of each value and how long to keep it,
        // never the key itself, which would give away what was asked.
        told.length = 0;
        logCall(call('a private question', Date.now()));
        await (await getLogBook().read()).entries;
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(told.length).toBe(3);
        expect(told.every((options) => options.name === 'log' && options.ttl === 86_400)).toBe(true);
        expect(JSON.stringify([...kept.entries()])).not.toContain('a private question');
      } finally {
        delete holder[key];
      }
      // Handed over the way a build gets it: through the environment.
      process.env.RUNTIME_CACHE_ENDPOINT = 'https://cache.example/';
      process.env.RUNTIME_CACHE_HEADERS = '{}';
      expect(sharedIsReal()).toBe(true);
    } finally {
      delete process.env.VERCEL;
      delete process.env.RUNTIME_CACHE_ENDPOINT;
      delete process.env.RUNTIME_CACHE_HEADERS;
      delete process.env.SCRAPY_SHARED_CACHE;
    }
  });

  it('shows nothing on the public address, and nothing when switched off', async () => {
    logCall(call('private question', Date.now()));
    process.env.VERCEL_ENV = 'production';
    // Closed: the same answer as every other address of a closed Scrapy.
    const closed = await get();
    expect(closed.status).toBe(403);
    expect(closed.body.open).toBe(false);
    expect(JSON.stringify(closed.body)).not.toContain('private question');
    // Open to everybody: the log stays off.
    process.env.SCRAPY_OPEN = '1';
    const open = await get();
    expect(open.body).toEqual({ on: false, why: 'public' });
    expect((await get('?probe=1')).body).toEqual({ on: false, why: 'public' });
    const list = (await getLogBook().read()).entries ?? [];
    expect((await get(`?id=${list[0]!.id}`)).body).toEqual({ on: false, why: 'public' });

    delete process.env.VERCEL_ENV;
    process.env.SCRAPY_LOGS = 'off';
    expect((await get()).body).toEqual({ on: false, why: 'setting' });
  });
});

describe('the shared memory', () => {
  it('names keys so that two different keys never share a name', () => {
    const names = new Set<string>();
    for (let i = 0; i < 20_000; i++) names.add(sharedKeyName(`page:markdown:plain:https://example.com/${i}`));
    expect(names.size).toBe(20_000);
    expect(sharedKeyName('log:list')).toMatch(/^[0-9a-f]{40}$/);
    expect(sharedKeyName('log:list')).toBe(sharedKeyName('log:list'));
  });
});
