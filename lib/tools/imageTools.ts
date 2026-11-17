/** Image tools: public page screenshots, image discovery, and one-image retrieval. */
import { parseHTML } from 'linkedom';
import { ScrapyError } from '../errors';
import { checkPublicUrl, resolvePublicHost } from '../guard';
import { httpCall, HttpFailure } from '../http';
import { loadPage, type LoadDeps } from '../page/load';
import { IMAGE_HELPER_HOSTS } from '../providers/image';
import type { Trace } from '../trace';
import type { ToolOutput } from './output';

const [SCREENSHOT_HOST, IMAGE_PROXY_HOST] = IMAGE_HELPER_HOSTS as [string, string];
const IMAGE_LIMIT = 2_500_000;
const SCREENSHOT_TIMEOUT_MS = 25_000;
const IMAGE_TIMEOUT_MS = 15_000;
const MIME_OK = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

type ImageHit = { url: string; alt?: string; width?: string; height?: string };

function titleText(value: string): string {
  return value.replace(/[<>\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
}

function publicLink(raw: string, base: URL): string | null {
  try {
    const url = checkPublicUrl(new URL(raw.trim(), base).href);
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

function srcsetUrls(value: string, base: URL): string[] {
  return value
    .split(',')
    .map((part) => part.trim().split(/\s+/)[0] ?? '')
    .filter(Boolean)
    .map((raw) => publicLink(raw, base))
    .filter((url): url is string => url !== null);
}

export function imagesInPage(html: string, pageUrl: string): ImageHit[] {
  const document = parseHTML(html).document;
  const base = new URL(pageUrl);
  const all: ImageHit[] = [];
  const add = (raw: string | null | undefined, extras: Omit<ImageHit, 'url'> = {}): void => {
    if (!raw?.trim()) return;
    const url = publicLink(raw, base);
    if (url) all.push({ url, ...extras });
  };
  for (const img of document.querySelectorAll('img')) {
    const alt = titleText(img.getAttribute('alt') ?? '') || undefined;
    const width = img.getAttribute('width')?.match(/^\d+$/)?.[0];
    const height = img.getAttribute('height')?.match(/^\d+$/)?.[0];
    const extras = { ...(alt ? { alt } : {}), ...(width ? { width } : {}), ...(height ? { height } : {}) };
    for (const attr of ['src', 'data-src', 'data-original', 'data-lazy-src', 'data-url']) add(img.getAttribute(attr), extras);
    for (const url of srcsetUrls(img.getAttribute('srcset') ?? '', base)) all.push({ url, ...extras });
  }
  for (const source of document.querySelectorAll('picture source[srcset], source[srcset]')) {
    for (const url of srcsetUrls(source.getAttribute('srcset') ?? '', base)) add(url);
  }
  for (const meta of document.querySelectorAll('meta[property="og:image"], meta[name="twitter:image"]')) add(meta.getAttribute('content'));

  const unique = new Map<string, ImageHit>();
  for (const hit of all) {
    if (!unique.has(hit.url)) unique.set(hit.url, hit);
    if (unique.size >= 100) break;
  }
  return [...unique.values()];
}

async function callImageHelper(trace: Trace, request: Parameters<typeof httpCall>[1], helperName: string) {
  try {
    return await httpCall(trace, request);
  } catch (err) {
    if (err instanceof HttpFailure && err.kind === 'timeout') {
      throw new ScrapyError('too_slow', `Took too long: the ${helperName} did not answer in time. Try again once.`);
    }
    if (err instanceof HttpFailure) {
      if (helperName === 'screenshot helper') throw new ScrapyError('failed', 'The screenshot helper could not be reached. Try again later.');
      throw new ScrapyError('failed', 'The image proxy could not be reached. Try again later.');
    }
    throw err;
  }
}

function dimensions(bytes: Uint8Array, mimeType: string): string | undefined {
  if (mimeType === 'image/png' && bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return `${view.getUint32(16)} × ${view.getUint32(20)}`;
  }
  if (mimeType === 'image/gif' && bytes.length >= 10) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return `${view.getUint16(6, true)} × ${view.getUint16(8, true)}`;
  }
  if (mimeType === 'image/jpeg') {
    for (let i = 2; i + 9 < bytes.length; ) {
      if (bytes[i] !== 0xff) { i++; continue; }
      const marker = bytes[i + 1] ?? 0;
      const size = ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0);
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && size >= 7) {
        return `${((bytes[i + 7] ?? 0) << 8) | (bytes[i + 8] ?? 0)} × ${((bytes[i + 5] ?? 0) << 8) | (bytes[i + 6] ?? 0)}`;
      }
      if (size < 2) break;
      i += size + 2;
    }
  }
  return undefined;
}

async function getImageThroughProxy(imageUrl: URL, trace: Trace): Promise<{ bytes: Uint8Array; mimeType: string }> {
  await resolvePublicHost(imageUrl.hostname);
  const query = new URLSearchParams({ url: `${imageUrl.host}${imageUrl.pathname}${imageUrl.search}` });
  const result = await callImageHelper(trace, {
    url: `https://${IMAGE_PROXY_HOST}/?${query.toString()}`,
    headers: { Accept: 'image/png,image/jpeg,image/webp,image/gif' },
    timeoutMs: IMAGE_TIMEOUT_MS,
    maxBytes: IMAGE_LIMIT,
    responseType: 'bytes',
    purpose: 'image proxy: fetch public image',
  }, 'image proxy');
  if (result.status === 404 || result.status === 410) throw new ScrapyError('not_found', `Not found: the image helper could not find that image (it answered ${result.status}).`);
  if (result.status === 401 || result.status === 403 || result.status === 429) throw new ScrapyError('blocked', `Blocked by the image helper: it refused this image (it answered ${result.status}).`);
  if (result.status < 200 || result.status >= 300) throw new ScrapyError('failed', `The image helper answered ${result.status}; try again later.`);
  const mimeType = (result.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (!MIME_OK.has(mimeType) || !result.bytes?.length) throw new ScrapyError('not_a_page', 'This link did not return a supported image (PNG, JPEG, WebP or GIF).');
  return { bytes: result.bytes, mimeType };
}

export async function imageShot(args: { url: string }, trace: Trace): Promise<ToolOutput> {
  const target = checkPublicUrl(args.url);
  await resolvePublicHost(target.hostname);
  // Keep the requested page URL in the path (the screenshot helper's public API),
  // but never expose its query string in Scrapy's trace or live feed.
  const safeTarget = `${target.origin}${target.pathname}${target.search.replace(/\?/g, '%3F')}`;
  const result = await callImageHelper(trace, {
    url: `https://${SCREENSHOT_HOST}/get/width/1280/crop/1000/noanimate/${safeTarget}`,
    headers: { Accept: 'image/png,image/jpeg,image/webp' },
    timeoutMs: SCREENSHOT_TIMEOUT_MS,
    maxBytes: IMAGE_LIMIT,
    responseType: 'bytes',
    purpose: 'page screenshot helper',
    traceAddress: `https://${SCREENSHOT_HOST}/get/width/1280/crop/1000/noanimate/[public page]`,
  }, 'screenshot helper');
  if (result.status === 404 || result.status === 410) throw new ScrapyError('not_found', `Not found: the screenshot helper could not open that page (it answered ${result.status}).`);
  if (result.status === 401 || result.status === 403 || result.status === 429) throw new ScrapyError('blocked', `Blocked by the screenshot helper: it could not capture that page (it answered ${result.status}).`);
  if (result.status < 200 || result.status >= 300) throw new ScrapyError('failed', `The screenshot helper answered ${result.status}; try again later.`);
  const mimeType = (result.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (!MIME_OK.has(mimeType) || !result.bytes?.length) throw new ScrapyError('failed', 'The screenshot helper did not return an image. The page may be unavailable or unsupported.');
  return {
    text: `Screenshot of ${target.origin}${target.pathname} (attached as ${mimeType}, 1280 pixels wide).`,
    images: [{ data: Buffer.from(result.bytes).toString('base64'), mimeType }],
  };
}

export async function extractImages(args: { url: string }, trace: Trace, deps: Partial<LoadDeps> = {}): Promise<string> {
  const { doc } = await loadPage({ url: args.url, format: 'html' }, trace, deps);
  const hits = imagesInPage(doc.content, doc.finalUrl);
  if (hits.length === 0) return `No images found in the readable content of ${doc.finalUrl}.`;
  const lines = [`Found ${hits.length} images in ${doc.finalUrl}${hits.length === 100 ? ' (list capped at 100)' : ''}.`, ''];
  for (const [index, hit] of hits.entries()) {
    lines.push(`${index + 1}. ${hit.url}`);
    lines.push(`   Alt: ${hit.alt ?? 'not provided'}`);
    lines.push(`   Size: ${hit.width && hit.height ? `${hit.width} × ${hit.height}` : 'not provided'}`);
  }
  lines.push('', 'Use extract_image_url with one image_url to receive the image itself.');
  return lines.join('\n');
}

export async function extractImage(args: { image_url: string }, trace: Trace): Promise<ToolOutput> {
  const target = checkPublicUrl(args.image_url);
  const { bytes, mimeType } = await getImageThroughProxy(target, trace);
  const size = dimensions(bytes, mimeType);
  return {
    text: `Image from ${target.origin}${target.pathname} (attached as ${mimeType}${size ? `, ${size} pixels` : ''}, ${bytes.byteLength.toLocaleString('en-US')} bytes).`,
    images: [{ data: Buffer.from(bytes).toString('base64'), mimeType }],
  };
}

