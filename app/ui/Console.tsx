'use client';

/**
 * The dashboard, at /dashboard. It is for the owner, not for agents. A menu
 * button opens a drawer with sections (the list is in menu.ts). The first
 * section, "Dashboard", has three parts:
 * - "Run checks" shows which free helpers answer, how fast the tools are, and
 *   every address Scrapy contacted.
 * - "The address for your agent" is what an agent connects to.
 * - "Try a tool" runs a tool exactly as an agent would and shows the answer.
 * The second section, "Logs", has the live feed of tool calls (LogsView.tsx).
 * The third, "Docs", has the MCP doc for the person who connects an AI
 * (McpDoc.tsx) and the rulebook for agents (DocsAi.tsx). Both can also be read
 * without a login, at /docs.
 *
 * Where Scrapy is personal, the server shows this page only to a browser that
 * is logged in (app/dashboard/page.tsx). A login that ends while the page is
 * open is noticed here, and the page then says so.
 *
 * One part shows at a time. Its name is in the page address ("#try"), so the
 * back button works and a part can be linked to. What was typed or checked in
 * one part is still there after a visit to another.
 */
import { useEffect, useState } from 'react';
import type { DocsPayload } from '@/lib/docs';
import { CopyButton } from './CopyButton';
import { DocsAi } from './DocsAi';
import { McpDoc, type ClientId } from './McpDoc';
import { Drawer } from './Drawer';
import { go } from './go';
import { LogsView } from './LogsView';
import { FIRST_VIEW, MENU, isOtherName, menuItem, viewFromHash, type MenuItem, type ViewId } from './menu';

interface Status {
  version: string;
  /** The name of the release, as people see it. */
  release?: string;
  /** Who may use this Scrapy. */
  access?: 'personal' | 'open' | 'closed';
  /** False when this browser may not use it: closed, or personal and not logged in. */
  allowed?: boolean;
  /** The key for an AI. Only the owner of a personal Scrapy is given it. */
  key?: string | null;
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
  fallback: { what: string; ok: boolean; ms: number; note: string }[];
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
  lines.push('', 'FALLBACK');
  for (const f of r.fallback) lines.push(`- ${f.what}: ${f.ok ? 'works' : 'FAILED'}, ${ms(f.ms)}. ${f.note}`);
  lines.push('', `SAFE POSITION: ${r.safe.applies ? (r.safe.ok ? 'ok' : 'PROBLEM') : 'not in use'}. ${r.safe.note}`);
  lines.push('', 'ADDRESSES CONTACTED');
  const perHost = new Map<string, number>();
  for (const c of r.contacts) perHost.set(c.host, (perHost.get(c.host) ?? 0) + 1);
  for (const [host, n] of perHost) lines.push(`- ${host}: ${n} requests`);
  return lines.join('\n');
}

/** True when Scrapy asked and not one address answered at all: this copy has no way out to the internet. */
function noInternet(r: CheckReport): boolean {
  return r.contacts.length > 0 && r.contacts.every((c) => c.status === null);
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

export default function Console() {
  const [status, setStatus] = useState<Status | null>(null);
  const [origin, setOrigin] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [view, setView] = useState<ViewId>(FIRST_VIEW);
  /** True once Scrapy has answered "log in first": the login ended while this page was open. */
  const [loggedOut, setLoggedOut] = useState(false);
  const [keyShown, setKeyShown] = useState(false);

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

  const [docs, setDocs] = useState<DocsPayload | null>(null);
  const [docsFailed, setDocsFailed] = useState(false);
  const [docsTry, setDocsTry] = useState(0);
  const [docsClient, setDocsClient] = useState<ClientId>('cursor');

  useEffect(() => {
    setOrigin(window.location.origin);
    fetch('/api/status', { cache: 'no-store' })
      .then((r) => r.json())
      .then((s: Status) => setStatus(s))
      .catch(() => setStatus(null));
  }, []);

  // The part that shows follows the page address: "#try" shows "Try a tool".
  useEffect(() => {
    const show = () => {
      const named = viewFromHash(window.location.hash);
      setView(named);
      // Another name for a part ("#docs") is swapped for the part's own address. No step is added to the history.
      if (isOtherName(window.location.hash)) window.history.replaceState(window.history.state, '', `#${named}`);
    };
    show();
    const follow = () => {
      show();
      // A newly chosen part starts at its top, not where the last one was scrolled to.
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
  }, []);

  // The docs are read from Scrapy the first time one of their pages is opened.
  const wantsDocs = view === 'mcp-doc' || view === 'docs-ai';
  const hasDocs = docs !== null;
  useEffect(() => {
    if (!wantsDocs || hasDocs) return undefined;
    let stale = false;
    setDocsFailed(false);
    fetch('/api/docs', { cache: 'no-store' })
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((d: DocsPayload) => {
        if (!stale) setDocs(d);
      })
      .catch(() => {
        if (!stale) setDocsFailed(true);
      });
    return () => {
      stale = true;
    };
  }, [wantsDocs, hasDocs, docsTry]);

  const showing: MenuItem = menuItem(view);
  const closed = status !== null && !status.open;
  const personal = status?.access === 'personal';
  const mustLogIn = loggedOut || (personal && status?.allowed === false);

  async function logOut() {
    try {
      await fetch('/api/logout', { method: 'POST' });
    } catch {
      // Without an answer the pass may still be there. The home page shows which it is.
    }
    go('/');
  }

  async function runChecks() {
    setChecking(true);
    setCheckError('');
    try {
      const res = await fetch('/api/check', { method: 'POST' });
      const data = (await res.json()) as CheckReport & { login?: boolean };
      if (res.status === 401 && data.login) {
        setLoggedOut(true);
      } else if (!res.ok || data.error) {
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
      const data = (await res.json()) as ToolRun & { login?: boolean };
      if (res.status === 401 && data.login) setLoggedOut(true);
      else setRun(data);
    } catch {
      setRun({ ok: false, text: 'The request did not get through. Try again.' });
    } finally {
      setRunning(false);
    }
  }

  const mcpAddress = `${origin}/api/mcp`;
  const key = personal ? (status?.key ?? null) : null;

  if (mustLogIn) {
    return (
      <main>
        <div className="top">
          <h1>Scrapy</h1>
          <span className="pill warn">logged out</span>
        </div>
        <p className="lead">This Scrapy is personal. Its dashboard is for its owner.</p>
        <section className="card">
          <h2>You are logged out</h2>
          <p>Your login has ended. Log in again to go on where you were.</p>
          <a className="button primary" href={`/login#${view}`}>
            Log in
          </a>
        </section>
      </main>
    );
  }

  if (closed) {
    return (
      <main>
        <div className="top">
          <h1>Scrapy</h1>
          <span className="pill warn">closed</span>
        </div>
        <p className="lead">Web tools for AI agents: search the web and read pages.</p>
        <section className="card">
          <h2>This address is closed</h2>
          <p>{status.message ?? 'Its owner has not opened it yet.'} Nothing can be searched or read from here.</p>
          <p className="soft" style={{ marginBottom: 0 }}>
            The <a href="/docs">docs</a> can be read all the same. Back to the <a href="/">home page</a>.
          </p>
        </section>
      </main>
    );
  }

  return (
    <>
      <header className="bar">
        <button type="button" className="icon" aria-label="Open menu" aria-haspopup="dialog" aria-expanded={menuOpen} aria-controls="menu" onClick={() => setMenuOpen(true)}>
          <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
            <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" />
          </svg>
        </button>
        <a className="brand" href="/" title="Home page">
          Scrapy
        </a>
        {status && <span className={`pill bar-end ${status.mode === 'safe' ? 'good' : 'warn'}`}>position: {status.mode === 'full' ? 'full speed' : status.mode}</span>}
      </header>
      <Drawer
        id="menu"
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        sections={MENU}
        current={view}
        foot={
          status ? (
            <>
              {personal && (
                <button type="button" className="quiet" onClick={() => void logOut()}>
                  Log out
                </button>
              )}
              <span>Scrapy {status.release ?? `version ${status.version}`}</span>
            </>
          ) : undefined
        }
      />

      {/* While the menu is open, the page behind it is out of reach. */}
      <main inert={menuOpen} className={view === 'logs' ? 'wide' : undefined}>
        <h1>{showing.title ?? showing.label}</h1>
        <p className="lead">{showing.about}</p>

        {view === 'mcp-doc' && <McpDoc docs={docs} origin={origin} failed={docsFailed} onRetry={() => setDocsTry((t) => t + 1)} client={docsClient} onClient={setDocsClient} ownerKey={key} />}
        {view === 'docs-ai' && <DocsAi docs={docs} origin={origin} failed={docsFailed} onRetry={() => setDocsTry((t) => t + 1)} />}

        {/* Always there, so that the feed keeps its calls and its unfolded cards while another part shows. It only asks for news while it shows. */}
        <div hidden={view !== 'logs'}>
          <LogsView active={view === 'logs'} onLoggedOut={() => setLoggedOut(true)} />
        </div>

        {view === 'checks' && (
          <section className="card">
            <div className="row between">
              <div>
                <h2>Check the free helpers</h2>
                <p className="soft" style={{ marginBottom: 0 }}>Nothing is checked until you press the button. It takes up to a minute.</p>
              </div>
              <button type="button" className="primary" onClick={() => void runChecks()} disabled={checking}>
                {checking ? 'Checking...' : 'Run checks'}
              </button>
            </div>
            {checkError && <div className="error">{checkError}</div>}
            {report && noInternet(report) && (
              <div className="error">
                None of the addresses Scrapy contacted answered. This copy of Scrapy seems to have no internet access, so nothing can be searched or read from here.
              </div>
            )}

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

                <h3>Fallback</h3>
                <p className="soft">The ways Scrapy uses first are switched off for one search and one page. Both must still work.</p>
                <div className="scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Check</th>
                        <th>Result</th>
                        <th>Time</th>
                        <th>Details</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.fallback.map((f) => (
                        <tr key={f.what}>
                          <td>{f.what}</td>
                          <td>
                            <span className={`pill ${f.ok ? 'good' : 'bad'}`}>{f.ok ? 'works' : 'failed'}</span>
                          </td>
                          <td className="num">{ms(f.ms)}</td>
                          <td className="note">{f.note}</td>
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
        )}

        {view === 'address' && (
          <section className="card">
            <div className="row">
              <code className="address">{origin ? mcpAddress : '...'}</code>
              <CopyButton text={mcpAddress} label="Copy" />
            </div>
            {key && (
              <>
                <h2 id="key-title" className="label">The key</h2>
                <div className="row">
                  <code className="address" aria-labelledby="key-title">
                    {keyShown ? key : '\u2022'.repeat(24)}
                  </code>
                  <button type="button" aria-pressed={keyShown} onClick={() => setKeyShown((shown) => !shown)}>
                    {keyShown ? 'Hide' : 'Show'}
                  </button>
                  <CopyButton text={key} label="Copy the key" />
                </div>
                <p className="soft" style={{ marginTop: 12 }}>
                  This Scrapy is personal: it answers only to you. Your AI sends the key with every request, in the header <code>Authorization: Bearer</code> followed by the key. The <a href="#mcp-doc">MCP doc</a> has the lines to copy
                  for each AI app.
                </p>
                <p className="soft">
                  For an AI app that has no place for a header, the key can go at the end of the address instead. <CopyButton text={`${mcpAddress}?key=${key}`} label="Copy the address with the key" className="inline" />
                </p>
                <p className="soft" style={{ marginBottom: 0 }}>
                  Keep the key to yourself: whoever has it can use this Scrapy. It is made from your password. A new password (the setting <code>SCRAPY_PASSWORD</code>) makes a new key and logs every browser out.
                </p>
              </>
            )}
            {status && (
              <p className="soft" style={{ marginTop: 12, marginBottom: 0 }}>
                Tools ready now: {status.tools.map((t) => t.name).join(', ')}. {MODE_TEXT[status.mode]} Limits: {status.limits.visitorPerMinute} calls a minute{key ? '' : ' for each visitor'},{' '}
                {status.limits.dailyCalls.toLocaleString('en-US')} calls a day{key ? '' : ' in total'}.
              </p>
            )}
            {!key && (
              <p className="soft" style={{ marginTop: 12, marginBottom: 0 }}>
                Where to put this address in your AI app is in the <a href="#mcp-doc">MCP doc</a>.
              </p>
            )}
          </section>
        )}

        {view === 'try' && (
          <section className="card">
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
        )}

        <footer>
          Scrapy {status?.release ?? ''}. Tools: search_web and fetch_url. Coming next: extract_text, extract_images, extract_design, then deep_crawl and crawl_status.
          {status?.where.env ? ` Running on Vercel (${status.where.env}${status.where.region ? `, region ${status.where.region}` : ''}).` : ''}
        </footer>
      </main>
    </>
  );
}
