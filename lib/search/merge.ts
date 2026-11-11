/**
 * Merges the result lists of several search engines into one.
 *
 * - The same page found by two engines appears once, and is ranked first.
 * - Results from the junk-site list are removed.
 * - No more than a few results come from one site.
 *
 * Fixed rules only, so the same input always gives the same output.
 */
import { clip } from '../errors';
import { bareDomain } from '../providers/shared';
import type { RawHit, Recency } from '../providers/types';

const TRACKING = /^(utm_\w+|gclid|gbraid|wbraid|fbclid|msclkid|yclid|dclid|mc_cid|mc_eid|igshid|_hsenc|_hsmi|srsltid|spm|ref_src|ref_url|trk|trkCampaign)$/i;

export interface Canonical {
  /** Two links with the same key are the same page. */
  key: string;
  /** The link, tidied, as it will be shown. */
  url: string;
  host: string;
}

export function canonical(rawUrl: string): Canonical | null {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  for (const name of [...url.searchParams.keys()]) if (TRACKING.test(name)) url.searchParams.delete(name);
  url.hash = '';
  const shown = url.href;

  const host = url.hostname.toLowerCase();
  let keyHost = host.replace(/^www\./, '');
  // m.example.com and example.com show the same page. Wikipedia writes it as en.m.wikipedia.org.
  if (/^(m|mobile|amp)\.[^.]+\.[^.]+/.test(keyHost)) keyHost = keyHost.replace(/^(m|mobile|amp)\./, '');
  keyHost = keyHost.replace(/\.m\.(wikipedia|wiktionary|wikibooks)\.org$/, '.$1.org');
  let path = url.pathname.replace(/\/+$/, '');
  path = path.replace(/\/index\.(html?|php)$/i, '');
  const params = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  const query = params.map(([k, v]) => `${k}=${v}`).join('&');
  return { key: `${keyHost}${path}${query ? `?${query}` : ''}`.toLowerCase(), url: shown, host };
}

const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac', 'or', 'ne', 'go', 'gob', 'nom', 'mil']);

/** Places where every sub-site belongs to somebody else. */
const SHARED_HOSTS = new Set([
  'github.io',
  'gitlab.io',
  'vercel.app',
  'netlify.app',
  'pages.dev',
  'web.app',
  'firebaseapp.com',
  'herokuapp.com',
  'blogspot.com',
  'wordpress.com',
  'substack.com',
  'readthedocs.io',
  'readthedocs.org',
  'gitbook.io',
  'notion.site',
  'webflow.io',
  'framer.website',
  'hashnode.dev',
  'medium.com',
  'tumblr.com',
]);

/** The site a host belongs to: "docs.example.com" and "www.example.com" are both "example.com". */
export function siteOf(host: string): string {
  const labels = host.toLowerCase().replace(/^www\./, '').split('.');
  if (labels.length <= 2) return labels.join('.');
  const lastTwo = labels.slice(-2).join('.');
  if (SHARED_HOSTS.has(lastTwo)) return labels.slice(-3).join('.');
  const [second = '', last = ''] = labels.slice(-2);
  if (last.length === 2 && SECOND_LEVEL.has(second)) return labels.slice(-3).join('.');
  return lastTwo;
}

function junkPattern(entry: string): RegExp {
  const escaped = entry
    .trim()
    .toLowerCase()
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^(?:.*\\.)?${escaped}$`);
}

export function junkMatcher(list: string[]): (host: string) => boolean {
  const patterns = list.filter((e) => e.trim() !== '').map(junkPattern);
  return (host) => {
    const h = host.toLowerCase();
    return patterns.some((p) => p.test(h));
  };
}

export function hostMatchesSite(host: string, site: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, '');
  const s = bareDomain(site);
  return s !== '' && (h === s || h.endsWith(`.${s}`));
}

/** A description as one short line of plain text. */
export function tidySnippet(text: string, max = 300): string {
  const plain = text
    .replace(/[\u200b\u200c\u200d\ufeff\u00ad]/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#*_`>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain.length <= max) return plain;
  const cut = plain.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${cut.slice(0, space > max * 0.6 ? space : max).trimEnd()}…`;
}

/**
 * The description to show for a page. Engines describe pages differently well,
 * so the caller gives an order of preference. A description too short to say
 * anything is passed over.
 */
function bestSnippet(snippets: { engine: string; text: string }[], order: readonly string[]): string {
  const rank = (engine: string): number => {
    const at = order.indexOf(engine);
    return at === -1 ? order.length : at;
  };
  const tidied = snippets.map((s) => ({ rank: rank(s.engine), text: tidySnippet(s.text) })).filter((s) => s.text !== '');
  // sort() keeps the engines' own order among equals.
  tidied.sort((a, b) => a.rank - b.rank);
  return (tidied.find((s) => s.text.length >= 50) ?? tidied.sort((a, b) => b.text.length - a.text.length)[0])?.text ?? '';
}

/** A date as YYYY-MM-DD, or undefined when the text is not a date. */
export function tidyDate(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const t = Date.parse(text);
  if (!Number.isFinite(t)) return undefined;
  const year = new Date(t).getUTCFullYear();
  if (year < 1995 || year > new Date().getUTCFullYear() + 1) return undefined;
  return new Date(t).toISOString().slice(0, 10);
}

const WINDOW_DAYS: Record<Recency, number> = { day: 2, week: 9, month: 35, year: 380 };

export interface EngineHits {
  engine: string;
  hits: RawHit[];
}

export interface SearchResult {
  rank: number;
  url: string;
  title: string;
  snippet: string;
  site: string;
  published?: string;
  /** Which engines found this page. */
  foundBy: string[];
}

export interface MergeStats {
  /** Results the engines returned, before any merging. */
  found: number;
  duplicates: number;
  junk: number;
  /** Removed because of the caller's own site or date filter. */
  filtered: number;
  /** Removed because their site already had its share. */
  overPerSite: number;
}

export interface MergeOptions {
  count: number;
  perSite: number;
  junk: string[];
  includeSites?: string[];
  excludeSites?: string[];
  recency?: Recency;
  now?: number;
  /** Engine ids, best describer first. The description of the first engine on this list that found the page is shown. */
  snippetOrder?: readonly string[];
}

/**
 * Ranking: every engine gives a page 1 / (60 + its position). The points are
 * added up. A page found by two engines therefore always ranks above a page
 * found by one, and among equals the better positions win.
 */
const RANK_K = 60;

interface Merged {
  key: string;
  url: string;
  host: string;
  score: number;
  titles: string[];
  snippets: { engine: string; text: string }[];
  published?: string;
  engines: string[];
  firstSeen: number;
}

export function mergeHits(lists: EngineHits[], opts: MergeOptions): { results: SearchResult[]; stats: MergeStats } {
  const stats: MergeStats = { found: 0, duplicates: 0, junk: 0, filtered: 0, overPerSite: 0 };
  const isJunk = junkMatcher(opts.junk);
  const include = (opts.includeSites ?? []).filter(Boolean);
  const exclude = (opts.excludeSites ?? []).filter(Boolean);
  const oldest = opts.recency ? (opts.now ?? Date.now()) - WINDOW_DAYS[opts.recency] * 86_400_000 : null;

  const byKey = new Map<string, Merged>();
  let seen = 0;

  for (const { engine, hits } of lists) {
    const inThisList = new Set<string>();
    let position = 0;
    for (const hit of hits) {
      stats.found++;
      const c = canonical(hit.url);
      if (!c) {
        stats.filtered++;
        continue;
      }
      if (inThisList.has(c.key)) {
        stats.duplicates++;
        continue;
      }
      inThisList.add(c.key);
      position++;

      let entry = byKey.get(c.key);
      if (!entry) {
        entry = { key: c.key, url: c.url, host: c.host, score: 0, titles: [], snippets: [], engines: [], firstSeen: seen++ };
        byKey.set(c.key, entry);
      } else {
        stats.duplicates++;
        // Prefer the https form of a link.
        if (entry.url.startsWith('http:') && c.url.startsWith('https:')) entry.url = c.url;
      }
      entry.score += 1 / (RANK_K + position);
      entry.engines.push(engine);
      if (hit.title.trim() !== '') entry.titles.push(hit.title.replace(/\s+/g, ' ').trim());
      if (hit.snippet.trim() !== '') entry.snippets.push({ engine, text: hit.snippet });
      entry.published ??= tidyDate(hit.published);
    }
  }

  const ranked = [...byKey.values()].sort((a, b) => b.score - a.score || a.firstSeen - b.firstSeen);

  const results: SearchResult[] = [];
  const perSite = new Map<string, number>();
  for (const entry of ranked) {
    if (isJunk(entry.host)) {
      stats.junk++;
      continue;
    }
    if (include.length > 0 && !include.some((s) => hostMatchesSite(entry.host, s))) {
      stats.filtered++;
      continue;
    }
    if (exclude.some((s) => hostMatchesSite(entry.host, s))) {
      stats.filtered++;
      continue;
    }
    if (oldest !== null && entry.published && Date.parse(entry.published) < oldest) {
      stats.filtered++;
      continue;
    }
    const site = siteOf(entry.host);
    // When the caller named the sites, asking for many results from one of them is the point.
    if (include.length === 0) {
      const used = perSite.get(site) ?? 0;
      if (used >= opts.perSite) {
        stats.overPerSite++;
        continue;
      }
      perSite.set(site, used + 1);
    }
    if (results.length >= opts.count) continue;

    results.push({
      rank: results.length + 1,
      url: entry.url,
      title: clip(entry.titles[0] ?? entry.host, 160),
      snippet: bestSnippet(entry.snippets, opts.snippetOrder ?? []),
      site,
      ...(entry.published ? { published: entry.published } : {}),
      foundBy: [...new Set(entry.engines)],
    });
  }
  return { results, stats };
}
