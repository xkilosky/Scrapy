/**
 * The tools Scrapy offers, in one list. The MCP address and the check page both
 * run tools through runTool, so they behave exactly the same.
 *
 * Everything an agent is told about a tool comes from this file: its
 * description, its parameters (the schema), its examples. The docs page and
 * the rulebook (lib/docs.ts) are made from the same list, so what the docs say
 * and what a tool accepts cannot drift apart.
 */
import { z } from 'zod';
import { PAGE, SEARCH } from '../config';
import { ScrapyError, type Reason } from '../errors';
import { getLimiter, type Limiter } from '../limits';
import { getLogBook, logCall, type LogBook } from '../logs';
import { Trace, type TraceReport } from '../trace';
import { mustBe, shapeOf, signatureOf, type JsonProperty } from './describe';
import { fetchUrl } from './fetchUrl';
import { searchWebTool } from './searchWeb';

export interface ToolExample {
  /** What the example is for, in a few words. */
  about: string;
  /** The arguments, exactly as an agent would send them. */
  args: Record<string, unknown>;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  /** The parameters. Strict: a parameter that is not listed here is refused, with a sentence that lists the real ones. */
  schema: z.ZodObject;
  /** Arguments an agent could send. Shown in the docs; a test checks that every one of them is accepted. */
  examples: ToolExample[];
  /** What the answer looks like. Shown in the docs; a test checks it against real answers. */
  answer: { sample: string; notes: string[] };
  /** Arguments an agent might send when it guesses. The docs show what Scrapy answers to them; a test checks that they are refused. */
  mistake: Record<string, unknown>;
  run(args: never, trace: Trace): Promise<string>;
}

const searchSchema = z.strictObject({
  query: z.string().min(1).max(500).describe('What to search for: a full question or a few keywords.'),
  max_results: z
    .number()
    .int()
    .min(1)
    .max(SEARCH.maxCount)
    .optional()
    .describe(`How many results to return: a whole number from 1 to ${SEARCH.maxCount}. Default ${SEARCH.defaultCount}.`)
    .meta({ default: SEARCH.defaultCount }),
  include_sites: z
    .array(z.string().max(200))
    .max(10)
    .optional()
    .describe('Only return results from these sites. A list of site names without "https://", for example ["react.dev", "developer.mozilla.org"].'),
  exclude_sites: z.array(z.string().max(200)).max(10).optional().describe('Never return results from these sites. A list of site names, like include_sites.'),
  recency: z.enum(['day', 'week', 'month', 'year']).optional().describe('Only results published in the last day, week, month or year. Leave it out for any time.'),
});

const fetchSchema = z.strictObject({
  url: z.string().min(1).max(2000).describe('The link of the page to read, for example "https://react.dev/learn". Take it from a search_web answer or from the user. Never make one up.'),
  format: z.enum(['markdown', 'html']).optional().describe('"markdown" (default) returns clean Markdown. "html" returns the tidy HTML of the main content.').meta({ default: 'markdown' }),
  focus: z.string().max(200).optional().describe('A topic, for example "rate limits". Only the sections of the page about it are returned. Works with markdown only.'),
  part: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(`Long pages come in numbered parts of about ${PAGE.partChars.toLocaleString('en-US')} characters. Which part to return: a whole number from 1. Default 1. The answer says how many parts there are.`)
    .meta({ default: 1 }),
  browser: z
    .boolean()
    .optional()
    .describe('true reads the page in a real browser. Use it only when a normal call came back empty, or misses content that the page builds with JavaScript. Default false.')
    .meta({ default: false }),
});

export const TOOLS: ToolDef[] = [
  {
    name: 'search_web',
    title: 'Search the web',
    description:
      'Search the web and get a clean list of the best links, each with title, link and a short description. ' +
      'Several search engines are asked at once; duplicates and copycat sites are removed. ' +
      'Use it whenever you need information and have no link: how to fix a bug, documentation, examples, design references. ' +
      'Then read a result with fetch_url.',
    schema: searchSchema,
    examples: [
      { about: 'A plain search.', args: { query: 'next.js hydration error fix' } },
      { about: 'Fewer results, and only from two sites.', args: { query: 'useEffect cleanup function', max_results: 5, include_sites: ['react.dev', 'developer.mozilla.org'] } },
      { about: 'Only pages from the last month, and none from one site.', args: { query: 'tailwind css v4 migration', recency: 'month', exclude_sites: ['pinterest.com'] } },
    ],
    answer: {
      sample: [
        '5 results for "next.js hydration error fix" (asked tavily and exa, 0.6 s)',
        '',
        '1. Text content does not match server-rendered HTML',
        '   https://nextjs.org/docs/messages/react-hydration-error',
        '   Why the error happens, and the usual ways to fix it.',
        '   (published 2026-02-01, found by tavily and exa)',
        '',
        '2. ...',
        '',
        'Left out: 1 duplicate, 1 result from a copycat site.',
        'To read a result, call fetch_url with its link.',
      ].join('\n'),
      notes: [
        'The first line says how many results there are and who was asked.',
        'Each result has a number, a title, the link, and a short description. The line in brackets appears only when there is a date, or when several engines found the page.',
        'The best results come first. A page that several engines found is ranked higher.',
        'With no results the answer is one sentence that starts with "No results for". That is not an error: try other words, or fewer filters.',
      ],
    },
    mistake: { q: 'next.js hydration error fix', limit: 3 },
    run: (args: z.infer<typeof searchSchema>, trace) => searchWebTool(args, trace),
  },
  {
    name: 'fetch_url',
    title: 'Read a web page',
    description:
      'Read one web page and get only its main content as clean Markdown (or HTML): no menus, ads, pop-ups or cookie banners. ' +
      'Use it when you have a link, from a search_web answer or from the user. Never make up a link. ' +
      'Long pages come in numbered parts; ask for the next with "part". ' +
      'With "focus", only the sections about that topic are returned. ' +
      'If the result is empty or incomplete, call again with browser: true.',
    schema: fetchSchema,
    examples: [
      { about: 'Read a page.', args: { url: 'https://react.dev/learn/you-might-not-need-an-effect' } },
      { about: 'Only the sections about one topic.', args: { url: 'https://nextjs.org/docs/app/getting-started/caching', focus: 'revalidation' } },
      { about: 'The next part of a long page.', args: { url: 'https://react.dev/reference/react/useEffect', part: 2 } },
      { about: 'A page that came back empty: read it again in a real browser.', args: { url: 'https://quotes.toscrape.com/js/', browser: true } },
      { about: 'The page as tidy HTML, when its structure matters.', args: { url: 'https://example.com/', format: 'html' } },
    ],
    answer: {
      sample: [
        'Title: You Might Not Need an Effect',
        'URL: https://react.dev/learn/you-might-not-need-an-effect',
        'Loaded: by Jina Reader in 0.9 s',
        'Part: 1 of 3 (call fetch_url again with part: 2 for the next part)',
        '',
        '---',
        '',
        '# You Might Not Need an Effect',
        '',
        'Effects are an escape hatch from the React paradigm. ...',
      ].join('\n'),
      notes: [
        'The lines before "---" describe the page. The content of the page comes after it.',
        '"Title", "URL" and "Loaded" are always there. "URL" is where the page really is, after any redirect.',
        '"Part" appears only when the page has more than one part. It says which call gets the next one.',
        '"Published" appears when the page gives a date, "Focus" when focus was used, and "Note" when Scrapy has something to add.',
      ],
    },
    mistake: { link: 'https://react.dev/learn' },
    run: (args: z.infer<typeof fetchSchema>, trace) => fetchUrl(args, trace),
  },
] as ToolDef[];

/** Where an agent finds the whole rulebook over MCP (see lib/docs.ts). */
export const RULEBOOK_URI = 'scrapy://rulebook';

/** Told to every agent the moment it connects. Short on purpose: the details are in each tool's own description and parameters. */
export const SERVER_INSTRUCTIONS =
  'Scrapy gives you the web. Call search_web to find pages when you have no link, then fetch_url to read one. Never make up a link. ' +
  'Send exactly the parameters each tool lists, and nothing else: a parameter that is not listed is refused. ' +
  'Every tool answers with plain text. When a tool cannot do the job it says why in one sentence ' +
  '(for example "Not found", "Needs a login", "Blocked by the site", or "busy, try again in about 10 minutes") so you know what to do next. ' +
  'Do what that sentence says, and do not repeat the call sooner than it says. ' +
  `The same call again within ${Math.round(SEARCH.cacheSec / 60)} minutes is answered from memory, with the same answer. ` +
  `The full rulebook is the resource ${RULEBOOK_URI}.`;

export interface ToolRun {
  ok: boolean;
  text: string;
  reason?: Reason;
  trace: TraceReport;
}

export interface RunOptions {
  /** Keep the start of each helper's raw answer in the trace. For the check page. */
  debug?: boolean;
  limiter?: Limiter;
  /** Who is asking: an agent over MCP (the default), or the "Try a tool" box of the check page. */
  from?: 'agent' | 'page';
  /** Where the call is written down for the live feed. Tests pass their own book. */
  logs?: LogBook;
}

/** Marks a value that counts as left out. */
const LEFT_OUT = Symbol('left out');

/**
 * Puts right a value that has the wrong form but can only mean one thing.
 *
 * Some agents, and some of the programs between a model and Scrapy, write
 * every value as text, or send a single item where a list is expected. Such a
 * call says clearly what it wants, so it is carried out and not sent back.
 * What a value means is never guessed at: a number outside its limits, or a
 * word that is not one of the listed ones, is still refused.
 */
function putRight(value: unknown, property: JsonProperty, required: boolean): unknown {
  // An empty text for a parameter that need not be given: left out.
  if (typeof value === 'string' && value.trim() === '' && !required) return LEFT_OUT;

  const isList = property.type === 'array';
  const isNumber = property.type === 'integer' || property.type === 'number';
  const isText = property.type === 'string';

  if (typeof value === 'string') {
    const text = value.trim();
    // "5" for a number, "true" for a boolean.
    if (isNumber && /^-?\d+(\.\d+)?$/.test(text)) return Number(text);
    if (property.type === 'boolean' && /^(true|false)$/i.test(text)) return text.toLowerCase() === 'true';
    if (isList) {
      // A list written as text: '["react.dev"]'.
      if (text.startsWith('[')) {
        try {
          const list: unknown = JSON.parse(text);
          if (Array.isArray(list)) return list;
        } catch {
          // Not a list after all. It is refused below, like any other wrong value.
          return value;
        }
      }
      // One item where a list is expected: a list of one.
      return [value];
    }
    // "Week" for "week".
    if (isText && Array.isArray(property.enum)) {
      const listed = property.enum.find((option) => typeof option === 'string' && option.toLowerCase() === text.toLowerCase());
      if (listed !== undefined) return listed;
    }
    return value;
  }
  // 2026 for a text: a program on the way took the text "2026" for a number.
  if (isText && !Array.isArray(property.enum) && (typeof value === 'number' || typeof value === 'boolean')) return String(value);
  return value;
}

/**
 * Checks what an agent sent against the tool's parameters.
 *
 * Scrapy does this itself, for calls over MCP too, so that an agent always
 * gets the same kind of sentence: what is wrong, and then every parameter the
 * tool really has. An agent that guessed should not have to guess twice.
 *
 * Strict about names and meaning: a parameter the tool does not have is
 * refused, and so is a value outside its limits.
 * Forgiving about form, where the form can only mean one thing (see putRight).
 * A parameter set to null counts as left out. Some agents send null for
 * everything they do not use.
 */
export function checkedInput(tool: ToolDef, rawArgs: unknown): unknown {
  const wrong = (what: string): ScrapyError => new ScrapyError('bad_input', `The input for ${tool.name} is not right. ${what} Parameters of ${tool.name}: ${signatureOf(tool.schema)}.`);

  if (rawArgs !== undefined && rawArgs !== null && (typeof rawArgs !== 'object' || Array.isArray(rawArgs))) {
    throw wrong(`The arguments must be one JSON object, for example ${JSON.stringify(tool.examples[0]?.args ?? {})}.`);
  }
  const sent = Object.entries((rawArgs ?? {}) as Record<string, unknown>).filter(([, value]) => value !== null && value !== undefined);

  const { properties, required, docs } = shapeOf(tool.schema);
  const unknown = sent.map(([key]) => key).filter((key) => !Object.hasOwn(properties, key));
  if (unknown.length > 0) {
    throw wrong(`It has no parameter ${unknown.slice(0, 5).map((key) => JSON.stringify(key.slice(0, 60))).join(' or ')}.`);
  }

  const given: Record<string, unknown> = {};
  for (const [key, value] of sent) {
    const right = putRight(value, properties[key] ?? {}, required.has(key));
    if (right !== LEFT_OUT) given[key] = right;
  }

  const parsed = tool.schema.safeParse(given);
  if (!parsed.success) {
    // One sentence for each parameter that is wrong: what was sent, and what it must be.
    const said = new Set<string>();
    const sentences: string[] = [];
    for (const issue of parsed.error.issues) {
      const name = String(issue.path[0] ?? '');
      if (said.has(name)) continue;
      said.add(name);
      const doc = docs.get(name);
      if (!doc) sentences.push(`${issue.message}.`);
      else if (!Object.hasOwn(given, name)) sentences.push(`"${name}" is missing. It is required.`);
      else if (given[name] === '') sentences.push(`"${name}" is empty. It is required.`);
      else sentences.push(`"${name}" is ${inBrief(given[name])}. It must be: ${mustBe(doc)}.`);
    }
    throw wrong(sentences.slice(0, 5).join(' '));
  }
  return parsed.data;
}

/** A value as it was sent, short enough to quote in a sentence. */
function inBrief(value: unknown): string {
  if (typeof value === 'string' && value.length > 60) return `${JSON.stringify(`${value.slice(0, 40)}...`)} (${value.length.toLocaleString('en-US')} characters)`;
  const text = JSON.stringify(value) ?? String(value);
  if (text.length <= 80) return text;
  return Array.isArray(value) ? `a list of ${value.length.toLocaleString('en-US')} items` : `${text.slice(0, 77)}...`;
}

export async function runTool(name: string, rawArgs: unknown, visitor: string, options: RunOptions = {}): Promise<ToolRun> {
  const trace = new Trace(options.debug === true);
  let run: ToolRun;
  /** True once the call has passed the limits. Until then it has cost nothing, and nothing bounds how many there are. */
  let admitted = false;
  try {
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) throw new ScrapyError('bad_input', `There is no tool called "${name}". The tools are: ${TOOLS.map((t) => t.name).join(', ')}.`);
    await (options.limiter ?? getLimiter()).check(visitor);
    admitted = true;
    const text = await tool.run(checkedInput(tool, rawArgs) as never, trace);
    run = { ok: true, text, trace: trace.report() };
  } catch (err) {
    if (err instanceof ScrapyError) {
      run = { ok: false, text: err.message, reason: err.reason, trace: trace.report() };
    } else {
      console.error('[scrapy] unexpected error in', name, err);
      run = { ok: false, text: 'Something went wrong inside Scrapy. Try again.', reason: 'failed', trace: trace.report() };
    }
  }
  // The live feed of the check page. Every call that passed the limits is listed. A call that
  // was turned away before that (the caller is over a limit, or asked for a tool that does not
  // exist) is listed once a minute for each caller: a caller stuck in a loop must not fill the log.
  const book = options.logs ?? getLogBook();
  if (admitted || book.shouldListRefusal(visitor)) {
    logCall({ tool: name, rawArgs, from: options.from ?? 'agent', at: trace.startedAt, ok: run.ok, text: run.text, trace: run.trace }, book);
  }

  // Vercel's own log: one line per call. No question and no link is written to it.
  if (process.env.VITEST) return run;
  console.log(
    JSON.stringify({
      scrapy: 'tool',
      tool: name,
      ok: run.ok,
      ...(run.reason ? { reason: run.reason } : {}),
      ms: run.trace.totalMs,
      cache: run.trace.cache,
      steps: run.trace.steps.map((s) => `${s.way}:${s.ok ? 'ok' : 'no'}:${s.ms}`),
      hosts: run.trace.hosts,
    }),
  );
  return run;
}
