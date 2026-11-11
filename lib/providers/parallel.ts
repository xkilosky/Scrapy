/**
 * Parallel, through its hosted MCP server, which works with no key.
 * https://docs.parallel.ai/integrations/mcp/quickstart
 *
 * The exact layout of its answers is not documented, so the reading below is
 * forgiving: structured data first, then JSON inside the text, then plain text.
 */
import { REST } from '../config';
import { clip, HelperError } from '../errors';
import { callRemoteTool, type RemoteAnswer } from '../mcpCall';
import type { Trace } from '../trace';
import { arr, asHelperError, keywordQueries, obj, pageStatusError, str } from './shared';
import type { CallOptions, PageQuery, PageWay, RawHit, RawPage, Recency, SearchEngine, SearchQuery } from './types';

// No trailing slash: the server answers 404 for ".../mcp/".
const ENDPOINT = 'https://mcp.parallel.ai/mcp';
const ID = 'parallel';
const RECENT: Record<Recency, string> = { day: 'the past day', week: 'the past week', month: 'the past month', year: 'the past year' };

/** Parallel asks callers without a key to send back the session id it handed out. */
let sessionId: string | undefined;

function findJson(answer: RemoteAnswer): Record<string, unknown> | null {
  const structured = obj(answer.structured);
  if (structured) return structured;
  const text = answer.text.trim();
  const candidates = [text];
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first > 0 && last > first) candidates.push(text.slice(first, last + 1));
  for (const candidate of candidates) {
    if (!candidate.startsWith('{')) continue;
    try {
      const parsed = obj(JSON.parse(candidate));
      if (parsed) return parsed;
    } catch {
      // not JSON, try the next reading
    }
  }
  return null;
}

function remember(root: Record<string, unknown> | null, text: string): void {
  const found = str(root?.session_id) ?? /session_id["':\s]+([A-Za-z0-9_\-.:]{6,200})/.exec(text)?.[1];
  if (found) sessionId = found;
}

function toolFailure(answer: RemoteAnswer): HelperError {
  const text = answer.text;
  if (/rate.?limit|too many requests|quota|\b429\b/i.test(text)) return new HelperError(ID, 'busy', clip(text, 160), REST.busySec);
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden/i.test(text)) return new HelperError(ID, 'refused', clip(text, 160));
  if (/timed? ?out/i.test(text)) return new HelperError(ID, 'timeout', clip(text, 160));
  return new HelperError(ID, 'failed', clip(text || 'Parallel reported an error', 160));
}

/**
 * Parallel's excerpts are the page's text from the top, so they often start
 * with the menu trail ("Home", "2. / How To", "6 min read"). Those short lines
 * are skipped until the first real sentence.
 */
function withoutLeadIn(excerpt: string): string {
  const lines = excerpt.split('\n');
  const start = lines.findIndex((line) => line.trim().length >= 60);
  return start > 0 ? lines.slice(start).join('\n') : excerpt;
}

function snippetOf(r: Record<string, unknown>): string {
  const excerpts = arr(r.excerpts).filter((e): e is string => typeof e === 'string');
  if (excerpts.length > 0) return excerpts.map(withoutLeadIn).join(' … ');
  return str(r.excerpt) ?? str(r.snippet) ?? str(r.description) ?? str(r.content) ?? str(r.text) ?? '';
}

/** Results from plain text: every link, with the line before it as title and the text after it as description. */
function hitsFromText(text: string): RawHit[] {
  const hits: RawHit[] = [];
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    const link = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/.exec(line);
    const bare = /(https?:\/\/[^\s<>"')\]]+)/.exec(line);
    const url = link?.[2] ?? bare?.[1];
    if (!url || seen.has(url)) return;
    seen.add(url);
    const clean = (s: string): string =>
      s
        .replace(/^[#>*\-\d.\s]+/, '')
        .replace(/\*\*/g, '')
        .replace(/^(title|url|link)\s*:\s*/i, '')
        .trim();
    let title = link?.[1] ?? clean(line.replace(url, ''));
    if (title === '' || /^https?:/i.test(title)) title = clean(lines[i - 1] ?? '');
    const after: string[] = [];
    for (let j = i + 1; j < lines.length && after.join(' ').length < 400; j++) {
      const next = lines[j] ?? '';
      if (/https?:\/\//.test(next) || /^#{1,6}\s/.test(next) || /^(title)\s*:/i.test(next)) break;
      if (next.trim() !== '' && next.trim() !== '---') after.push(next.trim());
    }
    hits.push({ url, title, snippet: after.join(' ') });
  });
  return hits;
}

export function parseParallelSearch(answer: RemoteAnswer): RawHit[] {
  const root = findJson(answer);
  remember(root, answer.text);
  if (root) {
    const list = arr(root.results).length > 0 ? arr(root.results) : arr(obj(root.data)?.results);
    const hits: RawHit[] = [];
    for (const item of list) {
      const r = obj(item);
      const url = str(r?.url);
      if (!r || !url) continue;
      const published = str(r.publish_date) ?? str(r.published_date) ?? str(r.date);
      hits.push({ url, title: str(r.title) ?? '', snippet: snippetOf(r), ...(published ? { published } : {}) });
    }
    if (hits.length > 0 || Array.isArray(root.results)) return hits;
  }
  return hitsFromText(answer.text);
}

async function search(query: SearchQuery, trace: Trace, opts: CallOptions): Promise<RawHit[]> {
  try {
    const wishes: string[] = [];
    if (query.recency) wishes.push(`Prefer results from ${RECENT[query.recency]}.`);
    if (query.includeSites.length > 0) wishes.push(`Only results from: ${query.includeSites.join(', ')}.`);
    if (query.excludeSites.length > 0) wishes.push(`No results from: ${query.excludeSites.join(', ')}.`);
    const site = query.includeSites.length === 1 ? ` site:${query.includeSites[0]}` : '';
    const answer = await callRemoteTool(trace, {
      endpoint: ENDPOINT,
      tool: 'web_search',
      args: {
        objective: [query.query, ...wishes].join(' ').slice(0, 2_000),
        search_queries: keywordQueries(query.query).map((q) => `${q}${site}`),
        ...(sessionId ? { session_id: sessionId } : {}),
      },
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      purpose: 'parallel search',
    });
    trace.sample('parallel search', answer.text || JSON.stringify(answer.structured ?? null));
    if (answer.isError) throw toolFailure(answer);
    const hits = parseParallelSearch(answer);
    if (hits.length === 0 && answer.text.trim().length > 200) {
      throw new HelperError(ID, 'bad_response', `could not read the answer: ${clip(answer.text, 120)}`);
    }
    return hits;
  } catch (err) {
    throw asHelperError(ID, err);
  }
}

export function parseParallelPage(answer: RemoteAnswer): RawPage {
  const root = findJson(answer);
  remember(root, answer.text);
  if (root) {
    const failed = obj(arr(root.errors)[0]);
    const first = obj(arr(root.results)[0]) ?? obj(arr(obj(root.data)?.results)[0]);
    if (first) {
      const excerpts = arr(first.excerpts).filter((e): e is string => typeof e === 'string');
      const content = str(first.full_content) ?? str(first.content) ?? str(first.markdown) ?? (excerpts.length > 0 ? excerpts.join('\n\n') : undefined);
      if (content) {
        const published = str(first.publish_date) ?? str(first.published_date);
        return {
          markdown: content,
          ...(str(first.url) ? { finalUrl: str(first.url) } : {}),
          ...(str(first.title) ? { title: str(first.title) } : {}),
          ...(published ? { published } : {}),
        };
      }
    }
    if (failed) {
      const status = typeof failed.http_status_code === 'number' ? failed.http_status_code : undefined;
      const bad = status !== undefined ? pageStatusError(ID, status) : null;
      if (bad) throw bad;
      throw new HelperError(ID, 'failed', clip(str(failed.error_type) ?? str(failed.content) ?? 'the page could not be read', 160));
    }
    if (Array.isArray(root.results)) throw new HelperError(ID, 'empty', 'the page came back empty');
  }
  const text = answer.text.trim();
  if (text === '') throw new HelperError(ID, 'empty', 'the page came back empty');
  return { markdown: text };
}

async function load(query: PageQuery, trace: Trace, opts: CallOptions): Promise<RawPage> {
  try {
    const answer = await callRemoteTool(trace, {
      endpoint: ENDPOINT,
      tool: 'web_fetch',
      args: { urls: [query.url], full_content: true, ...(sessionId ? { session_id: sessionId } : {}) },
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      purpose: 'parallel page',
    });
    trace.sample('parallel page', answer.text || JSON.stringify(answer.structured ?? null));
    if (answer.isError) throw toolFailure(answer);
    return parseParallelPage(answer);
  } catch (err) {
    throw asHelperError(ID, err);
  }
}

export const parallelSearch: SearchEngine = { id: ID, name: 'Parallel', hosts: ['mcp.parallel.ai'], siteFilter: false, search };

export const parallelPage: PageWay = { id: ID, name: 'Parallel', hosts: ['mcp.parallel.ai'], formats: ['markdown'], browser: true, own: false, load };
