/**
 * What every helper has to look like. Each helper lives in one file in this
 * folder, so it can be swapped or dropped without touching the tools.
 */
import type { Trace } from '../trace';

export type Recency = 'day' | 'week' | 'month' | 'year';

export interface SearchQuery {
  query: string;
  /** How many results to ask this engine for. */
  count: number;
  includeSites: string[];
  excludeSites: string[];
  recency?: Recency;
}

export interface RawHit {
  url: string;
  title: string;
  snippet: string;
  /** Publication date as the engine gave it. */
  published?: string;
}

export interface CallOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface SearchEngine {
  id: string;
  name: string;
  /** Every host this engine's code contacts. */
  hosts: string[];
  /** Whether the engine itself can limit a search to given sites. */
  siteFilter: boolean;
  search(query: SearchQuery, trace: Trace, opts: CallOptions): Promise<RawHit[]>;
}

export type PageFormat = 'markdown' | 'html';

export interface PageQuery {
  url: string;
  format: PageFormat;
  /** The caller asked for a real browser. */
  browser: boolean;
}

/** A page as a helper returned it. One of markdown, html or rawHtml is set. */
export interface RawPage {
  finalUrl?: string;
  title?: string;
  description?: string;
  language?: string;
  published?: string;
  markdown?: string;
  /** HTML that the helper already cut down to the main content. */
  html?: string;
  /** The whole page. Scrapy cleans it itself. */
  rawHtml?: string;
  /** The page's own HTTP status, when the helper reports it. */
  status?: number;
}

export interface PageWay {
  id: string;
  name: string;
  hosts: string[];
  formats: PageFormat[];
  /** Reads pages in a real browser, so pages built by JavaScript work. */
  browser: boolean;
  /** True only for Scrapy's own download. Never used in the safe position. */
  own: boolean;
  load(query: PageQuery, trace: Trace, opts: CallOptions): Promise<RawPage>;
}
