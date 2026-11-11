/**
 * Exa, through its hosted MCP server, which works with no key.
 * https://exa.ai/docs/reference/exa-mcp
 *
 * The answers are plain text in a fixed layout (see the server's source at
 * https://github.com/exa-labs/exa-mcp-server). The two parse functions below
 * read that layout.
 */
import { REST } from '../config';
import { clip, HelperError } from '../errors';
import { callRemoteTool, type RemoteAnswer } from '../mcpCall';
import type { Trace } from '../trace';
import { asHelperError } from './shared';
import type { CallOptions, PageQuery, PageWay, RawHit, RawPage, SearchEngine, SearchQuery } from './types';

const ENDPOINT = 'https://mcp.exa.ai/mcp';
const ID = 'exa';

function toolFailure(answer: RemoteAnswer): HelperError {
  const text = answer.text;
  if (answer.meta['ai.exa/rateLimited'] === true || /rate limit/i.test(text)) {
    return new HelperError(ID, 'busy', "Exa's free allowance is used up for now", REST.busySec);
  }
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden|requires an IPv4/i.test(text)) return new HelperError(ID, 'refused', clip(text, 160));
  if (/timed? ?out/i.test(text)) return new HelperError(ID, 'timeout', clip(text, 160));
  return new HelperError(ID, 'failed', clip(text || 'Exa reported an error', 160));
}

/**
 * The search answer is a list of blocks:
 *
 *   Title: ...
 *   URL: ...
 *   Published: ... (or N/A)
 *   Author: ...
 *   Highlights:
 *   ...
 */
export function parseExaSearch(text: string): RawHit[] {
  const starts = [...text.matchAll(/^Title: (.*)\r?\nURL: (\S+)/gm)];
  const hits: RawHit[] = [];
  starts.forEach((match, i) => {
    const from = match.index ?? 0;
    const to = starts[i + 1]?.index ?? text.length;
    const block = text.slice(from, to);
    const url = match[2] ?? '';
    if (!/^https?:\/\//i.test(url)) return;
    const title = (match[1] ?? '').trim();
    const published = /^Published: (.+)$/m.exec(block)?.[1]?.trim();
    const bodyAt = block.search(/^(Highlights:|Text: )/m);
    let snippet = bodyAt === -1 ? '' : block.slice(bodyAt).replace(/^(Highlights:|Text: )\s*/, '');
    snippet = snippet.replace(/\n+---\s*$/, '').trim();
    hits.push({
      url,
      title: title === 'N/A' ? '' : title,
      snippet,
      ...(published && published !== 'N/A' ? { published } : {}),
    });
  });
  return hits;
}

async function search(query: SearchQuery, trace: Trace, opts: CallOptions): Promise<RawHit[]> {
  try {
    // This door has no site filter of its own, so the sites are named in the question.
    const sites = query.includeSites.length > 0 ? ` (only from ${query.includeSites.join(', ')})` : '';
    const answer = await callRemoteTool(trace, {
      endpoint: ENDPOINT,
      tool: 'web_search_exa',
      args: { query: `${query.query}${sites}`.slice(0, 1_000), numResults: Math.min(20, query.count) },
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      purpose: 'exa search',
    });
    trace.sample('exa search', answer.text);
    if (answer.isError) throw toolFailure(answer);
    if (/^No search results found/i.test(answer.text.trim())) return [];
    const hits = parseExaSearch(answer.text);
    if (hits.length === 0) throw new HelperError(ID, 'bad_response', `could not read the answer: ${clip(answer.text, 120)}`);
    return hits;
  } catch (err) {
    throw asHelperError(ID, err);
  }
}

/**
 * The page answer starts with a small header, then a blank line, then the text:
 *
 *   # Title
 *   URL: ...
 *   Published: ...
 *   Author: ...
 *
 *   ...text...
 */
export function parseExaPage(text: string): RawPage {
  const trimmed = text.trim();
  const error = /^Error fetching (?:URL\(s\)|\S+): (.+)$/m.exec(trimmed);
  const header = /^# (.*)\r?\nURL: (\S+)\r?\n(?:Published: .*\r?\n)?(?:Author: .*\r?\n)?/.exec(trimmed);
  if (!header) {
    if (error) {
      const tag = error[1] ?? '';
      if (/NOT_FOUND|404/i.test(tag)) throw new HelperError(ID, 'not_found', 'the page does not exist');
      if (/TIMEOUT/i.test(tag)) throw new HelperError(ID, 'timeout', clip(tag, 120));
      if (/NOT_AVAILABLE|FORBIDDEN|403|BLOCK/i.test(tag)) throw new HelperError(ID, 'blocked', clip(tag, 120));
      throw new HelperError(ID, 'failed', clip(tag, 120));
    }
    if (/^No content found/i.test(trimmed)) throw new HelperError(ID, 'empty', 'the page came back empty');
    throw new HelperError(ID, 'bad_response', `could not read the answer: ${clip(trimmed, 120)}`);
  }
  let body = trimmed.slice(header[0].length);
  // A second page or an error line would follow the first page. Only one link is ever asked for.
  body = body.replace(/\n+Error fetching \S+: .*$/s, '').trim();
  if (body === '') throw new HelperError(ID, 'empty', 'the page came back empty');
  const title = (header[1] ?? '').trim();
  return { markdown: body, finalUrl: header[2], ...(title && title !== '(no title)' ? { title } : {}) };
}

async function load(query: PageQuery, trace: Trace, opts: CallOptions): Promise<RawPage> {
  try {
    const answer = await callRemoteTool(trace, {
      endpoint: ENDPOINT,
      tool: 'web_fetch_exa',
      args: { urls: [query.url], maxCharacters: 400_000 },
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      purpose: 'exa page',
    });
    trace.sample('exa page', answer.text);
    if (answer.isError && !/^Error fetching/m.test(answer.text)) throw toolFailure(answer);
    return parseExaPage(answer.text);
  } catch (err) {
    throw asHelperError(ID, err);
  }
}

export const exaSearch: SearchEngine = { id: ID, name: 'Exa', hosts: ['mcp.exa.ai'], siteFilter: false, search };

export const exaPage: PageWay = { id: ID, name: 'Exa', hosts: ['mcp.exa.ai'], formats: ['markdown'], browser: false, own: false, load };
