'use client';

/**
 * The MCP doc: for the person who connects an AI to Scrapy.
 *
 * Four things, in the order they are needed: how to connect, the limits, how
 * Scrapy gets an answer, and how to read the log.
 *
 * No number on this page is typed in here. Every one is read from the running
 * Scrapy (lib/docs.ts), so the page cannot say 30 while Scrapy allows 20.
 */
import type { KeyboardEvent, ReactNode } from 'react';
import type { DocsPayload, Facts } from '@/lib/docs';
import { CodeBlock, CopyButton } from './CopyButton';

/** The header Vercel accepts instead of a login, at a test address. */
const SECRET_HEADER = 'x-vercel-protection-bypass';

/** What the examples say where the owner's key goes. */
export const KEY_PLACE = 'YOUR_KEY';

/** What an AI has to send along, besides the address. */
export interface Needs {
  /** Vercel's secret: at a test address, which Vercel guards with a login. */
  secret?: boolean;
  /** The owner's key: at a Scrapy that is personal. */
  key?: boolean;
}

export type ClientId = 'cursor' | 'claude' | 'vscode' | 'local' | 'code';

export const CLIENTS: { id: ClientId; label: string }[] = [
  { id: 'cursor', label: 'Cursor' },
  { id: 'claude', label: 'Claude Code' },
  { id: 'vscode', label: 'VS Code' },
  { id: 'local', label: 'Local apps only' },
  { id: 'code', label: 'Your own code' },
];

export interface Snippet {
  /** Where the text goes, in one or two sentences. */
  where: string;
  /** Each block with a few words on what it is: a file name, "Terminal", or the name of a library. */
  blocks: { caption: string; code: string }[];
}

const json = (value: unknown): string => JSON.stringify(value, null, 2);

/**
 * What to put where, for each kind of AI app.
 *
 * A personal Scrapy wants its owner's key with every request, and a test
 * address on Vercel wants Vercel's secret. Every example sends what is needed.
 */
export function connectSnippets(address: string, needs: Needs = {}): Record<ClientId, Snippet> {
  const withKey = needs.key === true;
  const withSecret = needs.secret === true;
  const sent: Record<string, string> = { ...(withKey ? { Authorization: `Bearer ${KEY_PLACE}` } : {}), ...(withSecret ? { [SECRET_HEADER]: 'YOUR_SECRET' } : {}) };
  const any = withKey || withSecret;
  const headers = any ? { headers: sent } : {};

  // In code, a secret belongs in the environment, not in the file.
  const inCode: string[] = [...(withKey ? ['Authorization: `Bearer ${process.env.SCRAPY_KEY}`'] : []), ...(withSecret ? [`'${SECRET_HEADER}': process.env.SCRAPY_SECRET`] : [])];
  const codeHeaders = (indent: string): string => (inCode.length === 1 ? `{ ${inCode[0] ?? ''} }` : `{\n${inCode.map((line) => `${indent}  ${line},`).join('\n')}\n${indent}}`);
  const envNote = [...(withKey ? ['your key in the environment variable SCRAPY_KEY'] : []), ...(withSecret ? ["Vercel's secret in SCRAPY_SECRET"] : [])].join(' and ');

  // mcp-remote takes a header as one word, so its value comes from the environment.
  const remoteArgs = ['-y', 'mcp-remote', address, ...(withKey ? ['--header', 'Authorization:${SCRAPY_AUTH}'] : []), ...(withSecret ? ['--header', `${SECRET_HEADER}:\${SCRAPY_SECRET}`] : [])];
  const remoteEnv = { ...(withKey ? { SCRAPY_AUTH: `Bearer ${KEY_PLACE}` } : {}), ...(withSecret ? { SCRAPY_SECRET: 'YOUR_SECRET' } : {}) };

  return {
    cursor: {
      where: 'Put this in the file .cursor/mcp.json in your project. To have Scrapy in every project, put it in ~/.cursor/mcp.json instead.',
      blocks: [{ caption: '.cursor/mcp.json', code: json({ mcpServers: { scrapy: { url: address, ...headers } } }) }],
    },
    claude: {
      where: 'Run this once in a terminal.',
      blocks: [
        {
          caption: 'Terminal',
          code: `claude mcp add --transport http scrapy ${address}${Object.entries(sent)
            .map(([name, value]) => ` \\\n  --header "${name}: ${value}"`)
            .join('')}`,
        },
      ],
    },
    vscode: {
      where: 'Put this in a file named .mcp.json at the top of your project. Or run "MCP: Add Server" in VS Code, choose HTTP, and paste the address.',
      blocks: [{ caption: '.mcp.json', code: json({ mcpServers: { scrapy: { type: 'http', url: address, ...headers } } }) }],
    },
    local: {
      where: 'Some apps can only start a program on your own computer. The small program mcp-remote connects such an app to Scrapy. It needs Node.js.',
      blocks: [
        {
          caption: "The app's MCP settings file",
          code: json({ mcpServers: { scrapy: any ? { command: 'npx', args: remoteArgs, env: remoteEnv } : { command: 'npx', args: remoteArgs } } }),
        },
      ],
    },
    code: {
      where: `In an agent you build yourself, an MCP library does the talking. Here are two for TypeScript.${any ? ` Put ${envNote}, not in the code.` : ''}`,
      blocks: [
        {
          caption: 'AI SDK (@ai-sdk/mcp)',
          code: [
            "import { createMCPClient } from '@ai-sdk/mcp';",
            '',
            'const scrapy = await createMCPClient({',
            any ? `  transport: {\n    type: 'http',\n    url: '${address}',\n    headers: ${codeHeaders('    ')},\n  },` : `  transport: { type: 'http', url: '${address}' },`,
            '});',
            '',
            '// search_web and fetch_url, ready to hand to the model',
            'const tools = await scrapy.tools();',
            '',
            '// when the answer is finished',
            'await scrapy.close();',
          ].join('\n'),
        },
        {
          caption: 'MCP SDK (@modelcontextprotocol/client)',
          code: [
            "import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';",
            '',
            "const scrapy = new Client({ name: 'my-agent', version: '1.0.0' });",
            any
              ? `await scrapy.connect(\n  new StreamableHTTPClientTransport(new URL('${address}'), {\n    requestInit: { headers: ${codeHeaders('    ')} },\n  }),\n);`
              : `await scrapy.connect(new StreamableHTTPClientTransport(new URL('${address}')));`,
            '',
            'const answer = await scrapy.callTool({',
            "  name: 'search_web',",
            "  arguments: { query: 'next.js hydration error fix' },",
            '});',
          ].join('\n'),
        },
      ],
    },
  };
}

/** A call by hand that shows whether the address answers. */
export function handCheck(address: string, needs: Needs = {}): string {
  return [
    `curl -s -X POST ${address} \\`,
    "  -H 'Content-Type: application/json' \\",
    "  -H 'Accept: application/json, text/event-stream' \\",
    ...(needs.key ? [`  -H 'Authorization: Bearer ${KEY_PLACE}' \\`] : []),
    ...(needs.secret ? [`  -H '${SECRET_HEADER}: YOUR_SECRET' \\`] : []),
    `  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
  ].join('\n');
}

const n = (value: number): string => value.toLocaleString('en-US');

/** "Tavily", "Tavily and Exa", "Tavily, Exa and Parallel". */
function listOf(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] ?? ''}`;
}

const MODE_TEXT: Record<string, string> = {
  safe: 'This Scrapy is in the safe position: it only asks the helpers, and never downloads a page itself.',
  middle: 'This Scrapy is in the middle position: helpers first, and its own download of a page when they are busy.',
  full: 'This Scrapy is in the full-speed position: it downloads a page itself first, and asks the helpers for pages that need a real browser.',
};

const SECTIONS = [
  { id: 'doc-connect', label: 'Connect your AI' },
  { id: 'doc-limits', label: 'Limits' },
  { id: 'doc-how', label: 'How Scrapy gets an answer' },
  { id: 'doc-logs', label: 'How to read the logs' },
] as const;

function goTo(id: string): void {
  const target = document.getElementById(id);
  if (!target) return;
  const calm = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  target.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'start' });
  // For a keyboard or a screen reader, the place moves too, not only the picture.
  target.focus({ preventScroll: true });
}

function Chips({ items }: { items: { name: string; mark?: string }[] }) {
  return (
    <span className="chips">
      {items.map((item) => (
        <span className="chip" key={item.name}>
          {item.name}
          {item.mark && <small>{item.mark}</small>}
        </span>
      ))}
    </span>
  );
}

function Step({ title, children }: { title: string; children: ReactNode }) {
  return (
    <li>
      <div className="step-title">{title}</div>
      <div className="step-text">{children}</div>
    </li>
  );
}

interface ConnectProps {
  address: string;
  facts: Facts;
  client: ClientId;
  setClient: (id: ClientId) => void;
  /** The owner's key, when the owner is logged in. It is never shown here, only copied. */
  ownerKey: string | null;
  /** Where the dashboard is, seen from this page: "" inside the dashboard, "/dashboard" outside it. */
  dash: string;
}

function Connect({ address, facts, client, setClient, ownerKey, dash }: ConnectProps) {
  const where = facts.where;
  const personal = facts.access === 'personal';
  const closed = facts.access === 'closed';
  // Vercel's test addresses are behind Vercel's login. An agent needs Vercel's secret header to get past it.
  const secretNeeded = where.vercel && where.env === 'preview';
  const needs: Needs = { secret: secretNeeded, key: personal };
  const snippet = connectSnippets(address, needs)[client];
  const onOwnMachine = typeof window !== 'undefined' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname);
  /** What the copy button of a block copies: the same text, with the real key where the block says YOUR_KEY. */
  const filled = (code: string): string | undefined => (ownerKey && code.includes(KEY_PLACE) ? code.split(KEY_PLACE).join(ownerKey) : undefined);

  // Tabs the way a keyboard expects them: Tab reaches the chosen one, the arrow keys move between them.
  const onKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    const at = CLIENTS.findIndex((c) => c.id === client);
    const to = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: CLIENTS.length - 1 }[event.key];
    if (to === undefined) return;
    event.preventDefault();
    const next = CLIENTS[(to + CLIENTS.length) % CLIENTS.length];
    if (!next) return;
    setClient(next.id);
    document.getElementById(`tab-${next.id}`)?.focus();
  };

  return (
    <section className="card doc" id="doc-connect" tabIndex={-1} aria-labelledby="doc-connect-title">
      <h2 id="doc-connect-title">1. Connect your AI</h2>
      <p>
        Scrapy has one address. Your AI connects to it with MCP and gets the tools from it.{' '}
        {personal ? 'This Scrapy is personal: it answers only to its owner. So your AI also sends the owner\u2019s key.' : 'Scrapy asks for no key and no account.'}
      </p>
      <div className="row">
        <code className="address">{address}</code>
        <CopyButton text={address} />
      </div>
      <dl className="facts">
        <div>
          <dt>Kind of connection</dt>
          <dd>Streamable HTTP. Many apps just call it &quot;HTTP&quot; or &quot;remote&quot;.</dd>
        </div>
        <div>
          <dt>Key</dt>
          {personal ? (
            <dd>
              The owner&apos;s key, in the header <code>Authorization: Bearer {KEY_PLACE}</code>. The owner finds it on the dashboard, under <a href={`${dash}#address`}>The address for your agent</a>.
            </dd>
          ) : (
            <dd>None.</dd>
          )}
        </div>
      </dl>

      {closed && (
        <div className="notice warn" role="note">
          <strong>This address is closed.</strong> Its owner has not opened it yet, so it answers no calls. The rest of this page says how it works once it is open.
        </div>
      )}
      {personal && (
        <div className="notice" role="note">
          <strong>This Scrapy is personal.</strong> A request without the owner&apos;s key gets one sentence that says so, and nothing else.{' '}
          {ownerKey ? (
            <>
              You are logged in, so the copy buttons below put your real key where the examples say <code>{KEY_PLACE}</code>. The key itself stays off the screen.
            </>
          ) : (
            <>
              In the examples below, put the key where they say <code>{KEY_PLACE}</code>. Keep it out of files you share.
            </>
          )}
        </div>
      )}
      {secretNeeded && (
        <div className="notice warn" role="note">
          <strong>This is a test address, and Vercel guards it.</strong> Vercel asks for your Vercel login before anything reaches Scrapy, and an AI cannot log in. To let an AI in, create a secret in the Vercel project, under Settings,
          Deployment Protection, &quot;Protection Bypass for Automation&quot;. The AI then sends it with every request, in the header <code>{SECRET_HEADER}</code>. The examples below already have that line: put your secret where they say{' '}
          <code>YOUR_SECRET</code>. Keep it out of files you share.
        </div>
      )}
      {facts.access === 'open' && where.vercel && where.env === 'production' && (
        <div className="notice" role="note">
          <strong>This address is open.</strong> Anyone who has it can use Scrapy, within the limits below.
        </div>
      )}
      {!where.vercel && onOwnMachine && (
        <div className="notice" role="note">
          <strong>This copy of Scrapy runs on your own computer.</strong> An AI can connect to it only if it runs on this computer too.
        </div>
      )}

      <h3>Where to put the address</h3>
      <div className="row" role="tablist" aria-label="Kind of AI app" onKeyDown={onKey}>
        {CLIENTS.map((c) => (
          <button
            key={c.id}
            type="button"
            role="tab"
            id={`tab-${c.id}`}
            aria-selected={client === c.id}
            aria-controls="connect-panel"
            tabIndex={client === c.id ? 0 : -1}
            className={`tab plain ${client === c.id ? 'on' : ''}`}
            onClick={() => setClient(c.id)}
          >
            {c.label}
          </button>
        ))}
      </div>
      <div id="connect-panel" role="tabpanel" aria-labelledby={`tab-${client}`} className="doc-panel">
        <p>{snippet.where}</p>
        {snippet.blocks.map((block) => (
          <CodeBlock
            key={block.caption}
            code={block.code}
            copy={filled(block.code)}
            caption={block.caption}
            label={snippet.blocks.length === 1 ? `For ${CLIENTS.find((c) => c.id === client)?.label ?? client}` : block.caption}
          />
        ))}
        {personal && (
          <p className="soft small">
            An app with no place for a header can carry the key at the end of the address instead: <code>{address}?key={KEY_PLACE}</code>. Use this only where a header is not possible: an address is more easily shown or written down
            somewhere than a header.
          </p>
        )}
        <p className="soft small">Apps change how they are set up. If this does not match what you see, look for &quot;MCP&quot; in your app&apos;s settings and give it the address above.</p>
      </div>

      <h3>Check that it works</h3>
      <ol className="plain-steps">
        <li>
          <strong>By hand.</strong> This asks the address for its list of tools. The answer names <code>search_web</code> and <code>fetch_url</code>. If a login page or the word &quot;closed&quot; comes back instead, your AI will get the same.
          {personal && ' If the answer says "personal", the key is missing or wrong.'}
          <CodeBlock code={handCheck(address, needs)} copy={filled(handCheck(address, needs))} caption="Terminal" label="A check by hand" />
        </li>
        <li>
          <strong>From your AI.</strong> Ask it which tools it has from Scrapy. Then ask it to search for something, and watch the call arrive in the <a href={`${dash}#logs`}>Live feed</a>.
        </li>
      </ol>
    </section>
  );
}

function Limits({ docs }: { docs: DocsPayload }) {
  const f = docs.facts;
  const question = docs.tools.find((t) => t.name === 'search_web')?.params.find((p) => p.name === 'query')?.limits ?? '';
  return (
    <section className="card doc" id="doc-limits" tabIndex={-1} aria-labelledby="doc-limits-title">
      <h2 id="doc-limits-title">2. Limits</h2>
      <p>Scrapy is free because it uses the free doors of other services. Those doors are small. The limits keep an AI that runs in circles from using them up.</p>
      <div className="scroll">
        <table className="limits stack">
          <thead>
            <tr>
              <th>What</th>
              <th>Limit</th>
              <th>At the limit</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Calls a minute, for each caller</td>
              <td className="num">
                <strong>{n(f.limits.perMinute)}</strong>
              </td>
              <td className="note">The call is refused with &quot;Slow down&quot; and how long to wait. A caller is one internet address.</td>
            </tr>
            <tr>
              <td>Calls a day, all callers together</td>
              <td className="num">
                <strong>{n(f.limits.perDay)}</strong>
              </td>
              <td className="note">Every call is refused until midnight UTC. This protects the free allowance of your Vercel account.</td>
            </tr>
            <tr>
              <td>Results of one search</td>
              <td className="num">
                {n(f.search.defaultResults)}, up to {n(f.search.maxResults)}
              </td>
              <td className="note">
                {n(f.search.defaultResults)} unless the AI asks for another number. Never more than {n(f.search.perSite)} from one site.
              </td>
            </tr>
            {question && (
              <tr>
                <td>Length of a search question</td>
                <td className="num">{question}</td>
                <td className="note">A longer one is refused, with a sentence that says so.</td>
              </tr>
            )}
            <tr>
              <td>Length of a page</td>
              <td className="num">{n(f.page.partChars)} characters</td>
              <td className="note">A longer page comes in numbered parts of about this size. The AI asks for the next part.</td>
            </tr>
            <tr>
              <td>Time for one page</td>
              <td className="num">{n(f.page.budgetSeconds)} seconds</td>
              <td className="note">After that the AI is told &quot;Took too long&quot;.</td>
            </tr>
            <tr>
              <td>Memory</td>
              <td className="num">{n(f.search.memoryMinutes)} minutes</td>
              <td className="note">The same call again within this time is answered from memory, at once and with the same answer. It still counts as a call.</td>
            </tr>
            <tr>
              <td>The log</td>
              <td className="num">
                {n(f.logs.keep)} calls, {n(f.logs.hours)} hours
              </td>
              <td className="note">Older calls are forgotten.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="soft small" style={{ marginTop: 12 }}>
        Scrapy does not read private or internal addresses, pages behind a login, or files such as PDFs. The two call limits are settings: <code>SCRAPY_VISITOR_PER_MINUTE</code> and <code>SCRAPY_DAILY_CALLS</code>. They are safety nets, not
        exact counters: when Vercel runs several copies of Scrapy at once, each copy counts the minute for itself.
      </p>
      <p className="soft small" style={{ marginBottom: 0 }}>
        The helpers have limits of their own, and they do not publish them. When a helper says &quot;slow down&quot;, Scrapy lets it rest ({n(f.rest.busyMinutes)} minutes, unless it says how long) and uses the others. When all of them rest,
        the AI is told &quot;busy&quot; and when to try again.
      </p>
    </section>
  );
}

function How({ docs, dash }: { docs: DocsPayload; dash: string }) {
  const f = docs.facts;
  const helpers = [...new Set([...f.search.order, ...f.page.order].map((h) => h.name))];
  // The engines are asked two at a time.
  const pairs: { id: string; name: string }[][] = [];
  for (let i = 0; i < f.search.order.length; i += 2) pairs.push(f.search.order.slice(i, i + 2));
  const own = { name: "Scrapy's own download" };
  const ways = [...(f.page.own === 'first' ? [own] : []), ...f.page.order.map((w) => ({ name: w.name, ...(w.browser ? { mark: 'real browser' } : {}) })), ...(f.page.own === 'last' ? [own] : [])];

  return (
    <section className="card doc" id="doc-how" tabIndex={-1} aria-labelledby="doc-how-title">
      <h2 id="doc-how-title">3. How Scrapy gets an answer</h2>
      <p>
        Scrapy has no search engine and no browser of its own. Other services do that work. This page calls them helpers. Scrapy keeps several for each job, asks them in a fixed order, and checks what comes back before your AI sees it. When
        one helper fails, the next one takes over: that is the fallback.
      </p>

      <div className="three">
        <div>
          <h3>Fast</h3>
          <p>
            Two search engines are asked at the same moment. A page helper that is slow gets company after {n(f.page.hedgeSeconds)} seconds, instead of being waited for. Anything asked in the last {n(f.search.memoryMinutes)} minutes is
            answered from memory.
          </p>
        </div>
        <div>
          <h3>Free</h3>
          <p>
            Each helper has a door that needs no key and no account: {listOf(helpers)}. Nobody pays, not you and not Scrapy. The price is that every free door is small. So Scrapy never depends on one of them.
          </p>
        </div>
        <div>
          <h3>Smart</h3>
          <p>
            An answer does not count because it arrived. An empty page, a page that only says &quot;turn on JavaScript&quot;, and a block page are no answer, and the next way is tried. Fixed rules decide this, not an AI: the same call
            gives the same result.
          </p>
        </div>
      </div>

      <h3>A search, step by step</h3>
      <ol className="ladder" aria-label="A search, step by step">
        <Step title="Memory">Was the same search asked in the last {n(f.search.memoryMinutes)} minutes? Then the answer comes from memory, and nobody is contacted.</Step>
        {pairs.map((pair, i) => (
          <Step key={pair.map((e) => e.id).join('+')} title={i === 0 ? (pair.length > 1 ? 'Two engines at the same time' : 'The first engine') : 'The fallback, only when needed'}>
            <Chips items={pair} />
            {i === 0
              ? pair.length > 1
                ? ` Both are asked at once. When one has answered, the other gets ${n(f.search.graceSeconds)} more seconds.`
                : ' It is asked first.'
              : ` Asked only when the step before failed or found too little: fewer than ${n(f.search.enoughResults)} usable results, or fewer than the AI asked for when that is less.`}
          </Step>
        ))}
        <Step title="Merge and clean">
          The lists become one. A page that several engines found is listed once and ranked higher. Results from {n(f.search.copycatSites)} known copycat sites are left out, and so is everything past {n(f.search.perSite)} results from one
          site.
        </Step>
      </ol>
      <p className="soft small">
        When the AI names sites with <code>include_sites</code>, the engines that can filter by site themselves are asked first.
        {f.search.off.length > 0 && ` Switched off by a setting: ${listOf(f.search.off)}.`}
      </p>

      <h3>A page, step by step</h3>
      <ol className="ladder" aria-label="A page, step by step">
        <Step title="Memory">Was the same page read in the last {n(f.page.memoryMinutes)} minutes? Then it comes from memory.</Step>
        <Step title="The ways, in this order">
          <Chips items={ways} /> The first one is asked. If it fails, the next one is. If it has not answered after {n(f.page.hedgeSeconds)} seconds, the next one starts alongside it, and the first good answer wins.
        </Step>
        <Step title="Scrapy checks the answer">Empty, &quot;turn on JavaScript&quot;, or a block page? Then it is not an answer, and the next way is tried.</Step>
        <Step title="A second look at thin pages">
          A page with fewer than {n(f.page.thinChars)} characters of text may be the empty frame of a page that builds itself with JavaScript. It is read once more in a real browser, and the fuller result is kept.
        </Step>
        <Step title="Clean and cut">Menus, ads, pop-ups and cookie banners are removed. What is left is turned into Markdown and cut into parts of about {n(f.page.partChars)} characters.</Step>
      </ol>
      {f.page.off.length > 0 && <p className="soft small">Switched off by a setting: {listOf(f.page.off)}.</p>}

      <h3>Resting and remembering</h3>
      <p>
        A helper that says &quot;slow down&quot; rests for as long as it asks, or for {n(f.rest.busyMinutes)} minutes. A helper that fails {n(f.rest.failsBeforeRest)} times in a row rests for {n(f.rest.failSeconds)} seconds. The others
        carry on meanwhile. For {n(f.page.siteMemoryHours)} hours Scrapy also remembers which way worked for a site, and tries that way first the next time.
      </p>
      <p className="soft small" style={{ marginBottom: 0 }}>
        {MODE_TEXT[docs.mode] ?? ''} To see which helpers answer right now, and how fast, use <a href={`${dash}#checks`}>Run checks</a>.
      </p>
    </section>
  );
}

const ANATOMY: { value: string; label: string; tone?: string }[] = [
  { value: '11:45:02 AM', label: 'Time' },
  { value: 'search_web', label: 'Tool', tone: 'tool' },
  { value: 'how to fix hydration error', label: 'Query or URL', tone: 'ink' },
  { value: 'Tier 1 · Tavily + Exa', label: 'Method' },
  { value: '0.4s', label: 'Took', tone: 'ink' },
  { value: 'OK', label: 'Result', tone: 'good' },
];

function Logs({ facts, dash }: { facts: Facts; dash: string }) {
  return (
    <section className="card doc" id="doc-logs" tabIndex={-1} aria-labelledby="doc-logs-title">
      <h2 id="doc-logs-title">4. How to read the logs</h2>
      <p>
        The <a href={`${dash}#logs`}>Live feed</a> shows every call your AI makes, the moment Scrapy has answered it. The newest call is at the bottom. One line is one call:
      </p>

      <div className="anatomy" role="img" aria-label="An example line of the live feed: 11:45:02 AM, search_web, how to fix hydration error, Tier 1 by Tavily and Exa, 0.4 seconds, OK">
        {ANATOMY.map((part) => (
          <span className="anatomy-part" key={part.label}>
            <span className={`anatomy-value ${part.tone ?? ''}`}>{part.value}</span>
            <span className="anatomy-label">{part.label}</span>
          </span>
        ))}
      </div>

      <div className="scroll">
        <table className="stack">
          <thead>
            <tr>
              <th>Part</th>
              <th>What it tells you</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Time</td>
              <td className="note">When the call arrived, in your own time zone.</td>
            </tr>
            <tr>
              <td>Tool</td>
              <td className="note">Which tool the AI called.</td>
            </tr>
            <tr>
              <td>Query or URL</td>
              <td className="note">What the AI asked for: the question of a search, or the link of a page.</td>
            </tr>
            <tr>
              <td>Method</td>
              <td className="note">How the answer was obtained, and which helper gave it. The kinds are listed below.</td>
            </tr>
            <tr>
              <td>Took</td>
              <td className="note">From the call arriving to the answer leaving.</td>
            </tr>
            <tr>
              <td>Result</td>
              <td className="note">OK when the AI got what it asked for. FAILED when it got a sentence that says why not.</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3>The kinds of method</h3>
      <div className="scroll">
        <table className="stack">
          <tbody>
            <tr>
              <td className="mono nowrap">Tier 1 (Fast HTTP)</td>
              <td className="note">An ordinary request to a helper. The usual case, and the quick one.</td>
            </tr>
            <tr>
              <td className="mono nowrap">Tier 2 (Real browser)</td>
              <td className="note">A helper read the page in a real browser. Slower. Needed for pages that build themselves with JavaScript.</td>
            </tr>
            <tr>
              <td className="mono nowrap">Memory</td>
              <td className="note">Answered from the {n(facts.search.memoryMinutes)}-minute memory. Nobody was contacted.</td>
            </tr>
            <tr>
              <td className="mono nowrap">None worked</td>
              <td className="note">Every way that was tried failed. Unfold the line to see each one, and why.</td>
            </tr>
            <tr>
              <td className="mono nowrap">Not started</td>
              <td className="note">The call was refused before any work was done: wrong arguments, a private address, or a limit.</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3>Unfold a line</h3>
      <p>
        Press a line and it unfolds into a card. The card repeats the line and adds what does not fit on it: the other arguments the AI sent, every way that was tried with its time, who made the call (an AI over MCP, or the &quot;Try a tool&quot;
        box), and for a failure the sentence the AI got. The last row, Payload, unfolds once more into the response exactly as the AI received it.
      </p>

      <h3>What to look for</h3>
      <ul className="look-for">
        <li>
          <strong>Several FAILED lines with &quot;Not started&quot;.</strong> Your AI sends wrong arguments, or it is over a limit. Unfold one line: Result has the sentence the AI got, and that sentence names what was wrong.
        </li>
        <li>
          <strong>&quot;None worked&quot; on many lines.</strong> The helpers are busy or cannot be reached. <a href={`${dash}#checks`}>Run checks</a> shows which ones answer.
        </li>
        <li>
          <strong>The same call again and again, answered from Memory.</strong> No helper is asked for it, but your AI may be going in circles.
        </li>
        <li>
          <strong>&quot;Tier 2&quot; and several seconds.</strong> The page needed a real browser. That is normal for web apps.
        </li>
      </ul>

      <p className="soft small" style={{ marginBottom: 0 }}>
        {facts.logs.on
          ? `The log is on at this address. It keeps the last ${n(facts.logs.keep)} calls for up to ${n(facts.logs.hours)} hours. ${
              facts.access === 'personal' ? 'Only the owner, logged in, can read them.' : 'Everybody who can open the Live feed can read them.'
            }`
          : 'The log is off at this address, so the Live feed stays empty here. Scrapy writes nothing down.'}{' '}
        Pause stops the feed from asking for new calls. Clear empties the screen only.
      </p>
    </section>
  );
}

export interface McpDocProps {
  docs: DocsPayload | null;
  origin: string;
  failed: boolean;
  onRetry: () => void;
  /** The kind of AI app chosen under "Where to put the address". The page keeps it, so that it is still chosen after a visit to another part. */
  client: ClientId;
  onClient: (id: ClientId) => void;
  /** The owner's key, when the owner is logged in. */
  ownerKey?: string | null;
  /** Where the dashboard is, seen from this page: "" inside the dashboard (the default), "/dashboard" outside it. */
  dash?: string;
}

export function McpDoc({ docs, origin, failed, onRetry, client, onClient, ownerKey = null, dash = '' }: McpDocProps) {
  if (failed) {
    return (
      <section className="card">
        <div className="error" style={{ marginTop: 0 }}>
          The docs could not be loaded from Scrapy.
        </div>
        <button type="button" style={{ marginTop: 12 }} onClick={onRetry}>
          Try again
        </button>
      </section>
    );
  }
  if (!docs || !origin) return <p className="soft">Loading the docs...</p>;

  const address = `${origin}/api/mcp`;

  return (
    <>
      <nav className="doc-nav" aria-label="On this page">
        <span>On this page</span>
        {SECTIONS.map((s, i) => (
          <button type="button" key={s.id} onClick={() => goTo(s.id)}>
            {i + 1}. {s.label}
          </button>
        ))}
      </nav>
      <Connect address={address} facts={docs.facts} client={client} setClient={onClient} ownerKey={ownerKey} dash={dash} />
      <Limits docs={docs} />
      <How docs={docs} dash={dash} />
      <Logs facts={docs.facts} dash={dash} />
      <p className="soft small doc-foot">
        Your AI does not read this page. What it is told is on the page <a href="#docs-ai">For the AI</a>.
      </p>
    </>
  );
}
