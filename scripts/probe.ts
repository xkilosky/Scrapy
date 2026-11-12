/**
 * Optional check during a Vercel build.
 *
 * With SCRAPY_BUILD_PROBE=1 set, the build asks every free helper one small
 * thing and writes the result into the build log. Then it starts the freshly
 * built Scrapy and calls it once over MCP, like an agent would. Last, it tries
 * Vercel's shared memory, which carries the log of tool calls.
 *
 * With SCRAPY_BUILD_PROBE=memory it only tries the shared memory, and contacts
 * no helper.
 *
 * It never fails the build, and without the setting it does nothing at all.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { runChecks } from '../lib/check';
import { createLogBook, newLogId, type LogEntry } from '../lib/logs';
import { sharedIsReal, sharedLayer } from '../lib/store';

const PORT = 3999;
const say = (line: string): void => console.log(`[probe] ${line}`);
const oneLine = (text: string, max: number): string => text.replace(/\s*\n\s*/g, ' ⏎ ').slice(0, max);

async function helperChecks(): Promise<void> {
  const report = await runChecks({ debug: true });
  // A few dense lines instead of many short ones: the build log is read through a narrow window.
  say(`position=${report.mode} took=${report.tookMs}ms requests=${report.contacts.length} hosts=${report.hosts.join(',')}`);
  say(`helpers: ${report.helpers.map((h) => `${h.id}/${h.job} ${h.answers ? `OK ${h.ms}ms` : `NO ANSWER ${h.ms}ms (${oneLine(h.note, 110)})`}`).join('; ')}`);
  say(`speed: ${report.speed.map((s) => `${s.what}: ${s.ok ? 'ok' : 'FAILED'} ${s.ms}ms of ${s.targetMs}ms (${oneLine(s.note, 130)})`).join('; ')}`);
  say(`fallback: ${report.fallback.map((f) => `${f.what}: ${f.ok ? 'works' : 'FAILED'} ${f.ms}ms (${oneLine(f.note, 130)})`).join('; ')}`);
  say(`safe position: applies=${report.safe.applies} ok=${report.safe.ok} | ${report.safe.note}`);
  // The start of a helper's raw answer, to compare with what Scrapy expects. Only for helpers
  // that did not answer, unless SCRAPY_BUILD_PROBE_SAMPLES=1 asks for all of them.
  const all = process.env.SCRAPY_BUILD_PROBE_SAMPLES === '1';
  const failed = new Set(report.helpers.filter((h) => !h.answers).map((h) => `${h.id} ${h.job}`));
  const shown = new Set<string>();
  for (const s of report.samples ?? []) {
    if (shown.has(s.who) || !(all || failed.has(s.who))) continue;
    shown.add(s.who);
    say(`sample ${s.who}: ${oneLine(s.text, 420)}`);
  }
}

async function waitUntilUp(url: string, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function overMcp(): Promise<void> {
  let child: ChildProcess | undefined;
  try {
    child = spawn('npx', ['next', 'start', '-p', String(PORT), '-H', '127.0.0.1'], { stdio: 'ignore', detached: true });
    if (!(await waitUntilUp(`http://127.0.0.1:${PORT}/api/status`, 25_000))) {
      say('mcp: the built app did not start in time, skipped');
      return;
    }
    const client = new Client({ name: 'scrapy-build-probe', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/api/mcp`)));
    const { tools } = await client.listTools();
    say(`mcp tools: ${tools.map((t) => t.name).join(', ')}`);
    // A different question in every build, so the search is done for real and not answered from memory.
    const questions = ['react useEffect cleanup function', 'css grid vs flexbox when to use', 'typescript satisfies operator example', 'node fetch timeout AbortController', 'postgres upsert on conflict example'];
    const pick = Number.parseInt((process.env.VERCEL_GIT_COMMIT_SHA ?? '0').slice(0, 6), 16) || 0;
    const calls: [string, Record<string, unknown>, number][] = [
      ['search_web', { query: questions[pick % questions.length] ?? 'react useEffect cleanup function', max_results: 5 }, 620],
      ['fetch_url', { url: 'https://quotes.toscrape.com/js/' }, 300],
      ['fetch_url', { url: 'https://react.dev/reference/react/useEffect', focus: 'cleanup function' }, 420],
      // The same long page without a focus: it must come back in numbered parts.
      ['fetch_url', { url: 'https://react.dev/reference/react/useEffect' }, 330],
      ['fetch_url', { url: 'http://169.254.169.254/latest/meta-data/' }, 200],
    ];
    for (const [name, args, show] of calls) {
      const started = Date.now();
      const result = await client.callTool({ name, arguments: args });
      const text = (result.content as { text?: string }[]).map((b) => b.text ?? '').join('\n');
      say(`mcp ${name} ${JSON.stringify(args)}: isError=${result.isError === true} ${Date.now() - started}ms ${text.length} chars | ${oneLine(text, show)}`);
    }
    await client.close();
  } finally {
    if (child?.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }
  }
}

/**
 * Vercel's shared memory, tried for real: does it take a value and give it
 * back, how fast, and does the log of tool calls travel through it from two
 * servers to a third. It writes under names of its own and removes them again,
 * so the real log is not touched.
 */
async function sharedMemory(): Promise<void> {
  const layer = await sharedLayer();
  if (!layer) {
    say('memory: there is no shared memory here (not on Vercel, or SCRAPY_SHARED_CACHE=off)');
    return;
  }
  // During a build the shared memory is reached over HTTP, and only when Vercel hands the build the address for it.
  const handed = sharedIsReal();
  say(`memory: address for the build ${handed ? 'given' : 'NOT given: the answers below come from a stand-in inside this process, and prove nothing'} | environment=${process.env.VERCEL_ENV ?? 'unknown'} region=${process.env.VERCEL_REGION ?? 'unknown'}`);

  const run = Date.now().toString(36);
  const key = `probe:${run}:value`;
  const value = { text: 'héllo, wörld ✓', n: 1, list: [1, 2, 3], nested: { yes: true, nothing: null } };
  const timed = async <T>(work: () => Promise<T>): Promise<[T, number]> => {
    const started = Date.now();
    const result = await work();
    return [result, Date.now() - started];
  };

  const [, setMs] = await timed(() => layer.set(key, value, 120));
  const [back, getMs] = await timed(() => layer.get(key));
  const same = JSON.stringify(back) === JSON.stringify(value);
  const [missing, missMs] = await timed(() => layer.get(`probe:${run}:never-written`));
  say(`memory: write ${setMs}ms, read ${getMs}ms, came back ${same ? 'the same' : `DIFFERENT: ${oneLine(JSON.stringify(back), 200)}`} | a key never written reads as ${JSON.stringify(missing)} in ${missMs}ms`);

  // Is a value there the moment it was written? Eight rounds, each a new value under the same key.
  let fresh = 0;
  const waits: number[] = [];
  for (let i = 1; i <= 8; i++) {
    await layer.set(key, { round: i }, 120);
    const started = Date.now();
    for (;;) {
      const got = (await layer.get(key)) as { round?: number } | null;
      if (got?.round === i) {
        if (Date.now() - started < 60) fresh += 1;
        waits.push(Date.now() - started);
        break;
      }
      if (Date.now() - started > 3_000) {
        waits.push(-1);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  say(`memory: read straight after a write: ${fresh} of 8 had the new value at once | ms until the new value was there: ${waits.join(',')} (-1: not within 3 s)`);

  // A big value: 300,000 characters, as a long page would be.
  const big = { text: 'x'.repeat(300_000) };
  const [, bigSetMs] = await timed(() => layer.set(`probe:${run}:big`, big, 120));
  const [bigBack, bigGetMs] = await timed(() => layer.get(`probe:${run}:big`));
  say(`memory: 300,000 characters: write ${bigSetMs}ms, read ${bigGetMs}ms, ${(bigBack as { text?: string } | null)?.text?.length === 300_000 ? 'complete' : 'NOT complete'}`);

  await layer.delete(key);
  const [gone] = await timed(() => layer.get(key));
  say(`memory: after delete the key reads as ${JSON.stringify(gone)}`);
  await layer.delete(`probe:${run}:big`);

  // The log itself, with a book of its own: two servers write, a third reads.
  const prefix = `probe-log:${run}`;
  const book = (): ReturnType<typeof createLogBook> => createLogBook({ shared: sharedLayer, prefix, writeGapMs: 0 });
  const [mcp, tryBox, feed] = [book(), book(), book()];
  const at = Date.now();
  const call = (offset: number, input: string, from: 'agent' | 'page'): LogEntry => ({
    id: newLogId(at + offset),
    at: at + offset,
    tool: 'search_web',
    from,
    input,
    options: {},
    ok: true,
    tier: 1,
    method: 'Tier 1 (Fast HTTP)',
    by: ['Tavily', 'Exa'],
    steps: [{ way: 'tavily search', ok: true, ms: 300, note: '8 results' }],
    ms: 400,
    chars: 20_000,
  });
  const first = call(0, 'written by the first server', 'agent');
  const second = call(1_000, 'written by the second server', 'page');
  const [, recordMs] = await timed(() => mcp.record(first, 'answer one '.repeat(1_800)));
  await tryBox.record(second, 'answer two');
  const [seen, readMs] = await timed(() => feed.read());
  const [again, idleMs] = await timed(() => feed.read(seen.rev));
  const [answer, answerMs] = await timed(() => feed.answer(first.id));
  say(
    `memory: the log through it: a third server read ${seen.entries?.length ?? 0} of 2 calls (${(seen.entries ?? []).map((e) => e.input).join(' | ')}) | ` +
      `"nothing changed" ${again.entries === null ? 'works' : 'DOES NOT WORK'} | answer of the first call ${answer?.length === 19_800 ? 'complete' : `NOT complete (${answer?.length ?? 'missing'})`} | ` +
      `write a call ${recordMs}ms, read the list ${readMs}ms, ask "anything new" ${idleMs}ms, read an answer ${answerMs}ms | probe says "${await feed.probe()}"`,
  );
  for (const name of ['list', 'head', 'probe', `answer:${first.id}`, `answer:${second.id}`]) await layer.delete(`${prefix}:${name}`);
}

async function main(): Promise<void> {
  const setting = process.env.SCRAPY_BUILD_PROBE;
  if (setting !== '1' && setting !== 'memory') {
    say('skipped. Set SCRAPY_BUILD_PROBE=1 to check the free helpers during the build, or SCRAPY_BUILD_PROBE=memory to try only the shared memory.');
    return;
  }
  // Whatever happens, the build must not hang on this.
  setTimeout(() => {
    say('stopped after 4 minutes');
    process.exit(0);
  }, 240_000).unref();

  const steps: [string, () => Promise<void>][] =
    setting === 'memory'
      ? [['shared memory', sharedMemory]]
      : [
          ['helper checks', helperChecks],
          ['mcp check', overMcp],
          ['shared memory', sharedMemory],
        ];
  for (const [name, step] of steps) {
    try {
      await step();
    } catch (err) {
      say(`${name} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`.slice(0, 1_500));
    }
  }
}

await main();
process.exit(0);
