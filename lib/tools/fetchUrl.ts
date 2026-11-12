/** The fetch_url tool: one page in, its main content out, as text an AI can read. */
import { PAGE } from '../config';
import { ScrapyError } from '../errors';
import { applyFocus } from '../page/focus';
import { loadPage, type LoadDeps } from '../page/load';
import { splitParts } from '../page/parts';
import { tidyDate } from '../search/merge';
import type { Trace } from '../trace';

export interface FetchArgs {
  url: string;
  format?: 'markdown' | 'html' | undefined;
  focus?: string | undefined;
  part?: number | undefined;
  browser?: boolean | undefined;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

export async function fetchUrl(args: FetchArgs, trace: Trace, deps: Partial<LoadDeps> = {}): Promise<string> {
  const { doc, cached } = await loadPage({ url: args.url, ...(args.format ? { format: args.format } : {}), browser: args.browser === true }, trace, deps);

  const head: string[] = [`Title: ${doc.title}`, `URL: ${doc.finalUrl}`];
  const published = tidyDate(doc.published);
  if (published) head.push(`Published: ${published}`);
  head.push(cached ? `Loaded: from Scrapy's 15-minute memory (first loaded by ${doc.wayName})` : `Loaded: by ${doc.wayName} in ${seconds(doc.loadMs)}`);

  let content = doc.content;
  const focus = (args.focus ?? '').replace(/\s+/g, ' ').trim();
  if (focus !== '') {
    if (doc.format === 'markdown') {
      const focused = applyFocus(content, focus);
      content = focused.text;
      head.push(
        focused.matched
          ? `Focus: "${focus}" (${focused.kept} of ${focused.total} sections kept; call again without focus for the whole page)`
          : `Focus: "${focus}" (no section matched)`,
      );
    } else {
      head.push('Focus: only works with the Markdown format, so the whole page is returned.');
    }
  }

  const parts = splitParts(content, PAGE.partChars);
  const part = Math.round(args.part ?? 1);
  if (part < 1 || part > parts.length) {
    throw new ScrapyError('bad_input', parts.length === 1 ? `This page has only one part. Call fetch_url without "part".` : `This page has ${parts.length} parts. "part" must be between 1 and ${parts.length}.`);
  }
  if (parts.length > 1) {
    head.push(part < parts.length ? `Part: ${part} of ${parts.length} (call fetch_url again with part: ${part + 1} for the next part)` : `Part: ${part} of ${parts.length} (the last part)`);
  }
  for (const note of doc.notes) head.push(`Note: ${note}`);

  return `${head.join('\n')}\n\n---\n\n${parts[part - 1] ?? ''}`;
}
