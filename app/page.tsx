'use client';

/**
 * The check page. It is for the owner, not for agents:
 * - "Run checks" shows which free helpers answer, how fast the tools are, and
 *   every address Scrapy contacted.
 * - "Try a tool" runs a tool exactly as an agent would and shows the answer.
 */
import { useEffect, useState } from 'react';

interface Status {
  version: string;
  open: boolean;
  message?: string;
  mode: 'safe' | 'middle' | 'full';
  tools: { name: string; title: string }[];
  limits: { visitorPerMinute: number; dailyCalls: number };
  usage: { today: number };
  where: { vercel: boolean; env: string | null; region: string | null };
}

interface HelperCheck {
  id: string;
  name: string;
  job: 'search' | 'page';
  answers: boolean;
  ms: number;
  note: string;
}

interface SpeedCheck {
  what: string;
  ok: boolean;
  ms: number;
  targetMs: number;
  note: string;
}

interface Contact {
  purpose: string;
  method: string;
  address: string;
  host: string;
  status: number | null;
  ms: number;
  note?: string;
}

interface CheckReport {
  at: string;
  version: string;
  mode: string;
  region: string | null;
  helpers: HelperCheck[];
  speed: SpeedCheck[];
  safe: { applies: boolean; ok: boolean; note: string };
  hosts: string[];
  contacts: Contact[];
  tookMs: number;
  reused?: boolean;
  error?: string;
}

interface ToolRun {
  ok: boolean;
  text: string;
  reason?: string;
  trace?: {
    totalMs: number;
    cache: string;
    steps: { way: string; ok: boolean; ms: number; note: string }[];
    contacts: Contact[];
    hosts: string[];
  };
}

const MODE_TEXT: Record<string, string> = {
  safe: 'Safe: Scrapy only asks the free helper services. It never downloads a page itself.',
  middle: 'Middle: free helpers first, Scrapy downloads a page itself only when they are busy.',
  full: 'Full speed: Scrapy downloads pages itself first, helpers only for pages that need a real browser.',
};

function ms(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${n} ms`;
}

function reportAsText(r: CheckReport): string {
  const lines: string[] = [];
  lines.push(`Scrapy check ${r.at} | version ${r.version} | position ${r.mode} | region ${r.region ?? 'unknown'} | took ${ms(r.tookMs)}`);
  lines.push('', 'HELPERS');
  for (const h of r.helpers) lines.push(`- ${h.id} (${h.job}): ${h.answers ? 'answers' : 'DOES NOT ANSWER'}, ${ms(h.ms)}. ${h.note}`);
  lines.push('', 'SPEED');
  for (const s of r.speed) lines.push(`- ${s.what}: ${s.ok ? ms(s.ms) : 'FAILED'} (target ${ms(s.targetMs)}). ${s.note}`);
  lines.push('', `SAFE POSITION: ${r.safe.applies ? (r.safe.ok ? 'ok' : 'PROBLEM') : 'not in use'}. ${r.safe.note}`);
  lines.push('', 'ADDRESSES CONTACTED');
  const perHost = new Map<string, number>();
  for (const c of r.contacts) perHost.set(c.host, (perHost.get(c.host) ?? 0) + 1);
  for (const [host, n] of perHost) lines.push(`- ${host}: ${n} requests`);
  return lines.join('\n');
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? 'Copied' : label}
    </button>
  );
}

function Contacts({ contacts }: { contacts: Contact[] }) {
  if (contacts.length === 0) return <p className="soft">No address was contacted.</p>;
  return (
    <div className="scroll">
      <table>
        <thead>
          <tr>
            <th>Address</th>
            <th>Why</th>
            <th>Answer</th>
            <th>Time</th>
          </tr>
        </thead>
        <tbody>
          {contacts.map((c, i) => (
            <tr key={i}>
              <td className="mono">
                {c.method} {c.address}
              </td>
              <td className="note">{c.purpose}</td>
              <td className="num">{c.status ?? c.note ?? 'none'}</td>
              <td className="num">{ms(c.ms)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function CheckPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [origin, setOrigin] = useState('');

  const [checking, setChecking] = useState(false);
  const [report, setReport] = useState<CheckReport | null>(null);
  const [checkError, setCheckError] = useState('');

  const [tool, setTool] = useState<'search_web' | 'fetch_url'>('search_web');
  const [query, setQuery] = useState('how to fix a hydration error in next.js');
  const [maxResults, setMaxResults] = useState('8');
  const [recency, setRecency] = useState('');
  const [sites, setSites] = useState('');
  const [url, setUrl] = useState('https://example.com');
  const [format, setFormat] = useState('markdown');
  const [focus, setFocus] = useState('');
  const [part, setPart] = useState('1');
  const [browser, setBrowser] = useState(false);
  const [running, setRunning] = useState(false);
  const [run, setRun] = useState<ToolRun | null>(null);

  useEffect(() => {
    setOrigin(window.location.origin);
    fetch('/api/status')
      .then((r) => r.json())
      .then((s: Status) => setStatus(s))
      .catch(() => setStatus(null));
  }, []);

  async function runChecks() {
    setChecking(true);
    setCheckError('');
    try {
      const res = await fetch('/api/check', { method: 'POST' });
      const data = (await res.json()) as CheckReport;
      if (!res.ok || data.error) {
        setCheckError(data.error ?? `The checks could not run (${res.status}).`);
      } else {
        setReport(data);
      }
    } catch {
      setCheckError('The checks could not run. Try again.');
    } finally {
      setChecking(false);
    }
  }

  async function runTool() {
    setRunning(true);
    setRun(null);
    const args: Record<string, unknown> =
      tool === 'search_web'
        ? {
            query,
            ...(maxResults ? { max_results: Number(maxResults) } : {}),
            ...(recency ? { recency } : {}),
            ...(sites.trim()
              ? {
                  include_sites: sites
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean),
                }
              : {}),
          }
        : {
            url,
            format,
            ...(focus.trim() ? { focus } : {}),
            ...(part && part !== '1' ? { part: Number(part) } : {}),
            ...(browser ? { browser: true } : {}),
          };
    try {
      const res = await fetch('/api/try', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool, args }) });
      setRun((await res.json()) as ToolRun);
    } catch {
      setRun({ ok: false, text: 'The request did not get through. Try again.' });
    } finally {
      setRunning(false);
    }
  }

  const mcpAddress = `${origin}/api/mcp`;

  if (status && !status.open) {
    return (
      <main>
        <div className="top">
          <h1>Scrapy</h1>
          <span className="pill warn">closed</span>
        </div>
        <p className="lead">Web tools for AI agents: search the web and read pages. Free, with no keys.</p>
        <section className="card">
          <h2>This address is closed</h2>
          <p style={{ marginBottom: 0 }}>{status.message ?? 'Its owner has not opened it yet.'} Nothing can be searched or read from here.</p>
        </section>
      </main>
    );
  }

  return (
    <main>
      <div className="top">
        <h1>Scrapy</h1>
        <div className="row">
          {status && <span className="pill">version {status.version}</span>}
          {status && <span className={`pill ${status.mode === 'safe' ? 'good' : 'warn'}`}>position: {status.mode === 'full' ? 'full speed' : status.mode}</span>}
        </div>
      </div>
      <p className="lead">Web tools for AI agents: search the web and read pages. Free, with no keys. This page is for checking that it works.</p>

      <section className="card">
        <h2>The address for your agent</h2>
        <p className="soft">An AI agent connects to this address with MCP and gets the tools.</p>
        <div className="row">
          <code className="address">{origin ? mcpAddress : '...'}</code>
          <CopyButton text={mcpAddress} label="Copy" />
        </div>
        {status && (
          <p className="soft" style={{ marginTop: 12, marginBottom: 0 }}>
            Tools ready now: {status.tools.map((t) => t.name).join(', ')}. {MODE_TEXT[status.mode]} Limits: {status.limits.visitorPerMinute} calls a minute for each visitor,{' '}
            {status.limits.dailyCalls.toLocaleString('en-US')} calls a day in total.
          </p>
        )}
      </section>

      <section className="card">
        <div className="row between">
          <div>
            <h2>1. Check the free helpers</h2>
            <p className="soft" style={{ marginBottom: 0 }}>
              Asks every helper one small thing, times the tools, and lists every address Scrapy contacted. Takes up to a minute.
            </p>
          </div>
          <button type="button" className="primary" onClick={() => void runChecks()} disabled={checking}>
            {checking ? 'Checking...' : 'Run checks'}
          </button>
        </div>
        {checkError && <div className="error">{checkError}</div>}

        {report && (
          <>
            <h3>Helpers</h3>
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>Helper</th>
                    <th>Job</th>
                    <th>Result</th>
                    <th>Time</th>
                    <th>What it said</th>
                  </tr>
                </thead>
                <tbody>
                  {report.helpers.map((h) => (
                    <tr key={`${h.id}-${h.job}`}>
                      <td>{h.name}</td>
                      <td>{h.job === 'search' ? 'search' : 'read a page'}</td>
                      <td>
                        <span className={`pill ${h.answers ? 'good' : 'bad'}`}>{h.answers ? 'answers' : 'does not answer'}</span>
                      </td>
                      <td className="num">{ms(h.ms)}</td>
                      <td className="note">{h.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h3>Speed</h3>
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>Call</th>
                    <th>Time</th>
                    <th>Target</th>
                    <th>Result</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {report.speed.map((s) => (
                    <tr key={s.what}>
                      <td>{s.what}</td>
                      <td className="num">{ms(s.ms)}</td>
                      <td className="num">{ms(s.targetMs)}</td>
                      <td>
                        <span className={`pill ${!s.ok ? 'bad' : s.ms <= s.targetMs ? 'good' : 'warn'}`}>{!s.ok ? 'failed' : s.ms <= s.targetMs ? 'on target' : 'slower'}</span>
                      </td>
                      <td className="note">{s.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h3>Safe position</h3>
            <p>
              <span className={`pill ${!report.safe.applies ? '' : report.safe.ok ? 'good' : 'bad'}`}>{!report.safe.applies ? 'not in use' : report.safe.ok ? 'kept' : 'broken'}</span>{' '}
              {report.safe.note}
            </p>

            <h3>Every address contacted ({report.contacts.length} requests)</h3>
            <Contacts contacts={report.contacts} />

            <div className="row" style={{ marginTop: 16 }}>
              <CopyButton text={reportAsText(report)} label="Copy results as text" />
              <span className="soft">
                Checked {new Date(report.at).toLocaleTimeString()} in {ms(report.tookMs)}
                {report.region ? `, from Vercel region ${report.region}` : ''}.{report.reused ? ' This is the result of a check from the last two minutes.' : ''}
              </span>
            </div>
          </>
        )}
      </section>

      <section className="card">
        <h2>2. Try a tool</h2>
        <p className="soft">Runs a tool exactly as an agent would, and shows the answer the agent gets.</p>
        <div className="row">
          <button type="button" className={`tab ${tool === 'search_web' ? 'on' : ''}`} onClick={() => setTool('search_web')}>
            search_web
          </button>
          <button type="button" className={`tab ${tool === 'fetch_url' ? 'on' : ''}`} onClick={() => setTool('fetch_url')}>
            fetch_url
          </button>
        </div>

        {tool === 'search_web' ? (
          <>
            <label htmlFor="query">Question</label>
            <input id="query" type="text" value={query} onChange={(e) => setQuery(e.target.value)} />
            <div className="grid">
              <div>
                <label htmlFor="max">How many results</label>
                <input id="max" type="number" min={1} max={20} value={maxResults} onChange={(e) => setMaxResults(e.target.value)} />
              </div>
              <div>
                <label htmlFor="recency">How recent</label>
                <select id="recency" value={recency} onChange={(e) => setRecency(e.target.value)}>
                  <option value="">Any time</option>
                  <option value="day">Last day</option>
                  <option value="week">Last week</option>
                  <option value="month">Last month</option>
                  <option value="year">Last year</option>
                </select>
              </div>
              <div>
                <label htmlFor="sites">Only these sites (optional)</label>
                <input id="sites" type="text" placeholder="react.dev, nextjs.org" value={sites} onChange={(e) => setSites(e.target.value)} />
              </div>
            </div>
          </>
        ) : (
          <>
            <label htmlFor="url">Link</label>
            <input id="url" type="text" value={url} onChange={(e) => setUrl(e.target.value)} />
            <div className="grid">
              <div>
                <label htmlFor="format">Format</label>
                <select id="format" value={format} onChange={(e) => setFormat(e.target.value)}>
                  <option value="markdown">Markdown</option>
                  <option value="html">HTML</option>
                </select>
              </div>
              <div>
                <label htmlFor="focus">Focus (optional)</label>
                <input id="focus" type="text" placeholder="rate limits" value={focus} onChange={(e) => setFocus(e.target.value)} />
              </div>
              <div>
                <label htmlFor="part">Part</label>
                <input id="part" type="number" min={1} value={part} onChange={(e) => setPart(e.target.value)} />
              </div>
            </div>
            <label className="check">
              <input type="checkbox" checked={browser} onChange={(e) => setBrowser(e.target.checked)} /> Use a real browser
            </label>
          </>
        )}

        <div className="row" style={{ marginTop: 16 }}>
          <button type="button" className="primary" onClick={() => void runTool()} disabled={running}>
            {running ? 'Running...' : `Run ${tool}`}
          </button>
          {run?.trace && (
            <span className="soft">
              {ms(run.trace.totalMs)}
              {run.trace.cache === 'hit' ? ", from Scrapy's memory" : ''}
            </span>
          )}
        </div>

        {run && (
          <>
            <h3>{run.ok ? 'What the agent gets' : 'What the agent is told'}</h3>
            <pre>{run.text}</pre>
            <div className="row" style={{ marginTop: 10 }}>
              <CopyButton text={run.text} label="Copy answer" />
              {!run.ok && <span className="pill bad">{run.reason ?? 'failed'}</span>}
            </div>
            {run.trace && run.trace.steps.length > 0 && (
              <>
                <h3>What Scrapy tried</h3>
                <div className="scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Way</th>
                        <th>Result</th>
                        <th>Time</th>
                        <th>Details</th>
                      </tr>
                    </thead>
                    <tbody>
                      {run.trace.steps.map((s, i) => (
                        <tr key={i}>
                          <td>{s.way}</td>
                          <td>
                            <span className={`pill ${s.ok ? 'good' : 'bad'}`}>{s.ok ? 'worked' : 'no'}</span>
                          </td>
                          <td className="num">{ms(s.ms)}</td>
                          <td className="note">{s.note}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            {run.trace && (
              <>
                <h3>Every address contacted</h3>
                <Contacts contacts={run.trace.contacts} />
              </>
            )}
          </>
        )}
      </section>

      <footer>
        Scrapy is built in stages. Ready now: search_web and fetch_url. Coming next: extract_text, extract_images, extract_design, then deep_crawl and crawl_status.
        {status?.where.env ? ` Running on Vercel (${status.where.env}${status.where.region ? `, region ${status.where.region}` : ''}).` : ''}
      </footer>
    </main>
  );
}
