/**
 * The docs, made from the same definitions the tools run on.
 *
 * Two readers:
 * - A person (the developer). The docs page shows them how to connect an
 *   agent, the limits, how Scrapy gets an answer, and how to read the log.
 * - An AI agent. It never opens a page. It is told how to use Scrapy in three
 *   ways, all made here and in lib/tools:
 *     1. over MCP, the moment it connects: the server's instructions, and each
 *        tool's description and parameters. Every agent gets these.
 *     2. the rulebook, as the MCP resource "scrapy://rulebook", for agents
 *        that read resources.
 *     3. the same rulebook as plain text at /llms.txt, to read or to paste
 *        into an agent's own instructions.
 *
 * Nothing here is written twice. Parameters come from the tools' schemas,
 * numbers from lib/config.ts, and the list of failures from lib/errors.ts.
 */
import { access, type Access } from './access';
import { getMode, limits, LOGS, logsOn, onVercel, PAGE, pageOrder, RELEASE, REST, SEARCH, searchOrder, switchedOff, VERSION, type Mode } from './config';
import { FAILURES, type Reason } from './errors';
import { PAGE_HELPERS, SEARCH_ENGINES } from './providers';
import { JUNK_SITES } from './search/junk-sites';
import { checkedInput, RULEBOOK_URI, SERVER_INSTRUCTIONS, TOOLS, type ToolDef, type ToolExample } from './tools';
import { jsonSchemaOf, paramInBrief, paramsOf, signatureOf, type ParamDoc } from './tools/describe';

export interface ToolDoc {
  name: string;
  title: string;
  description: string;
  params: ParamDoc[];
  /** Every parameter in one line. */
  signature: string;
  examples: ToolExample[];
  answer: { sample: string; notes: string[] };
  /** What happens when an agent guesses: the arguments of a guess, and the sentence Scrapy really answers with. */
  wrongInput: { args: Record<string, unknown>; answer: string };
  /** The parameters as JSON Schema, exactly as an agent receives them over MCP. */
  schema: Record<string, unknown>;
}

export interface FailureDoc {
  reason: Reason;
  starts: string[];
  means: string;
  then: string;
}

/** The numbers and settings the docs for people quote. All of them are read from the running Scrapy. */
export interface Facts {
  /** Who may use this Scrapy: its owner alone (personal), everybody who gets to it (open), or nobody for now (closed). */
  access: Access;
  limits: { perMinute: number; perDay: number };
  search: {
    defaultResults: number;
    maxResults: number;
    perSite: number;
    engineSeconds: number;
    graceSeconds: number;
    enoughResults: number;
    memoryMinutes: number;
    copycatSites: number;
    /** The engines in use, in the order they are asked. The first two are asked at once. */
    order: { id: string; name: string }[];
    off: string[];
  };
  page: {
    partChars: number;
    memoryMinutes: number;
    budgetSeconds: number;
    hedgeSeconds: number;
    thinChars: number;
    siteMemoryHours: number;
    /** The helpers in use, in the order they are tried. */
    order: { id: string; name: string; browser: boolean }[];
    off: string[];
    /** When Scrapy downloads a page itself: never (safe), after the helpers (middle), or before them (full). */
    own: 'never' | 'last' | 'first';
  };
  rest: { busyMinutes: number; failSeconds: number; failsBeforeRest: number };
  logs: { on: boolean; keep: number; hours: number };
  where: { vercel: boolean; env: string | null };
}

export interface DocsPayload {
  version: string;
  /** The name of the release, as people see it. */
  release: string;
  mode: Mode;
  /** What every agent is told when it connects. */
  instructions: string;
  rulebookUri: string;
  /** The whole rulebook as text. */
  rulebook: string;
  /** The line that says where Scrapy is. The page puts its own address where this says "{address}". */
  addressLine: string;
  tools: ToolDoc[];
  failures: FailureDoc[];
  facts: Facts;
}

/** The sentence a tool answers with when it is given its "mistake" arguments. Produced by the real check, not written here. */
function answerToMistake(tool: ToolDef): string {
  try {
    checkedInput(tool, tool.mistake);
    return '';
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export function toolDocs(): ToolDoc[] {
  return TOOLS.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    params: paramsOf(tool.schema),
    signature: signatureOf(tool.schema),
    examples: tool.examples,
    answer: tool.answer,
    wrongInput: { args: tool.mistake, answer: answerToMistake(tool) },
    schema: jsonSchemaOf(tool.schema),
  }));
}

export function failureDocs(): FailureDoc[] {
  return (Object.entries(FAILURES) as [Reason, (typeof FAILURES)[Reason]][]).map(([reason, advice]) => ({ reason, starts: advice.starts, means: advice.means, then: advice.then }));
}

function inOrder<T extends { id: string }>(items: T[], order: string[]): T[] {
  const rank = (id: string): number => {
    const at = order.indexOf(id);
    return at === -1 ? order.length : at;
  };
  // Array.sort is stable: items the order does not name keep their own order, after the named ones.
  return [...items].sort((a, b) => rank(a.id) - rank(b.id));
}

export function facts(): Facts {
  const cfg = limits();
  const off = switchedOff();
  const mode = getMode();
  return {
    access: access(),
    limits: { perMinute: cfg.visitorPerMinute, perDay: cfg.dailyCalls },
    search: {
      defaultResults: SEARCH.defaultCount,
      maxResults: SEARCH.maxCount,
      perSite: SEARCH.perSite,
      engineSeconds: SEARCH.engineTimeoutMs / 1000,
      graceSeconds: SEARCH.graceMs / 1000,
      enoughResults: SEARCH.enoughResults,
      memoryMinutes: Math.round(SEARCH.cacheSec / 60),
      copycatSites: JUNK_SITES.length,
      order: inOrder(SEARCH_ENGINES, searchOrder())
        .filter((e) => !off.has(e.id))
        .map((e) => ({ id: e.id, name: e.name })),
      off: SEARCH_ENGINES.filter((e) => off.has(e.id)).map((e) => e.name),
    },
    page: {
      partChars: PAGE.partChars,
      memoryMinutes: Math.round(PAGE.cacheSec / 60),
      budgetSeconds: PAGE.budgetMs / 1000,
      hedgeSeconds: PAGE.hedgeAfterMs / 1000,
      thinChars: PAGE.thinChars,
      siteMemoryHours: Math.round(PAGE.siteMemorySec / 3600),
      order: inOrder(PAGE_HELPERS, pageOrder())
        .filter((w) => !off.has(w.id))
        .map((w) => ({ id: w.id, name: w.name, browser: w.browser })),
      off: PAGE_HELPERS.filter((w) => off.has(w.id)).map((w) => w.name),
      own: mode === 'safe' || off.has('own') ? 'never' : mode === 'full' ? 'first' : 'last',
    },
    rest: { busyMinutes: Math.round(REST.busySec / 60), failSeconds: REST.failSec, failsBeforeRest: REST.failsBeforeRest },
    logs: { on: logsOn(), keep: LOGS.keep, hours: LOGS.hours },
    where: { vercel: onVercel(), env: process.env.VERCEL_ENV ?? null },
  };
}

const n = (value: number): string => value.toLocaleString('en-US');
const asCode = (items: string[]): string => items.map((item) => `\`${item}\``).join(' or ');

/** The line of the rulebook that says where Scrapy is, and what a caller needs there. */
export function addressLine(address: string, state: Access = access()): string {
  if (state === 'personal') return `MCP address: ${address} (Streamable HTTP). This Scrapy is personal: every request must carry its owner's key, in the header "Authorization: Bearer <key>".`;
  if (state === 'closed') return `MCP address: ${address} (Streamable HTTP). This Scrapy is closed for now: it answers no calls.`;
  return `MCP address: ${address} (Streamable HTTP, no key needed).`;
}

/**
 * The rulebook for AI agents, as Markdown.
 *
 * It is written to be read by a model: short sentences, one rule each, exact
 * names, and nothing it does not need. With an address, it also says where
 * Scrapy is, for an agent that reads the rulebook before it connects.
 */
export function rulebook(options: { address?: string } = {}): string {
  const f = facts();
  const tools = toolDocs();
  const out: string[] = [];
  const say = (...lines: string[]): void => void out.push(...lines);

  say(
    '# Scrapy: the rulebook for AI agents',
    '',
    'Scrapy gives you the web through MCP tools: you can search it, and you can read pages. This rulebook says exactly how to call each tool. Follow it. Do not guess parameter names or values.',
    '',
  );
  if (options.address) say(addressLine(options.address), '');

  say(
    '## Which tool to use',
    '',
    '- You need information and have no link: call `search_web`.',
    '- You have a link and need what the page says: call `fetch_url`.',
    '- Never make up a link. If you have none, call `search_web` first and take a link from its answer.',
    '',
    '## How to call a tool',
    '',
    '- Send the arguments as one JSON object.',
    '- Use exactly the parameter names listed below. A parameter that is not listed is refused.',
    '- Leave out a parameter you do not need.',
    '- Give each value in the type listed: a number as `5` and not `"5"`, a boolean as `true` and not `"true"`, a list as `["react.dev"]` and not `"react.dev"`.',
    '- Every tool answers with plain text.',
    '',
  );

  for (const tool of tools) {
    say(`## ${tool.name}: ${tool.title}`, '', tool.description, '', 'Parameters:', '');
    for (const p of tool.params) say(`- \`${p.name}\` ${paramInBrief(p).slice(p.name.length + 1)}: ${p.about}`);
    say('', 'Examples of the arguments:', '');
    for (const example of tool.examples) say(`- ${example.about} \`${JSON.stringify(example.args)}\``);
    say('', 'The answer looks like this:', '', '```', tool.answer.sample, '```', '');
    for (const note of tool.answer.notes) say(`- ${note}`);
    say('');
  }

  say(
    '## Working well',
    '',
    '- Search, then read. The description under a search result is short. Read the page with `fetch_url` before you rely on what it says.',
    '- Narrow a search with `include_sites` or `recency` rather than with more words.',
    '- For a long page, use `focus` to get only the sections you need, or read it part by part with `part`.',
    `- The same call again within ${f.search.memoryMinutes} minutes is answered from memory, at once and with the same answer. Do not repeat a call to get a newer answer.`,
    '- The parts of a page come from that memory too: asking for the next part does not load the page again.',
    '',
    '## When a tool cannot do the job',
    '',
    'The answer is then a sentence that says why, marked as an error. Find how it starts in this table, and do what the table says. Never repeat a failed call unchanged, unless the table says so.',
    '',
    '| The answer starts with | What it means | What to do |',
    '| --- | --- | --- |',
  );
  for (const failure of failureDocs()) say(`| ${asCode(failure.starts)} | ${failure.means} | ${failure.then} |`);

  say(
    '',
    '## Limits',
    '',
    `- At most ${n(f.limits.perMinute)} calls a minute for each caller.`,
    `- At most ${n(f.limits.perDay)} calls a day for all callers together.`,
    '- Every call counts, also one that is answered from memory and one with wrong input.',
    `- A search returns ${n(f.search.defaultResults)} results unless you ask for another number, at most ${n(f.search.maxResults)}, and at most ${n(f.search.perSite)} from one site.`,
    `- A page comes in parts of about ${n(f.page.partChars)} characters.`,
    '- Scrapy reads public web pages only: no private or internal addresses, no pages behind a login, no files.',
    '',
  );
  return out.join('\n');
}

export function docsPayload(): DocsPayload {
  return {
    version: VERSION,
    release: RELEASE,
    mode: getMode(),
    instructions: SERVER_INSTRUCTIONS,
    rulebookUri: RULEBOOK_URI,
    rulebook: rulebook(),
    addressLine: addressLine('{address}'),
    tools: toolDocs(),
    failures: failureDocs(),
    facts: facts(),
  };
}

/** The address a request came to, as the caller typed it: "https://scrapy.example". */
export function originOf(request: Request): string {
  const url = new URL(request.url);
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? url.host;
  const proto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() ?? url.protocol.replace(':', '');
  return `${proto}://${host}`;
}
