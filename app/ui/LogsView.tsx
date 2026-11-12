'use client';

/**
 * The live feed: every tool call, as it happens.
 *
 * It looks like a terminal or a network inspector. One line for each call,
 * the newest at the bottom. A line unfolds into a card with the details, and
 * the card's last row unfolds once more into the answer the agent got.
 *
 * The feed asks Scrapy "anything new?" every two seconds. That question is
 * cheap, but not free on Vercel, so the feed asks less often when nothing has
 * happened for a while, and not at all while its tab is in the background,
 * while another part of the page is showing, or while it is paused.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { LogEntry } from '@/lib/logs';

/** How long to wait before asking again, given how long ago the last call arrived. */
export function pollDelay(sinceNewsMs: number): number {
  if (sinceNewsMs < 2 * 60_000) return 2_000;
  if (sinceNewsMs < 10 * 60_000) return 5_000;
  return 15_000;
}

/** After a failed question the feed waits this long. */
const RETRY_MS = 5_000;
/** The page keeps this many calls on screen, also ones that Scrapy has already forgotten. */
const MAX_ON_SCREEN = 500;

/** "11:45:02 AM", in the time zone of whoever is looking. */
export function clock(at: number): string {
  return new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

function dayOf(at: number): string {
  return new Date(at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

/** "0.4s", "2.3s", and for very quick calls "45ms". */
export function took(ms: number): string {
  return ms < 100 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** The method as one line fits it: "Tier 1 · Tavily + Exa". The card shows the full name. */
function methodInBrief(e: LogEntry): string {
  const who = e.by.join(' + ');
  if (e.tier === 1 || e.tier === 2) return who ? `Tier ${e.tier} · ${who}` : `Tier ${e.tier}`;
  return e.method.replace(/ \(.*\)$/, '');
}

interface McpResponse {
  content: { type: string; text: string }[];
  isError?: boolean;
}

type Answer = { state: 'loading' } | { state: 'ready'; response: McpResponse } | { state: 'gone' } | { state: 'error' };

interface FeedReply {
  open?: boolean;
  on?: boolean;
  why?: 'public' | 'setting';
  rev?: string;
  entries?: LogEntry[] | null;
  keep?: number;
  hours?: number;
  where?: 'vercel' | 'memory';
}

function Copy({ text }: { text: string }) {
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
      {done ? 'Copied' : 'Copy'}
    </button>
  );
}

function Payload({ entry, answer }: { entry: LogEntry; answer: Answer | undefined }) {
  const [as, setAs] = useState<'json' | 'text'>('json');
  if (!answer || answer.state === 'loading') return <p className="log-dim">Loading the response...</p>;
  if (answer.state === 'gone') return <p className="log-dim">This response is no longer kept. Scrapy keeps the responses of the last calls only, and not for long.</p>;
  if (answer.state === 'error') return <p className="log-bad">The response could not be loaded. Fold this row and unfold it to try again.</p>;
  const json = JSON.stringify(answer.response, null, 2);
  const text = answer.response.content.map((block) => block.text).join('\n');
  const shown = as === 'json' ? json : text;
  return (
    <div className="log-payload">
      <div className="log-payload-bar">
        <div role="group" aria-label="Show the response as">
          <button type="button" className={as === 'json' ? 'on' : ''} aria-pressed={as === 'json'} onClick={() => setAs('json')}>
            JSON
          </button>
          <button type="button" className={as === 'text' ? 'on' : ''} aria-pressed={as === 'text'} onClick={() => setAs('text')}>
            Text
          </button>
        </div>
        <Copy text={shown} />
      </div>
      <pre aria-label={`Response of ${entry.tool}, as ${as === 'json' ? 'JSON' : 'text'}`}>{shown}</pre>
    </div>
  );
}

function Row({ icon, label, children }: { icon: string; label: string; children: ReactNode }) {
  return (
    <div className="log-field">
      <dt>
        <span className="log-icon" aria-hidden="true">
          {icon}
        </span>
        {label}
      </dt>
      <dd>{children}</dd>
    </div>
  );
}

function Card({ entry, payloadOpen, answer, onPayload }: { entry: LogEntry; payloadOpen: boolean; answer: Answer | undefined; onPayload: () => void }) {
  const options = Object.entries(entry.options);
  const isSearch = entry.tool === 'search_web';
  const isPage = entry.tool === 'fetch_url';
  return (
    <dl className="log-card" id={`log-${entry.id}`}>
      <Row icon="⏱️" label="Timestamp">
        {clock(entry.at)} <span className="log-dim">{dayOf(entry.at)}</span>
      </Row>
      <Row icon="⚙️" label="Tool">
        {entry.tool}
      </Row>
      <Row icon={isPage ? '🔗' : '🔍'} label={isPage ? 'URL' : isSearch ? 'Query' : 'Input'}>
        {entry.input === '' ? <span className="log-dim">nothing</span> : isSearch ? `"${entry.input}"` : entry.input}
        {options.length > 0 && <div className="log-dim">{options.map(([name, value]) => `${name}: ${value}`).join(' · ')}</div>}
      </Row>
      <Row icon="🏎️" label="Method">
        {entry.method}
        {entry.by.length > 0 && ` · ${entry.tier === 0 ? 'first answered by ' : ''}${entry.by.join(' + ')}`}
        {entry.steps.length > 0 && (
          <ul className="log-steps">
            {entry.steps.map((step, i) => (
              <li key={i}>
                <span className={step.ok ? 'log-ok' : 'log-bad'}>{step.ok ? 'ok' : 'no'}</span> {step.way} <span className="log-dim">{took(step.ms)}</span> <span className="log-dim">{step.note}</span>
              </li>
            ))}
          </ul>
        )}
      </Row>
      <Row icon="⏱️" label="Duration">
        {took(entry.ms)}
      </Row>
      <Row icon={entry.ok ? '✅' : '❌'} label="Result">
        {entry.ok ? `OK · ${entry.chars.toLocaleString('en-US')} characters` : <span className="log-bad">Failed · {entry.text ?? 'no reason was recorded'}</span>}
      </Row>
      <Row icon="👤" label="Called by">
        {entry.from === 'agent' ? 'An agent, over MCP' : 'The "Try a tool" box on this page'}
      </Row>
      <Row icon="📦" label="Payload">
        <button type="button" className="log-link" aria-expanded={payloadOpen} onClick={onPayload}>
          {payloadOpen ? '[ ↑ Fold the JSON response ]' : '[ ↓ Expand to view JSON response ]'}
        </button>
        {payloadOpen && <Payload entry={entry} answer={answer} />}
      </Row>
    </dl>
  );
}

export function LogsView({ active }: { active: boolean }) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [phase, setPhase] = useState<'loading' | 'live' | 'off' | 'closed'>('loading');
  const [offWhy, setOffWhy] = useState<'public' | 'setting'>('setting');
  const [trouble, setTrouble] = useState(false);
  const [paused, setPaused] = useState(false);
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(new Set());
  const [payloadIds, setPayloadIds] = useState<ReadonlySet<string>>(new Set());
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [unseen, setUnseen] = useState(0);
  const [kept, setKept] = useState({ keep: 100, hours: 24 });
  const [where, setWhere] = useState<'vercel' | 'memory' | null>(null);
  const [shared, setShared] = useState<'works' | 'silent' | 'none' | null>(null);

  /** Every call the page has seen, by id. */
  const known = useRef(new Map<string, LogEntry>());
  /** Calls that "Clear" took off the screen. */
  const cleared = useRef(new Set<string>());
  const rev = useRef<string | null>(null);
  const newsAt = useRef(0);
  const feed = useRef<HTMLDivElement>(null);
  /** True while the feed is scrolled to its end. Then it follows new calls. */
  const following = useRef(true);

  const absorb = useCallback((list: LogEntry[]) => {
    let added = 0;
    for (const e of list) {
      if (!known.current.has(e.id) && !cleared.current.has(e.id)) added += 1;
      known.current.set(e.id, e);
    }
    const sorted = [...known.current.values()].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
    for (const old of sorted.slice(0, Math.max(0, sorted.length - MAX_ON_SCREEN))) known.current.delete(old.id);
    setEntries(sorted.slice(-MAX_ON_SCREEN).filter((e) => !cleared.current.has(e.id)));
    if (added > 0) {
      newsAt.current = Date.now();
      if (!following.current) setUnseen((n) => n + added);
    }
  }, []);

  /** One question to Scrapy. False means: stop asking. */
  const ask = useCallback(
    async (signal: AbortSignal): Promise<boolean> => {
      const res = await fetch(`/api/logs${rev.current ? `?rev=${encodeURIComponent(rev.current)}` : ''}`, { signal, cache: 'no-store' });
      const data = (await res.json()) as FeedReply;
      if (data.open === false) {
        setPhase('closed');
        return false;
      }
      if (data.on !== true) {
        setOffWhy(data.why === 'public' ? 'public' : 'setting');
        setPhase('off');
        return false;
      }
      if (typeof data.rev === 'string') rev.current = data.rev;
      if (typeof data.keep === 'number' && typeof data.hours === 'number') setKept({ keep: data.keep, hours: data.hours });
      if (data.where) setWhere(data.where);
      if (Array.isArray(data.entries)) absorb(data.entries);
      setPhase('live');
      setTrouble(false);
      return true;
    },
    [absorb],
  );

  const stoppedForGood = phase === 'off' || phase === 'closed';
  useEffect(() => {
    if (!active || paused || stoppedForGood) return undefined;
    let over = false;
    let busy = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();

    const round = async (): Promise<void> => {
      if (over || busy || document.hidden) return;
      busy = true;
      let goOn = true;
      let failed = false;
      try {
        goOn = await ask(controller.signal);
      } catch {
        failed = true;
        if (!over) setTrouble(true);
      }
      busy = false;
      if (over || !goOn) return;
      timer = setTimeout(() => void round(), failed ? RETRY_MS : pollDelay(Date.now() - newsAt.current));
    };
    // Coming back to the tab counts as news: the feed asks at once, and quickly for a while.
    const onVisibility = (): void => {
      clearTimeout(timer);
      if (document.hidden) return;
      newsAt.current = Date.now();
      void round();
    };

    newsAt.current = Date.now();
    document.addEventListener('visibilitychange', onVisibility);
    void round();
    return () => {
      over = true;
      clearTimeout(timer);
      controller.abort();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [active, paused, stoppedForGood, ask]);

  // On Vercel the log travels through a shared memory. Ask once whether it works here.
  useEffect(() => {
    if (where !== 'vercel') return undefined;
    const controller = new AbortController();
    fetch('/api/logs?probe=1', { signal: controller.signal, cache: 'no-store' })
      .then((res) => res.json())
      .then((data: { shared?: 'works' | 'silent' | 'none' }) => setShared(data.shared ?? null))
      .catch(() => undefined);
    return () => controller.abort();
  }, [where]);

  // Follow the newest call, as a terminal does, unless the reader has scrolled up.
  useLayoutEffect(() => {
    const box = feed.current;
    if (box && active && following.current) box.scrollTop = box.scrollHeight;
  }, [entries, active, phase]);

  const onScroll = (): void => {
    const box = feed.current;
    if (!box) return;
    following.current = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
    if (following.current) setUnseen(0);
  };

  const toEnd = (): void => {
    const box = feed.current;
    if (!box) return;
    box.scrollTop = box.scrollHeight;
    following.current = true;
    setUnseen(0);
  };

  const toggle = (id: string): void => {
    setOpenIds((before) => {
      const next = new Set(before);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  };

  const loadAnswer = (entry: LogEntry): void => {
    // A failed call carries its one sentence with it. Nothing has to be fetched.
    if (!entry.ok) {
      setAnswers((all) => ({ ...all, [entry.id]: { state: 'ready', response: { content: [{ type: 'text', text: entry.text ?? '' }], isError: true } } }));
      return;
    }
    setAnswers((all) => ({ ...all, [entry.id]: { state: 'loading' } }));
    fetch(`/api/logs?id=${encodeURIComponent(entry.id)}`, { cache: 'no-store' })
      .then((res) => res.json())
      .then((data: { found?: boolean; response?: McpResponse }) => {
        const response = data.response;
        setAnswers((all) => ({ ...all, [entry.id]: data.found && response ? { state: 'ready', response } : { state: 'gone' } }));
      })
      .catch(() => setAnswers((all) => ({ ...all, [entry.id]: { state: 'error' } })));
  };

  const togglePayload = (entry: LogEntry): void => {
    const opening = !payloadIds.has(entry.id);
    setPayloadIds((before) => {
      const next = new Set(before);
      if (!next.delete(entry.id)) next.add(entry.id);
      return next;
    });
    const have = answers[entry.id];
    if (opening && (!have || have.state === 'error')) loadAnswer(entry);
  };

  const clear = (): void => {
    for (const id of known.current.keys()) cleared.current.add(id);
    setEntries([]);
    setUnseen(0);
    following.current = true;
  };

  if (phase === 'closed') return null;

  if (phase === 'off') {
    return (
      <section className="card">
        <h2>The log is off at this address</h2>
        {offWhy === 'public' ? (
          <p style={{ marginBottom: 0 }}>
            This is Scrapy&apos;s public address. The log holds what was asked and what was answered, and everybody who can open this page could read it. So Scrapy writes nothing down here. The log is on at the test address,
            which needs your Vercel login.
          </p>
        ) : (
          <p style={{ marginBottom: 0 }}>
            The log is switched off with the setting <code>SCRAPY_LOGS=off</code>. Nothing is written down.
          </p>
        )}
      </section>
    );
  }

  const status = phase === 'loading' ? 'connecting' : paused ? 'paused' : trouble ? 'offline' : 'live';
  const statusText = { connecting: 'CONNECTING', paused: 'PAUSED', offline: 'NO ANSWER', live: 'LIVE' }[status];

  return (
    <>
      <section className="term" aria-label="Live feed of tool calls">
        <div className="term-head">
          <span className={`term-state ${status}`} role="status">
            {statusText}
          </span>
          <span className="term-title">scrapy · tool calls</span>
          <span className="term-count">
            {entries.length} {entries.length === 1 ? 'call' : 'calls'}
          </span>
          <button type="button" aria-pressed={paused} title={paused ? 'Ask for new calls again' : 'Stop asking for new calls'} onClick={() => setPaused((p) => !p)}>
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button type="button" title="Empty the screen. Scrapy keeps what it has." onClick={clear} disabled={entries.length === 0}>
            Clear
          </button>
        </div>
        <div className="term-cols" aria-hidden="true">
          <span />
          <span>Time</span>
          <span>Tool</span>
          <span>Query or URL</span>
          <span>Method</span>
          <span>Took</span>
          <span>Result</span>
        </div>
        <div className="term-feed" ref={feed} onScroll={onScroll}>
          {phase === 'loading' && <p className="term-note">Connecting...</p>}
          {phase === 'live' && entries.length === 0 && (
            <p className="term-note">
              No calls yet. A call shows up here the moment Scrapy has answered it. To see one now, run a tool under <a href="#try">Try a tool</a> and come back.
            </p>
          )}
          {/* A "log" for screen readers too: a new call is read out when it arrives. */}
          <div role="log" aria-label="Tool calls, the newest at the bottom">
            <ol>
              {entries.map((e) => {
                const open = openIds.has(e.id);
                return (
                  <li key={e.id} className={`log${e.ok ? '' : ' failed'}${open ? ' open' : ''}`}>
                    <button type="button" className="log-row" aria-expanded={open} aria-controls={`log-${e.id}`} onClick={() => toggle(e.id)}>
                      {/* Drawn, not typed: not every font has a small triangle. */}
                      <svg className="log-caret" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
                        <path d="M3 1.5l4 3.5-4 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                      </svg>
                      <span className="log-time">{clock(e.at)}</span>
                      <span className={`log-tool ${e.tool}`}>{e.tool}</span>
                      <span className="log-input">{e.input}</span>
                      <span className="log-method">{methodInBrief(e)}</span>
                      <span className="log-took">{took(e.ms)}</span>
                      <span className={e.ok ? 'log-ok' : 'log-bad'}>{e.ok ? 'OK' : 'FAILED'}</span>
                    </button>
                    {open && <Card entry={e} payloadOpen={payloadIds.has(e.id)} answer={answers[e.id]} onPayload={() => togglePayload(e)} />}
                  </li>
                );
              })}
            </ol>
          </div>
          {status === 'live' && (
            <p className="term-wait">
              <span className="term-cursor" aria-hidden="true" />
              waiting for the next call
            </p>
          )}
          {unseen > 0 && (
            <button type="button" className="term-new" onClick={toEnd}>
              ↓ {unseen} new {unseen === 1 ? 'call' : 'calls'}
            </button>
          )}
        </div>
      </section>

      {trouble && <div className="error">Scrapy did not answer the last time the feed asked for news. It keeps trying every few seconds.</div>}
      {shared === 'silent' && (
        <div className="error">
          Vercel&apos;s shared memory is not answering here, so calls cannot be shown. The log travels through that memory, and it stops for the rest of the month when its free allowance is used up. Scrapy&apos;s tools are not
          affected.
        </div>
      )}
      <p className="soft term-foot">
        Kept: the last {kept.keep} calls, for up to {kept.hours} hours. Everybody who can open this page can read them.
        {where === 'memory' && ' This copy of Scrapy keeps them in its own memory, so the feed is empty again after a restart.'}
      </p>
      <p className="soft term-foot">
        Method: <b>Tier 1 (Fast HTTP)</b> is an ordinary request to a helper. <b>Tier 2 (Real browser)</b> means a helper read the page in a real browser, for pages built with JavaScript. <b>Memory</b> means Scrapy answered from
        its 15-minute memory and contacted nobody.
      </p>
    </>
  );
}
