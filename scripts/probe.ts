/**
 * Optional check during a Vercel build.
 *
 * With SCRAPY_BUILD_PROBE=1 set, the build asks every free helper one small
 * thing and writes the result into the build log. Then it starts the freshly
 * built Scrapy and calls it once over MCP, like an agent would.
 *
 * It never fails the build, and without the setting it does nothing at all.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { runChecks } from '../lib/check';

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

async function main(): Promise<void> {
  if (process.env.SCRAPY_BUILD_PROBE !== '1') {
    say('skipped. Set SCRAPY_BUILD_PROBE=1 to check the free helpers during the build.');
    return;
  }
  // Whatever happens, the build must not hang on this.
  setTimeout(() => {
    say('stopped after 4 minutes');
    process.exit(0);
  }, 240_000).unref();

  for (const [name, step] of [
    ['helper checks', helperChecks],
    ['mcp check', overMcp],
  ] as const) {
    try {
      await step();
    } catch (err) {
      say(`${name} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`.slice(0, 1_500));
    }
  }
}

await main();
process.exit(0);
