/** The search_web tool: a question in, a clean list of the best links out. */
import type { Recency } from '../providers/types';
import { searchWeb, type SearchDeps, type SearchOutcome } from '../search';
import type { Trace } from '../trace';

export interface SearchArgs {
  query: string;
  max_results?: number | undefined;
  include_sites?: string[] | undefined;
  exclude_sites?: string[] | undefined;
  recency?: Recency | undefined;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "a", "a and b", "a, b and c". */
function listOf(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] ?? ''}`;
}

export function formatSearch(outcome: SearchOutcome): string {
  const asked = outcome.engines.filter((e) => e.ok).map((e) => e.id);
  const how = outcome.cached ? "from Scrapy's 15-minute memory" : `asked ${listOf(asked)}, ${(outcome.tookMs / 1000).toFixed(1)} s`;

  if (outcome.results.length === 0) {
    return `No results for "${outcome.query}" (${how}). Try other words, or fewer filters.`;
  }

  const lines: string[] = [`${plural(outcome.results.length, 'result', 'results')} for "${outcome.query}" (${how})`, ''];
  for (const r of outcome.results) {
    lines.push(`${r.rank}. ${r.title}`);
    lines.push(`   ${r.url}`);
    if (r.snippet) lines.push(`   ${r.snippet}`);
    const extra: string[] = [];
    if (r.published) extra.push(`published ${r.published}`);
    if (r.foundBy.length > 1) extra.push(`found by ${listOf(r.foundBy)}`);
    if (extra.length > 0) lines.push(`   (${extra.join(', ')})`);
    lines.push('');
  }

  const left: string[] = [];
  if (outcome.stats.duplicates > 0) left.push(plural(outcome.stats.duplicates, 'duplicate', 'duplicates'));
  if (outcome.stats.junk > 0) left.push(plural(outcome.stats.junk, 'result from a copycat site', 'results from copycat sites'));
  if (left.length > 0) lines.push(`Left out: ${left.join(', ')}.`);
  lines.push('To read a result, call fetch_url with its link.');
  return lines.join('\n');
}

export async function searchWebTool(args: SearchArgs, trace: Trace, deps: Partial<SearchDeps> = {}): Promise<string> {
  const outcome = await searchWeb(
    {
      query: args.query,
      ...(args.max_results !== undefined ? { count: args.max_results } : {}),
      ...(args.include_sites ? { includeSites: args.include_sites } : {}),
      ...(args.exclude_sites ? { excludeSites: args.exclude_sites } : {}),
      ...(args.recency ? { recency: args.recency } : {}),
    },
    trace,
    deps,
  );
  return formatSearch(outcome);
}
