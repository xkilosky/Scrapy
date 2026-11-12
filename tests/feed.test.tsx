// @vitest-environment jsdom
/**
 * The live feed, in a browser-like environment. Scrapy's side (/api/logs) is a stand-in
 * that keeps a list of calls and answers the way the real address does.
 */
process.env.TZ = 'America/Guatemala';

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CheckPage from '@/app/page';
import { clock, LogsView, pollDelay, took } from '@/app/ui/LogsView';
import { MENU } from '@/app/ui/menu';
import type { LogEntry } from '@/lib/logs';

/** 11:45:02 AM in Guatemala. */
const T0 = Date.UTC(2026, 10, 11, 17, 45, 2);

let n = 0;
function entry(over: Partial<LogEntry> = {}): LogEntry {
  n += 1;
  return {
    id: `0mh2k3j5x-${String(n).padStart(7, '0')}`,
    at: T0 + n * 1_000,
    tool: 'search_web',
    from: 'agent',
    input: 'how to fix hydration error',
    options: {},
    ok: true,
    tier: 1,
    method: 'Tier 1 (Fast HTTP)',
    by: ['Tavily', 'Exa'],
    steps: [
      { way: 'tavily search', ok: true, ms: 310, note: '8 results' },
      { way: 'exa search', ok: true, ms: 402, note: '10 results' },
    ],
    ms: 412,
    chars: 3_204,
    ...over,
  };
}

const server = {
  entries: [] as LogEntry[],
  rev: 0,
  answers: new Map<string, string>(),
  mode: 'on' as 'on' | 'public' | 'setting' | 'down' | 'closed',
  where: 'memory' as 'memory' | 'vercel',
  shared: 'works' as 'works' | 'silent' | 'missing' | 'none',
  asked: [] as string[],
  add(e: LogEntry, answer?: string): LogEntry {
    server.entries.push(e);
    server.rev += 1;
    if (answer !== undefined) server.answers.set(e.id, answer);
    return e;
  },
};

const logCalls = (): string[] => server.asked.filter((u) => u.startsWith('/api/logs'));

beforeEach(() => {
  n = 0;
  Object.assign(server, { entries: [], rev: 0, answers: new Map(), mode: 'on', where: 'memory', shared: 'works', asked: [] });
  window.history.replaceState(null, '', '/');
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      server.asked.push(url);
      if (url === '/api/status') {
        return Response.json({ name: 'scrapy', version: '0.1.0', open: true, mode: 'safe', tools: [], limits: { visitorPerMinute: 30, dailyCalls: 1500 }, usage: { today: 0 }, where: { vercel: false, env: null, region: null } });
      }
      if (!url.startsWith('/api/logs')) return new Response('not found', { status: 404 });
      if (server.mode === 'down') throw new TypeError('fetch failed');
      if (server.mode === 'closed') return Response.json({ ok: false, open: false, text: 'Scrapy is closed at this address.' }, { status: 403 });
      if (server.mode !== 'on') return Response.json({ on: false, why: server.mode });
      const query = new URL(url, 'http://scrapy.test').searchParams;
      const id = query.get('id');
      if (id !== null) {
        const text = server.answers.get(id);
        return Response.json(text === undefined ? { on: true, found: false } : { on: true, found: true, response: { content: [{ type: 'text', text }] } });
      }
      if (query.get('probe') === '1') return Response.json({ on: true, shared: server.shared });
      const rev = `r${server.rev}`;
      return Response.json({ on: true, rev, entries: query.get('rev') === rev ? null : server.entries, keep: 100, hours: 24, where: server.where });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
});

const user = () => userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
const pass = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const lines = (): string[][] => screen.queryAllByRole('button', { expanded: false }).concat(screen.queryAllByRole('button', { expanded: true })).filter((b) => b.className === 'log-row').map((b) => [...b.children].slice(1).map((c) => c.textContent ?? ''));
const lineOf = (text: string): HTMLElement => screen.getByText(text).closest('button') as HTMLElement;
const fieldsOf = (card: HTMLElement): Record<string, string> => Object.fromEntries([...card.querySelectorAll('.log-field')].map((f) => [(f.querySelector('dt')?.textContent ?? '').replace(/^[^A-Za-z]+/, ''), (f.querySelector('dd')?.textContent ?? '').replace(/\s+/g, ' ').trim()]));

describe('small pieces', () => {
  it('asks every 2 seconds while calls come in, and less often when it is quiet', () => {
    expect(pollDelay(0)).toBe(2_000);
    expect(pollDelay(119_000)).toBe(2_000);
    expect(pollDelay(120_000)).toBe(5_000);
    expect(pollDelay(599_000)).toBe(5_000);
    expect(pollDelay(600_000)).toBe(15_000);
    expect(pollDelay(86_400_000)).toBe(15_000);
  });

  it('writes a time as "11:45:02 AM" and a duration as "0.4s"', () => {
    expect(clock(T0)).toBe('11:45:02 AM');
    expect(clock(T0 + 3_600_000 + 5_000)).toBe('12:45:07 PM');
    expect(took(412)).toBe('0.4s');
    expect(took(2_349)).toBe('2.3s');
    expect(took(45)).toBe('45ms');
    expect(took(0)).toBe('0ms');
    expect(took(100)).toBe('0.1s');
  });
});

describe('the drawer', () => {
  it('has a second section, Logs, that opens the live feed', async () => {
    expect(MENU.slice(0, 2).map((section) => `${section.title}: ${section.items.map((item) => item.label).join(', ')}`)).toEqual(['Dashboard: Run checks, The address for your agent, Try a tool', 'Logs: Live feed']);
    server.add(entry());
    const u = user();
    render(<CheckPage />);
    // The feed is not showing yet, and asks nothing.
    await pass(5_000);
    expect(logCalls()).toEqual([]);

    await u.click(screen.getByRole('button', { name: 'Open menu' }));
    const menu = screen.getByRole('dialog', { name: 'Menu' });
    expect(
      within(menu)
        .getAllByRole('heading', { level: 2 })
        .map((h) => h.textContent)
        .slice(0, 2),
    ).toEqual(['Dashboard', 'Logs']);
    await u.click(within(within(menu).getByRole('list', { name: 'Logs' })).getByRole('link', { name: 'Live feed' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Live feed' })).toBeTruthy();
    expect(window.location.hash).toBe('#logs');
    expect(await screen.findByText('how to fix hydration error')).toBeTruthy();
    expect(logCalls()[0]).toBe('/api/logs');
  });

  it('keeps the feed as it was while another part of the page shows, and asks nothing meanwhile', async () => {
    const first = server.add(entry({ input: 'the first call' }));
    window.history.replaceState(null, '', '/#logs');
    const u = user();
    render(<CheckPage />);
    await u.click(await screen.findByRole('button', { name: /the first call/ }));
    expect(document.getElementById(`log-${first.id}`)).toBeTruthy();

    window.location.hash = '#address';
    await screen.findByRole('heading', { level: 1, name: 'The address for your agent' });
    server.asked.length = 0;
    server.add(entry({ input: 'made while the address was showing' }));
    await pass(20_000);
    expect(logCalls()).toEqual([]);

    window.location.hash = '#logs';
    await screen.findByRole('heading', { level: 1, name: 'Live feed' });
    // The unfolded card is still unfolded, and the call made meanwhile arrives.
    expect(document.getElementById(`log-${first.id}`)).toBeTruthy();
    expect(await screen.findByText('made while the address was showing')).toBeTruthy();
  });
});

describe('the live feed', () => {
  it('shows one line for each call: time, tool, query, method, duration, result', async () => {
    server.add(entry());
    server.add(entry({ tool: 'fetch_url', input: 'https://example.com/js/', tier: 2, method: 'Tier 2 (Real browser)', by: ['Jina Reader'], ms: 2_349 }));
    server.add(entry({ tier: 0, method: 'Memory', ms: 1, steps: [] }));
    server.add(entry({ tool: 'fetch_url', input: 'http://192.168.1.1/admin', ok: false, tier: null, method: 'Not started', by: [], steps: [], ms: 0, text: 'Refused: a private address.' }));
    server.add(entry({ tool: 'fetch_url', input: 'https://example.com/down', ok: false, tier: null, method: 'None worked (3 tried)', by: [], ms: 45, text: 'The free services are busy.' }));
    render(<LogsView active />);
    await screen.findByText('https://example.com/js/');
    expect(lines()).toEqual([
      ['11:45:03 AM', 'search_web', 'how to fix hydration error', 'Tier 1 · Tavily + Exa', '0.4s', 'OK'],
      ['11:45:04 AM', 'fetch_url', 'https://example.com/js/', 'Tier 2 · Jina Reader', '2.3s', 'OK'],
      ['11:45:05 AM', 'search_web', 'how to fix hydration error', 'Memory', '1ms', 'OK'],
      ['11:45:06 AM', 'fetch_url', 'http://192.168.1.1/admin', 'Not started', '0ms', 'FAILED'],
      ['11:45:07 AM', 'fetch_url', 'https://example.com/down', 'None worked', '45ms', 'FAILED'],
    ]);
    expect(screen.getByRole('status').textContent).toBe('LIVE');
    expect(screen.getByText('5 calls')).toBeTruthy();
    expect(screen.getByRole('log', { name: 'Tool calls, the newest at the bottom' })).toBeTruthy();
    expect(screen.getByText(/Kept: the last 100 calls, for up to 24 hours\. Everybody who can open this page can read them\./)).toBeTruthy();
  });

  it('is live: a new call appears by itself, and asking costs little while nothing happens', async () => {
    server.add(entry({ input: 'already there' }));
    render(<LogsView active />);
    await screen.findByText('already there');
    expect(logCalls()).toEqual(['/api/logs']);

    // Nothing new: the feed asks again after two seconds, with the rev it has, and gets "nothing changed".
    await pass(2_000);
    await pass(2_000);
    expect(logCalls()).toEqual(['/api/logs', '/api/logs?rev=r1', '/api/logs?rev=r1']);
    expect(lines()).toHaveLength(1);

    server.add(entry({ input: 'made a moment ago' }));
    await pass(2_000);
    expect(await screen.findByText('made a moment ago')).toBeTruthy();
    expect(lines().map((l) => l[2])).toEqual(['already there', 'made a moment ago']);
    expect(screen.getByText('2 calls')).toBeTruthy();
  });

  it('lists calls by when they were made, also when a slow one arrives late', async () => {
    const quick = entry({ input: 'quick, made second' });
    const slow = entry({ input: 'slow, made first', at: quick.at - 500 });
    server.add(quick);
    render(<LogsView active />);
    await screen.findByText('quick, made second');
    server.add(slow);
    await pass(2_000);
    await screen.findByText('slow, made first');
    expect(lines().map((l) => l[2])).toEqual(['slow, made first', 'quick, made second']);
  });

  it('asks less often when it has been quiet for a while', async () => {
    render(<LogsView active />);
    await screen.findByText(/No calls yet/);
    server.asked.length = 0;
    await pass(120_000);
    // Two minutes at one question every two seconds.
    expect(logCalls().length).toBeGreaterThanOrEqual(58);
    expect(logCalls().length).toBeLessThanOrEqual(60);
    server.asked.length = 0;
    await pass(60_000);
    // Then one every five seconds.
    expect(logCalls().length).toBeGreaterThanOrEqual(11);
    expect(logCalls().length).toBeLessThanOrEqual(13);
    await pass(8 * 60_000);
    server.asked.length = 0;
    await pass(60_000);
    // After ten quiet minutes, one every fifteen seconds.
    expect(logCalls().length).toBeGreaterThanOrEqual(3);
    expect(logCalls().length).toBeLessThanOrEqual(5);
    // A new call makes it quick again.
    server.add(entry({ input: 'after a long silence' }));
    await pass(15_000);
    await screen.findByText('after a long silence');
    server.asked.length = 0;
    await pass(10_000);
    expect(logCalls().length).toBeGreaterThanOrEqual(4);
  });

  it('unfolds a line into a card: timestamp, tool, query, method, duration, and the rest', async () => {
    const e = server.add(entry({ options: { max_results: '5', recency: 'week' } }));
    const u = user();
    render(<LogsView active />);
    const line = await screen.findByRole('button', { name: /how to fix hydration error/ });
    expect(line.getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById(`log-${e.id}`)).toBeNull();

    await u.click(line);
    expect(line.getAttribute('aria-expanded')).toBe('true');
    expect(line.getAttribute('aria-controls')).toBe(`log-${e.id}`);
    const card = document.getElementById(`log-${e.id}`) as HTMLElement;
    expect([...card.querySelectorAll('dt')].map((dt) => dt.textContent)).toEqual(['⏱️Timestamp', '⚙️Tool', '🔍Query', '🏎️Method', '⏱️Duration', '✅Result', '👤Called by', '📦Payload']);
    expect(fieldsOf(card)).toEqual({
      Timestamp: '11:45:03 AM Nov 11, 2026',
      Tool: 'search_web',
      Query: '"how to fix hydration error"max_results: 5 · recency: week',
      Method: 'Tier 1 (Fast HTTP) · Tavily + Exaok tavily search 0.3s 8 resultsok exa search 0.4s 10 results',
      Duration: '0.4s',
      Result: 'OK · 3,204 characters',
      'Called by': 'An agent, over MCP',
      Payload: '[ ↓ Expand to view JSON response ]',
    });
    // The pictures are decoration: a screen reader gets the words.
    expect([...card.querySelectorAll('.log-icon')].every((icon) => icon.getAttribute('aria-hidden') === 'true')).toBe(true);

    await u.click(line);
    expect(line.getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById(`log-${e.id}`)).toBeNull();
  });

  it('words the card for a page, for memory, for a call from "Try a tool", and for a failure', async () => {
    const page = server.add(entry({ tool: 'fetch_url', input: 'https://example.com/a', from: 'page', tier: 0, method: 'Memory', by: ['Jina Reader'], steps: [] }));
    const bad = server.add(
      entry({ tool: 'fetch_url', input: 'https://example.com/b', ok: false, tier: null, method: 'None worked (2 tried)', by: [], text: 'The free services are busy. Try again in about 10 minutes.', steps: [{ way: 'jina', ok: false, ms: 0, note: 'resting, back in about 9 minutes' }, { way: 'firecrawl', ok: false, ms: 812, note: 'busy (Rate limit exceeded)' }] }),
    );
    const u = user();
    render(<LogsView active />);
    await u.click(await screen.findByRole('button', { name: /example\.com\/a/ }));
    await u.click(screen.getByRole('button', { name: /example\.com\/b/ }));

    expect(fieldsOf(document.getElementById(`log-${page.id}`) as HTMLElement)).toMatchObject({ URL: 'https://example.com/a', Method: 'Memory · first answered by Jina Reader', 'Called by': 'The "Try a tool" box on this page' });
    const failed = document.getElementById(`log-${bad.id}`) as HTMLElement;
    expect(fieldsOf(failed)).toMatchObject({
      URL: 'https://example.com/b',
      Method: 'None worked (2 tried)no jina 0ms resting, back in about 9 minutesno firecrawl 0.8s busy (Rate limit exceeded)',
      Result: 'Failed · The free services are busy. Try again in about 10 minutes.',
    });
    expect(failed.querySelector('dt')?.closest('dl')?.textContent).toContain('❌');
  });

  it('unfolds the payload into the JSON response the agent got, fetched only then', async () => {
    const answer = '8 results for "how to fix hydration error" (asked tavily and exa, 0.4 s)\n\n1. Hydration docs\n   https://nextjs.org/docs';
    const e = server.add(entry(), answer);
    const u = user();
    render(<LogsView active />);
    await u.click(await screen.findByRole('button', { name: /how to fix hydration error/ }));
    expect(logCalls().some((url) => url.includes('id='))).toBe(false);

    const toggle = screen.getByRole('button', { name: '[ ↓ Expand to view JSON response ]' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await u.click(toggle);
    const shown = await screen.findByLabelText('Response of search_web, as JSON');
    expect(JSON.parse(shown.textContent ?? '')).toEqual({ content: [{ type: 'text', text: answer }] });
    expect(shown.textContent).toBe(JSON.stringify({ content: [{ type: 'text', text: answer }] }, null, 2));
    expect(logCalls().filter((url) => url.includes('id='))).toEqual([`/api/logs?id=${e.id}`]);
    expect(screen.getByRole('button', { name: '[ ↑ Fold the JSON response ]' }).getAttribute('aria-expanded')).toBe('true');

    // The same answer as text, with its line breaks.
    await u.click(screen.getByRole('button', { name: 'Text' }));
    expect(screen.getByLabelText('Response of search_web, as text').textContent).toBe(answer);
    expect(screen.getByRole('button', { name: 'Text' }).getAttribute('aria-pressed')).toBe('true');

    // Folded and unfolded again: nothing is fetched twice.
    await u.click(screen.getByRole('button', { name: '[ ↑ Fold the JSON response ]' }));
    expect(screen.queryByLabelText(/Response of search_web/)).toBeNull();
    await u.click(screen.getByRole('button', { name: '[ ↓ Expand to view JSON response ]' }));
    expect(await screen.findByLabelText('Response of search_web, as JSON')).toBeTruthy();
    expect(logCalls().filter((url) => url.includes('id='))).toHaveLength(1);
  });

  it('shows the payload of a failed call without fetching, marked as an error', async () => {
    server.add(entry({ tool: 'fetch_url', input: 'http://192.168.1.1/admin', ok: false, tier: null, method: 'Not started', by: [], steps: [], text: 'Refused: "192.168.1.1" is a private or internal address.' }));
    const u = user();
    render(<LogsView active />);
    await u.click(await screen.findByRole('button', { name: /192\.168\.1\.1/ }));
    await u.click(screen.getByRole('button', { name: '[ ↓ Expand to view JSON response ]' }));
    expect(JSON.parse(screen.getByLabelText('Response of fetch_url, as JSON').textContent ?? '')).toEqual({ content: [{ type: 'text', text: 'Refused: "192.168.1.1" is a private or internal address.' }], isError: true });
    expect(logCalls().some((url) => url.includes('id='))).toBe(false);
  });

  it('says so when a response is no longer kept', async () => {
    server.add(entry());
    const u = user();
    render(<LogsView active />);
    await u.click(await screen.findByRole('button', { name: /how to fix hydration error/ }));
    await u.click(screen.getByRole('button', { name: '[ ↓ Expand to view JSON response ]' }));
    expect(await screen.findByText(/This response is no longer kept\./)).toBeTruthy();
  });

  it('pauses and resumes', async () => {
    server.add(entry({ input: 'before the pause' }));
    const u = user();
    render(<LogsView active />);
    await screen.findByText('before the pause');
    await u.click(screen.getByRole('button', { name: 'Pause' }));
    expect(screen.getByRole('status').textContent).toBe('PAUSED');
    expect(screen.queryByText('waiting for the next call')).toBeNull();
    server.asked.length = 0;
    server.add(entry({ input: 'made during the pause' }));
    await pass(30_000);
    expect(logCalls()).toEqual([]);
    expect(screen.queryByText('made during the pause')).toBeNull();

    await u.click(screen.getByRole('button', { name: 'Resume' }));
    expect(await screen.findByText('made during the pause')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('LIVE');
  });

  it('asks nothing while its tab is in the background, and at once when the tab is back', async () => {
    server.add(entry({ input: 'seen before leaving' }));
    render(<LogsView active />);
    await screen.findByText('seen before leaving');

    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    server.asked.length = 0;
    server.add(entry({ input: 'made while away' }));
    await pass(60_000);
    expect(logCalls()).toEqual([]);

    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    expect(await screen.findByText('made while away')).toBeTruthy();
  });

  it('asks nothing when it is opened in a background tab, until the tab is looked at', async () => {
    server.add(entry({ input: 'waiting to be seen' }));
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    render(<LogsView active />);
    await pass(30_000);
    expect(logCalls()).toEqual([]);
    expect(screen.getByRole('status').textContent).toBe('CONNECTING');

    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    expect(await screen.findByText('waiting to be seen')).toBeTruthy();
  });

  it('Clear empties the screen; calls made afterwards still show', async () => {
    server.add(entry({ input: 'an old call' }));
    const u = user();
    render(<LogsView active />);
    await screen.findByText('an old call');
    await u.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.queryByText('an old call')).toBeNull();
    expect(screen.getByText('0 calls')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Clear' }) as HTMLButtonElement).disabled).toBe(true);
    server.add(entry({ input: 'a new call' }));
    await pass(2_000);
    expect(await screen.findByText('a new call')).toBeTruthy();
    expect(screen.queryByText('an old call')).toBeNull();
  });

  it('says what to do while there are no calls yet', async () => {
    render(<LogsView active />);
    expect(await screen.findByText(/No calls yet\. A call shows up here the moment Scrapy has answered it\./)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Try a tool' }).getAttribute('href')).toBe('#try');
    expect(screen.getByText('waiting for the next call')).toBeTruthy();
    expect(screen.getByText(/keeps them in its own memory, so the feed is empty again after a restart/)).toBeTruthy();
  });

  it('keeps trying when Scrapy does not answer, and says so', async () => {
    server.add(entry({ input: 'seen before the trouble' }));
    render(<LogsView active />);
    await screen.findByText('seen before the trouble');
    server.mode = 'down';
    await pass(2_000);
    expect(await screen.findByText(/Scrapy did not answer the last time the feed asked for news/)).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('NO ANSWER');
    expect(screen.getByText('seen before the trouble')).toBeTruthy();

    server.mode = 'on';
    server.add(entry({ input: 'after the trouble' }));
    await pass(5_000);
    expect(await screen.findByText('after the trouble')).toBeTruthy();
    expect(screen.queryByText(/did not answer the last time/)).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('LIVE');
  });
});

describe('where the log is off', () => {
  it('explains it on the public address, and stops asking', async () => {
    server.mode = 'public';
    render(<LogsView active />);
    expect(await screen.findByRole('heading', { name: 'The log is off at this address' })).toBeTruthy();
    expect(screen.getByText(/This is Scrapy's public address\..*So Scrapy writes nothing down here\./)).toBeTruthy();
    server.asked.length = 0;
    await pass(60_000);
    expect(logCalls()).toEqual([]);
  });

  it('explains it when it is switched off with the setting', async () => {
    server.mode = 'setting';
    render(<LogsView active />);
    expect(await screen.findByText(/switched off with the setting/)).toBeTruthy();
    expect(screen.getByText('SCRAPY_LOGS=off')).toBeTruthy();
  });

  it('shows nothing at all where Scrapy is closed', async () => {
    server.mode = 'closed';
    const { container } = render(<LogsView active />);
    await waitFor(() => expect(container.textContent).toBe(''));
  });
});

describe('on Vercel', () => {
  it('checks once that the shared memory carries the log, and warns when it does not', async () => {
    server.where = 'vercel';
    server.shared = 'silent';
    render(<LogsView active />);
    expect(await screen.findByText(/Vercel's shared memory is not answering here, so calls cannot be shown\./)).toBeTruthy();
    expect(logCalls().filter((url) => url.includes('probe=1'))).toHaveLength(1);
    expect(screen.queryByText(/keeps them in its own memory/)).toBeNull();
    await pass(10_000);
    expect(logCalls().filter((url) => url.includes('probe=1'))).toHaveLength(1);
  });

  it('warns when Vercel has not handed the server its shared memory, or when it is switched off', async () => {
    server.where = 'vercel';
    server.shared = 'missing';
    render(<LogsView active />);
    expect(await screen.findByText(/Vercel has not handed this server its shared memory, so calls handled by other servers cannot be shown here\./)).toBeTruthy();
    cleanup();

    server.shared = 'none';
    render(<LogsView active />);
    expect(await screen.findByText(/The shared memory is switched off with SCRAPY_SHARED_CACHE=off\./)).toBeTruthy();
  });

  it('says nothing about the shared memory when it works', async () => {
    server.where = 'vercel';
    render(<LogsView active />);
    await waitFor(() => expect(logCalls().some((url) => url.includes('probe=1'))).toBe(true));
    await pass(1_000);
    expect(screen.queryByText(/shared memory is not answering/)).toBeNull();
  });
});
