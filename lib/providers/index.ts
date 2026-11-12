/**
 * The list of helpers. To drop one, remove it here. To add one, write a file
 * like the others in this folder and add it here.
 */
import { exaPage, exaSearch } from './exa';
import { firecrawlPage, firecrawlSearch } from './firecrawl';
import { jinaPage } from './jina';
import { ownPage } from './own';
import { parallelPage, parallelSearch } from './parallel';
import { tavilyPage, tavilySearch } from './tavily';
import type { PageWay, SearchEngine } from './types';

export const SEARCH_ENGINES: SearchEngine[] = [tavilySearch, firecrawlSearch, exaSearch, parallelSearch];

/** The free helper services that can load a page. */
export const PAGE_HELPERS: PageWay[] = [jinaPage, firecrawlPage, tavilyPage, parallelPage, exaPage];

/** Scrapy's own download. Not a helper: it contacts the page's site itself. */
export const OWN_DOWNLOAD: PageWay = ownPage;

/** Every host a helper may contact. In the safe position Scrapy contacts nothing else. */
export const HELPER_HOSTS: string[] = [...new Set([...SEARCH_ENGINES, ...PAGE_HELPERS].flatMap((h) => h.hosts))].sort();

export type { PageWay, SearchEngine } from './types';
