/**
 * The tools Scrapy offers, in one list. The MCP address and the check page both
 * run tools through runTool, so they behave exactly the same.
 */
import { z } from 'zod';
import { ScrapyError, type Reason } from '../errors';
import { getLimiter, type Limiter } from '../limits';
import { Trace, type TraceReport } from '../trace';
import { fetchUrl } from './fetchUrl';
import { searchWebTool } from './searchWeb';

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  schema: z.ZodObject;
  run(args: never, trace: Trace): Promise<string>;
}

const searchSchema = z.object({
  query: z.string().min(1).max(500).describe('What to search for: a full question or a few keywords.'),
  max_results: z.number().int().min(1).max(20).optional().describe('How many results to return. Default 8, at most 20.'),
  include_sites: z.array(z.string().max(200)).max(10).optional().describe('Only return results from these sites, for example ["react.dev", "developer.mozilla.org"].'),
  exclude_sites: z.array(z.string().max(200)).max(10).optional().describe('Never return results from these sites.'),
  recency: z.enum(['day', 'week', 'month', 'year']).optional().describe('Only results from the last day, week, month or year.'),
});

const fetchSchema = z.object({
  url: z.string().min(1).max(2000).describe('The link of the page to read.'),
  format: z.enum(['markdown', 'html']).optional().describe('"markdown" (default) or "html".'),
  focus: z.string().max(200).optional().describe('Optional. Return only the parts of the page about this, for example "rate limits". Markdown only.'),
  part: z.number().int().min(1).optional().describe('Long pages come in numbered parts. Which part to return. Default 1.'),
  browser: z.boolean().optional().describe('Set to true to read the page in a real browser. Use it when the normal result is empty or misses content the page builds with JavaScript.'),
});

export const TOOLS: ToolDef[] = [
  {
    name: 'search_web',
    title: 'Search the web',
    description:
      'Search the web and get a clean list of the best links, each with title, link and a short description. ' +
      'Several search engines are asked at once; duplicates and copycat sites are removed. ' +
      'Use it to find how to fix a bug, documentation, examples or design references. Then read a result with fetch_url.',
    schema: searchSchema,
    run: (args: z.infer<typeof searchSchema>, trace) => searchWebTool(args, trace),
  },
  {
    name: 'fetch_url',
    title: 'Read a web page',
    description:
      'Read one web page and get only its main content as clean Markdown (or HTML): no menus, ads, pop-ups or cookie banners. ' +
      'Long pages come in numbered parts; ask for the next with "part". ' +
      'With "focus", only the sections about that topic are returned. ' +
      'If the result is empty or incomplete, call again with browser: true.',
    schema: fetchSchema,
    run: (args: z.infer<typeof fetchSchema>, trace) => fetchUrl(args, trace),
  },
] as ToolDef[];

export const SERVER_INSTRUCTIONS =
  'Scrapy gives you the web. Call search_web to find pages, then fetch_url to read one. ' +
  'Every tool answers with plain text. When a tool cannot do the job it says why in one sentence ' +
  '(for example "Not found", "Needs a login", "Blocked by the site", or "busy, try again in 10 minutes") so you know what to do next.';

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
}

export async function runTool(name: string, rawArgs: unknown, visitor: string, options: RunOptions = {}): Promise<ToolRun> {
  const trace = new Trace(options.debug === true);
  let run: ToolRun;
  try {
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) throw new ScrapyError('bad_input', `There is no tool called "${name}". The tools are: ${TOOLS.map((t) => t.name).join(', ')}.`);
    await (options.limiter ?? getLimiter()).check(visitor);
    const parsed = tool.schema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ');
      throw new ScrapyError('bad_input', `The input for ${name} is not right. ${issues}`);
    }
    const text = await tool.run(parsed.data as never, trace);
    run = { ok: true, text, trace: trace.report() };
  } catch (err) {
    if (err instanceof ScrapyError) {
      run = { ok: false, text: err.message, reason: err.reason, trace: trace.report() };
    } else {
      console.error('[scrapy] unexpected error in', name, err);
      run = { ok: false, text: 'Something went wrong inside Scrapy. Try again.', reason: 'failed', trace: trace.report() };
    }
  }
  // One line per call. No question and no link is written to the log.
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
