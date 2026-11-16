/** A bounded, breadth-first crawl that reuses the same safe page loader as fetch_url. */
import { PAGE } from '../config';
import { ScrapyError } from '../errors';
import { checkPublicUrl } from '../guard';
import { loadPage, type LoadDeps } from '../page/load';
import { plainText } from '../page/markdown';
import type { Trace } from '../trace';

export interface DeepFetchArgs {
  url: string;
  max_pages?: number;
  same_domain_only?: boolean;
}

function linksFrom(html: string, base: URL): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi)) {
    const raw = (match[1] ?? match[2] ?? match[3] ?? '').replace(/&amp;/g, '&').trim();
    if (!raw || raw.startsWith('#')) continue;
    try {
      const url = checkPublicUrl(new URL(raw, base).href);
      url.hash = '';
      if (!seen.has(url.href)) { seen.add(url.href); out.push(url.href); }
    } catch {
      // Ignore links that are not public HTTP(S) pages.
    }
  }
  return out;
}

export async function webDeepFetch(args: DeepFetchArgs, trace: Trace, deps: Partial<LoadDeps> = {}): Promise<string> {
  const start = checkPublicUrl(args.url);
  const maxPages = Math.min(100, Math.max(1, Math.round(args.max_pages ?? 10)));
  const sameDomain = args.same_domain_only !== false;
  const queue = [start.href];
  const queued = new Set(queue);
  const visited = new Set<string>();
  const found: { url: string; title: string; links: string[]; preview: string }[] = [];
  const failed: { url: string; message: string }[] = [];
  const deadline = Date.now() + 47_000;
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < queue.length && visited.size < maxPages && Date.now() < deadline) {
      const url = queue[cursor++];
      if (!url || visited.has(url)) continue;
      visited.add(url);
      try {
        const remaining = deadline - Date.now();
        if (remaining < 250) break;
        const { doc } = await loadPage({ url, format: 'html' }, trace, { ...deps,
          budgetMs: Math.min(9_000, remaining),
          wayTimeoutMs: Math.min(7_000, remaining),
          hedgeAfterMs: Math.min(2_000, remaining),
        });
        const final = new URL(doc.finalUrl);
        if (sameDomain && final.hostname.toLowerCase() !== start.hostname.toLowerCase()) {
          failed.push({ url, message: 'the page redirected off the starting host' });
          continue;
        }
        const links = linksFrom(doc.content, final);
        const preview = plainText(doc.content).slice(0, 900);
        found.push({ url: doc.finalUrl, title: doc.title || doc.finalUrl, links, preview });
        for (const link of links) {
          if (queued.has(link)) continue;
          const parsed = new URL(link);
          if (sameDomain && parsed.hostname.toLowerCase() !== start.hostname.toLowerCase()) continue;
          if (queued.size >= maxPages * 40) continue;
          queued.add(link);
          queue.push(link);
        }
      } catch (err) {
        failed.push({ url, message: err instanceof Error ? err.message : 'Could not read this page.' });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(4, maxPages) }, () => worker()));
  if (found.length === 0 && failed.length > 0) throw new ScrapyError('failed', `Could not crawl this site: ${failed[0]?.message ?? 'no page could be read.'}`);
  const lines = [`Crawled ${found.length} ${found.length === 1 ? 'page' : 'pages'} from ${start.origin}${sameDomain ? ' (same domain only)' : ''}.`];
  if (Date.now() >= deadline) lines.push('Stopped at the 47-second time limit.');
  lines.push('');
  for (const [index, page] of found.entries()) lines.push(`${index + 1}. ${page.title}\n   ${page.url}\n   ${page.links.length} links found\n   ${page.preview}${page.preview.length >= 900 ? '… [excerpt clipped; call fetch_url for the full page]' : ''}`);
  if (failed.length) lines.push('', `Could not read ${failed.length} ${failed.length === 1 ? 'page' : 'pages'}:`, ...failed.slice(0, 10).map(({ url, message }) => `- ${url}: ${message}`));
  if (queue.length > found.length + failed.length) lines.push('', `Stopped at the ${maxPages}-page limit. There were more links to visit.`);
  return lines.join('\n');
}
