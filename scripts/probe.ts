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
  say(`position=${report.mode} region=${report.region ?? 'unknown'} took=${report.tookMs}ms`);
  for (const h of report.helpers) say(`helper ${h.id} ${h.job}: ${h.answers ? 'ANSWERS' : 'NO ANSWER'} ${h.ms}ms | ${oneLine(h.note, 260)}`);
  for (const s of report.speed) say(`speed ${s.what}: ${s.ok ? 'ok' : 'FAILED'} ${s.ms}ms (target ${s.targetMs}ms) | ${oneLine(s.note, 320)}`);
  say(`safe position: applies=${report.safe.applies} ok=${report.safe.ok} | ${report.safe.note}`);
  say(`requests: ${report.contacts.length} to ${report.hosts.join(', ')}`);
  // The start of each helper's raw answer, once per helper and job, to compare with what Scrapy expects.
  const shown = new Set<string>();
  for (const s of report.samples ?? []) {
    if (shown.has(s.who)) continue;
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
    for (const [name, args] of [
      ['search_web', { query: 'react useEffect cleanup function', max_results: 5 }],
      ['fetch_url', { url: 'https://example.com' }],
      ['fetch_url', { url: 'http://169.254.169.254/latest/meta-data/' }],
    ] as const) {
      const started = Date.now();
      const result = await client.callTool({ name, arguments: args });
      const text = (result.content as { text?: string }[]).map((b) => b.text ?? '').join('\n');
      say(`mcp ${name} ${JSON.stringify(args)}: isError=${result.isError === true} ${Date.now() - started}ms | ${oneLine(text, 900)}`);
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
