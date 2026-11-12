/**
 * search_web: asks two free search engines at the same time, merges what they
 * found, and falls back to the other engines when that is not enough.
 */
import { REST, SEARCH, searchOrder, SNIPPET_ORDER, switchedOff } from '../config';
import { describeFailure, HelperError, ScrapyError, waitText } from '../errors';
import { getHealth, type Health } from '../health';
import { SEARCH_ENGINES } from '../providers';
import { asHelperError, bareDomain } from '../providers/shared';
import type { RawHit, Recency, SearchEngine, SearchQuery } from '../providers/types';
import { getStore, keyOf, type Store } from '../store';
import type { Trace } from '../trace';
import { JUNK_SITES } from './junk-sites';
import { mergeHits, type EngineHits, type MergeStats, type SearchResult } from './merge';

export interface SearchInput {
  query: string;
  count?: number;
  includeSites?: string[];
  excludeSites?: string[];
  recency?: Recency;
}

export interface EngineReport {
  id: string;
  ok: boolean;
  ms: number;
  results: number;
  note: string;
}

export interface SearchOutcome {
  query: string;
  results: SearchResult[];
  stats: MergeStats;
  engines: EngineReport[];
  /** True when the answer came from Scrapy's 15-minute memory. */
  cached: boolean;
  tookMs: number;
}

export interface SearchDeps {
  engines: SearchEngine[];
  store: Store;
  health: Health;
  order: string[];
  off: Set<string>;
  junk: string[];
}

function defaults(): SearchDeps {
  return { engines: SEARCH_ENGINES, store: getStore(), health: getHealth(), order: searchOrder(), off: switchedOff(), junk: JUNK_SITES };
}

interface EngineRun extends EngineReport {
  hits: RawHit[];
  error?: HelperError;
}

function sites(list: string[] | undefined): string[] {
  return [...new Set((list ?? []).map(bareDomain).filter((s) => s.includes('.')))].slice(0, 10);
}

async function runBatch(batch: SearchEngine[], query: SearchQuery, trace: Trace, health: Health): Promise<EngineRun[]> {
  const stop = new AbortController();
  let grace: ReturnType<typeof setTimeout> | undefined;

  const runs = batch.map(async (engine): Promise<EngineRun> => {
    const started = Date.now();
    const id = `${engine.id}:search`;
    try {
      const hits = await engine.search(query, trace, { timeoutMs: SEARCH.engineTimeoutMs, signal: stop.signal });
      const ms = Date.now() - started;
      health.succeeded(id, ms);
      const note = `${hits.length} results`;
      trace.step(`${engine.id} search`, true, ms, note);
      // One engine has answered. The other gets a little longer, then Scrapy stops waiting for it.
      if (hits.length > 0 && batch.length > 1 && grace === undefined) grace = setTimeout(() => stop.abort(), SEARCH.graceMs);
      return { id: engine.id, ok: true, ms, results: hits.length, note, hits };
    } catch (err) {
      const error = asHelperError(engine.id, err);
      const ms = Date.now() - started;
      if (error.kind === 'busy') await health.rest(id, error.retryAfterSec ?? REST.busySec, error.message);
      else if (error.kind === 'refused') await health.rest(id, 3_600, error.message);
      else if (error.kind === 'unreachable' || error.kind === 'bad_response' || error.kind === 'timeout') await health.failed(id, error.message);
      const note = error.kind === 'cancelled' ? 'slower than the other engine, not waited for' : describeFailure(error);
      trace.step(`${engine.id} search`, false, ms, note);
      return { id: engine.id, ok: false, ms, results: 0, note, hits: [], error };
    }
  });

  const done = await Promise.all(runs);
  if (grace !== undefined) clearTimeout(grace);
  return done;
}

function explain(runs: EngineRun[], resting: { id: string; sec: number }[]): ScrapyError {
  const details = [...runs.map((r) => `${r.id}: ${r.note}`), ...resting.map((r) => `${r.id}: resting, back ${waitText(r.sec)}`)].join('; ');
  const kinds = runs.map((r) => r.error?.kind);
  const waits = [...runs.map((r) => (r.error?.kind === 'busy' ? (r.error.retryAfterSec ?? REST.busySec) : null)), ...resting.map((r) => r.sec)].filter(
    (n): n is number => n !== null,
  );
  const wait = waits.length > 0 ? Math.min(...waits) : REST.busySec;
  if (runs.length > 0 && kinds.every((k) => k === 'timeout' || k === 'cancelled')) {
    return new ScrapyError('too_slow', `Took too long: the free search services did not answer in time. Try again. (${details})`);
  }
  if (runs.length > 0 && kinds.every((k) => k === 'unreachable')) {
    return new ScrapyError('failed', `The free search services could not be reached. Try again in a minute. (${details})`, 60);
  }
  return new ScrapyError('busy', `The free search services are busy. Try again ${waitText(wait)}. (${details})`, wait);
}

export async function searchWeb(input: SearchInput, trace: Trace, overrides: Partial<SearchDeps> = {}): Promise<SearchOutcome> {
  const deps = { ...defaults(), ...overrides };
  const started = Date.now();

  const text = (input.query ?? '').replace(/\s+/g, ' ').trim();
  if (text === '') throw new ScrapyError('bad_input', 'No search question was given.');
  if (text.length > 500) throw new ScrapyError('bad_input', 'The search question is too long (more than 500 characters). Use a shorter question.');
  const count = Math.min(SEARCH.maxCount, Math.max(1, Math.round(input.count ?? SEARCH.defaultCount)));
  const includeSites = sites(input.includeSites);
  const excludeSites = sites(input.excludeSites);
  const recency = input.recency;

  const cacheKey = keyOf('search', { text: text.toLowerCase(), count, includeSites, excludeSites, recency: recency ?? null });
  /** The names of the engines whose answers are in an outcome, for the trace. */
  const answeredBy = (engines: SearchOutcome['engines']): string[] => engines.filter((e) => e.ok).map((e) => deps.engines.find((known) => known.id === e.id)?.name ?? e.id);

  const remembered = await deps.store.get<SearchOutcome>(cacheKey);
  if (remembered) {
    trace.cache = 'hit';
    trace.via(answeredBy(remembered.engines), false);
    return { ...remembered, cached: true, tookMs: Date.now() - started };
  }
  trace.cache = 'miss';

  // Which engines, in which order.
  const rank = (id: string): number => {
    const at = deps.order.indexOf(id);
    return at === -1 ? deps.order.length : at;
  };
  let candidates = deps.engines.filter((e) => !deps.off.has(e.id)).sort((a, b) => rank(a.id) - rank(b.id));
  // With a site filter, engines that can apply it themselves go first.
  if (includeSites.length > 0) candidates = [...candidates.filter((e) => e.siteFilter), ...candidates.filter((e) => !e.siteFilter)];

  const available: SearchEngine[] = [];
  const resting: { id: string; sec: number }[] = [];
  for (const engine of candidates) {
    const sec = await deps.health.resting(`${engine.id}:search`);
    if (sec > 0) resting.push({ id: engine.id, sec });
    else available.push(engine);
  }
  for (const r of resting) trace.step(`${r.id} search`, false, 0, `resting, back ${waitText(r.sec)}`);

  // Each engine is asked for 10 (or 20 for a long list): merging and filtering remove some.
  // Not more, because some helpers charge their free allowance by the number of results.
  const query: SearchQuery = { query: text, count: count <= 10 ? 10 : 20, includeSites, excludeSites, ...(recency ? { recency } : {}) };
  const mergeOptions = { count, perSite: SEARCH.perSite, junk: deps.junk, includeSites, excludeSites, snippetOrder: SNIPPET_ORDER, ...(recency ? { recency } : {}) };

  const runs: EngineRun[] = [];
  let merged = mergeHits([], mergeOptions);
  for (let from = 0; from < available.length; from += 2) {
    runs.push(...(await runBatch(available.slice(from, from + 2), query, trace, deps.health)));
    const lists: EngineHits[] = runs.filter((r) => r.ok).map((r) => ({ engine: r.id, hits: r.hits }));
    merged = mergeHits(lists, mergeOptions);
    if (merged.results.length >= Math.min(count, SEARCH.enoughResults)) break;
  }

  if (!runs.some((r) => r.ok)) throw explain(runs, resting);

  const outcome: SearchOutcome = {
    query: text,
    results: merged.results,
    stats: merged.stats,
    engines: runs.map(({ id, ok, ms, results, note }) => ({ id, ok, ms, results, note })),
    cached: false,
    tookMs: Date.now() - started,
  };
  trace.via(answeredBy(outcome.engines), false);
  // An empty answer is remembered only briefly: it may be a passing problem.
  await deps.store.set(cacheKey, outcome, outcome.results.length > 0 ? SEARCH.cacheSec : 60);
  return outcome;
}
