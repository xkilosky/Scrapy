/**
 * Turns a raw web page into its main content.
 *
 * In: the page's full HTML. Out: the title, the main content as tidy HTML and
 * as Markdown. Menus, ads, cookie banners, pop-ups, scripts and styles are
 * gone. Everything here is fixed rules. No AI is involved, so the same page
 * always gives the same result.
 */
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { tidyMarkdown } from './markdown';

export interface Cleaned {
  title: string;
  description?: string;
  language?: string;
  published?: string;
  /** The main content as tidy HTML: no scripts, styles, classes or ids. */
  html: string;
  /** The main content as Markdown. */
  markdown: string;
  /** "article": one main article was found. "whole-page": the page has several sections, all kept. */
  method: 'article' | 'whole-page';
}

// --- Parsing -----------------------------------------------------------------

function parse(html: string): Document {
  const source = /<html[\s>]/i.test(html) ? html : `<!doctype html><html><head></head><body>${html}</body></html>`;
  return (parseHTML(source) as unknown as { document: Document }).document;
}

function textLength(el: Element | null | undefined): number {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim().length;
}

function meta(document: Document, ...names: string[]): string | undefined {
  for (const name of names) {
    const el = document.querySelector(`meta[property="${name}"], meta[name="${name}"], meta[itemprop="${name}"]`);
    const value = el?.getAttribute('content')?.trim();
    if (value) return value;
  }
  return undefined;
}

// --- Junk --------------------------------------------------------------------

/** Never content, whatever the page. */
const ALWAYS = 'script, style, noscript, template, link, meta, object, embed, canvas, svg, dialog';

/** Hidden things and pop-ups. */
const HIDDEN = '[hidden], [aria-hidden="true"], [aria-modal="true"], [role="dialog"], [role="alertdialog"]';

/** Well-known cookie banners, ad slots, share bars and sign-up boxes, by the names their makers give them. */
const KNOWN_JUNK = [
  '#onetrust-consent-sdk',
  '#onetrust-banner-sdk',
  '#CybotCookiebotDialog',
  '#CybotCookiebotDialogBodyUnderlay',
  '#cookie-law-info-bar',
  '.cc-window',
  '.cc-banner',
  '#didomi-host',
  '.didomi-popup-container',
  '.osano-cm-window',
  '#usercentrics-root',
  '.fc-consent-root',
  '#cmpbox',
  '#cmpwrapper',
  '.qc-cmp2-container',
  '#truste-consent-track',
  '.truste_box_overlay',
  '.cky-consent-container',
  '.cky-overlay',
  '.iubenda-cs-container',
  '#iubenda-cs-banner',
  '.klaro',
  '#cookiescript_injected',
  '.cookieconsent',
  '#cookie-notice',
  '#cookieConsent',
  '.gdpr-banner',
  'ins.adsbygoogle',
  '[id^="google_ads_"]',
  '[id^="div-gpt-ad"]',
  '.OUTBRAIN',
  '[id^="taboola-"]',
  '.taboola',
  '[data-ad-slot]',
  '[data-ad-unit]',
  'amp-ad',
  '.sharedaddy',
  '.addtoany_share_save_container',
  '.a2a_kit',
  '.addthis_toolbox',
  '#mc_embed_signup',
].join(', ');

const COOKIE = new Set(['cookie', 'cookies', 'consent', 'gdpr', 'ccpa', 'cmp', 'cookiebot', 'onetrust', 'didomi', 'osano', 'usercentrics', 'cookieyes']);
const AD = new Set(['ad', 'ads', 'advert', 'adverts', 'advertisement', 'advertising', 'adsbygoogle', 'adbox', 'adslot', 'adunit', 'adzone', 'adwrap', 'adcontainer', 'sponsored', 'dfp']);
const POPUP = new Set(['popup', 'popups', 'modal', 'lightbox', 'interstitial', 'overlay']);
const NEWSLETTER = new Set(['newsletter', 'subscribe', 'subscription', 'signup', 'optin', 'mailchimp']);
const SHARE = new Set(['share', 'sharing', 'sharer']);
/** "social" alone can be a real section ("social proof"). Together with one of these it is a bar of icons. */
const SOCIAL_BAR = new Set(['share', 'links', 'link', 'icons', 'icon', 'buttons', 'button', 'media', 'follow', 'bar', 'list', 'nav']);

/** Only boxes are judged by their name. A heading or a paragraph called "cookies" is content. */
const BOX_TAGS = new Set(['DIV', 'SECTION', 'ASIDE', 'FORM', 'INS']);

const VIDEO_HOSTS = /(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be|vimeo\.com|loom\.com|wistia\.com|wistia\.net|dailymotion\.com)$/;

function nameTokens(el: Element): string[] {
  const raw = `${el.getAttribute('id') ?? ''} ${el.getAttribute('class') ?? ''}`;
  if (raw.trim() === '') return [];
  return raw
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function looksLikeJunk(el: Element): boolean {
  const tokens = nameTokens(el);
  if (tokens.length === 0) return false;
  const has = (set: Set<string>): boolean => tokens.some((t) => set.has(t));
  const length = textLength(el);
  if (has(COOKIE) && length < 2_000 && el.querySelector('button, a, input') !== null) return true;
  if (has(AD) && length < 1_500) return true;
  if (has(POPUP) && length < 2_500) return true;
  if (has(NEWSLETTER) && length < 1_200 && el.querySelector('input, button, form') !== null) return true;
  if ((has(SHARE) || (tokens.includes('social') && has(SOCIAL_BAR))) && length < 300) return true;
  return false;
}

/**
 * Removes junk from the page, in place. An element that holds a large share of
 * the page's text is never removed: a wrapper with a misleading name, or a page
 * marked "hidden" behind an open pop-up, must not take the content with it.
 */
function removeJunk(document: Document, root: Element): void {
  for (const el of [...root.querySelectorAll(ALWAYS)]) el.remove();

  for (const frame of [...root.querySelectorAll('iframe')]) {
    const src = frame.getAttribute('src') ?? '';
    let host = '';
    try {
      host = new URL(src, 'https://x.invalid').hostname;
    } catch {
      host = '';
    }
    if (VIDEO_HOSTS.test(host)) {
      const p = document.createElement('p');
      const a = document.createElement('a');
      a.setAttribute('href', src);
      a.textContent = `Video: ${frame.getAttribute('title') ?? host}`;
      p.appendChild(a);
      frame.replaceWith(p);
    } else {
      frame.remove();
    }
  }

  const total = Math.max(1, textLength(root));
  const small = (el: Element): boolean => textLength(el) <= total * 0.3;

  // An element removed together with its parent is skipped: it is no longer inside the root.
  for (const el of [...root.querySelectorAll(HIDDEN)]) if (root.contains(el) && small(el)) el.remove();
  for (const el of [...root.querySelectorAll('[style]')]) {
    if (!root.contains(el)) continue;
    if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(el.getAttribute('style') ?? '') && small(el)) el.remove();
  }
  for (const el of [...root.querySelectorAll(KNOWN_JUNK)]) if (root.contains(el) && small(el)) el.remove();
  for (const el of [...root.querySelectorAll('div, section, aside, form, ins')]) {
    if (!root.contains(el) || !BOX_TAGS.has(el.tagName.toUpperCase())) continue;
    if (looksLikeJunk(el) && small(el)) el.remove();
  }
}

// --- Links and pictures ------------------------------------------------------

function resolve(href: string, base: string): string | null {
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

function firstOfSrcset(srcset: string | null): string | null {
  if (!srcset) return null;
  const first = srcset.split(',')[0]?.trim().split(/\s+/)[0];
  return first || null;
}

/** Makes every link and picture address complete, so they still work outside the page. */
function absolutize(root: Element, base: string): void {
  for (const a of [...root.querySelectorAll('a[href]')]) {
    const href = (a.getAttribute('href') ?? '').trim();
    if (/^javascript:/i.test(href) || href === '') {
      a.removeAttribute('href');
      continue;
    }
    const full = resolve(href, base);
    if (full) a.setAttribute('href', full);
  }
  for (const img of [...root.querySelectorAll('img')]) {
    let src = (img.getAttribute('src') ?? '').trim();
    if (src === '' || src.startsWith('data:')) {
      // Many sites load pictures late and keep the real address in another attribute.
      src =
        img.getAttribute('data-src') ??
        img.getAttribute('data-lazy-src') ??
        img.getAttribute('data-original') ??
        firstOfSrcset(img.getAttribute('data-srcset')) ??
        firstOfSrcset(img.getAttribute('srcset')) ??
        '';
    }
    const full = src && !src.startsWith('data:') ? resolve(src, base) : null;
    if (full) img.setAttribute('src', full);
    else img.remove();
  }
}

// --- Finding the main content -------------------------------------------------

function linkDensity(el: Element): number {
  const all = textLength(el);
  if (all === 0) return 1;
  let inLinks = 0;
  for (const a of [...el.querySelectorAll('a')]) inLinks += textLength(a);
  return inLinks / all;
}

const NAV_NAMES = new Set(['nav', 'navbar', 'navigation', 'menu', 'sidebar', 'toc', 'breadcrumb', 'breadcrumbs', 'pagination', 'pager', 'topbar', 'masthead', 'footer']);

/**
 * Removes the parts of a page that belong to the site, not to this page: the
 * menu, the site header, the site footer and side columns. Works in place and
 * returns the element that holds the page's own content.
 */
function stripChrome(body: Element): Element {
  // A top header that is a menu goes. A top header that holds the page's headline stays.
  for (const header of [...body.querySelectorAll('header, [role="banner"]')]) {
    if (!body.contains(header) || header.closest('article, main, [role="main"], section')) continue;
    const isMenu = header.querySelector('nav, [role="navigation"]') !== null || linkDensity(header) > 0.5;
    if (isMenu && header.querySelector('h1') === null) header.remove();
  }
  for (const el of [...body.querySelectorAll('nav, [role="navigation"], [role="complementary"], [role="search"]')]) {
    if (body.contains(el)) el.remove();
  }
  // A side column goes. A note or a tip written as <aside> inside the text stays: it is content.
  for (const aside of [...body.querySelectorAll('aside')]) {
    if (!body.contains(aside)) continue;
    const insideText = aside.closest('article, main, [role="main"]') !== null;
    const named = nameTokens(aside).some((t) => NAV_NAMES.has(t) || t === 'related');
    if (!insideText || named || linkDensity(aside) > 0.5) aside.remove();
  }
  for (const footer of [...body.querySelectorAll('footer, [role="contentinfo"]')]) {
    if (body.contains(footer) && !footer.closest('article, main, [role="main"], section, blockquote')) footer.remove();
  }
  const main = body.querySelector('main, [role="main"]');
  return main && textLength(main) >= textLength(body) * 0.6 ? main : body;
}

/**
 * Older sites build their menus from plain boxes. A box that is named like a
 * menu and is nearly all links is removed, but only while most of the page's
 * text stays: a page whose content is a list of links keeps it.
 */
function pruneMenus(root: Element): void {
  const total = textLength(root);
  if (total < 400) return;
  const found: Element[] = [];
  let removedText = 0;
  for (const el of [...root.querySelectorAll('div, ul, ol, section')]) {
    if (found.some((f) => f.contains(el))) continue;
    if (!nameTokens(el).some((t) => NAV_NAMES.has(t))) continue;
    const length = textLength(el);
    if (el.querySelectorAll('a').length < 4 || length === 0 || linkDensity(el) < 0.8) continue;
    found.push(el);
    removedText += length;
  }
  if (removedText <= total * 0.4) for (const el of found) el.remove();
}

// --- Tidying the chosen content -----------------------------------------------

const KEEP_ATTRIBUTES: Record<string, string[]> = {
  A: ['href', 'title'],
  IMG: ['src', 'alt', 'title', 'width', 'height'],
  TD: ['colspan', 'rowspan'],
  TH: ['colspan', 'rowspan'],
  OL: ['start'],
  TIME: ['datetime'],
  VIDEO: ['src', 'poster'],
  AUDIO: ['src'],
  SOURCE: ['src', 'type'],
};

const CAN_BE_EMPTY = 'img, video, audio, picture, source, table, hr, br, iframe, input';

function tidy(document: Document, root: Element): void {
  for (const el of [root, ...root.querySelectorAll('*')]) {
    const tag = el.tagName.toUpperCase();
    const keep = KEEP_ATTRIBUTES[tag] ?? [];
    for (const name of el.getAttributeNames()) {
      if (keep.includes(name)) continue;
      // The class of a code block often names its language. That is worth keeping.
      if (name === 'class' && (tag === 'PRE' || tag === 'CODE') && /lang|language|highlight|brush/i.test(el.getAttribute('class') ?? '')) continue;
      el.removeAttribute(name);
    }
  }

  // A table with no header row gets its first row as header, so it can become a Markdown table.
  for (const table of [...root.querySelectorAll('table')]) {
    if (table.querySelector('th') !== null) continue;
    const firstRow = table.querySelector('tr');
    if (!firstRow) continue;
    for (const cell of [...firstRow.querySelectorAll('td')]) {
      const th = document.createElement('th');
      th.innerHTML = cell.innerHTML;
      for (const name of cell.getAttributeNames()) th.setAttribute(name, cell.getAttribute(name) ?? '');
      cell.replaceWith(th);
    }
  }

  // Empty wrappers, innermost first.
  const candidates = [...root.querySelectorAll('p, div, span, li, a, section, article, ul, ol, figure, strong, em, b, i, h1, h2, h3, h4, h5, h6')].reverse();
  for (const el of candidates) {
    if (!root.contains(el)) continue;
    if (textLength(el) === 0 && el.querySelector(CAN_BE_EMPTY) === null) el.remove();
  }
}

function serialize(root: Element): string {
  // Readability wraps its result in one or two plain boxes. They carry nothing.
  let el = root;
  while (el.children.length === 1 && el.firstElementChild?.tagName.toUpperCase() === 'DIV' && textLength(el) === textLength(el.firstElementChild)) {
    el = el.firstElementChild;
  }
  const html = el.innerHTML.replace(/<!--[\s\S]*?-->/g, '');
  // One block per line, so the HTML is easy to read. Code blocks are left exactly as they are.
  return html
    .split(/(<pre[\s>][\s\S]*?<\/pre>)/i)
    .map((piece, i) =>
      i % 2 === 1
        ? piece
        : piece
            .replace(/(<\/(?:p|h[1-6]|li|ul|ol|table|thead|tbody|tr|blockquote|div|section|article|figure|figcaption|dl|dt|dd|header|footer)>)(?!\n)/gi, '$1\n')
            .replace(/[ \t]+\n/g, '\n')
            .replace(/\n\s*\n+/g, '\n'),
    )
    .join('')
    .replace(/(<\/pre>)(?!\n)/gi, '$1\n')
    .trim();
}

// --- HTML to Markdown ----------------------------------------------------------

let turndown: TurndownService | null = null;

function converter(): TurndownService {
  if (turndown) return turndown;
  const td = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    codeBlockStyle: 'fenced',
    fence: '```',
    bulletListMarker: '-',
    emDelimiter: '*',
    strongDelimiter: '**',
    linkStyle: 'inlined',
  });
  td.use(gfm);
  td.addRule('codeBlockWithLanguage', {
    filter: (node) => node.nodeName === 'PRE',
    replacement: (_content, node) => {
      const pre = node as HTMLElement;
      const code = pre.querySelector('code');
      const names = `${pre.getAttribute('class') ?? ''} ${code?.getAttribute('class') ?? ''}`;
      const language = /(?:language|lang|highlight-source|highlight-text|brush:)[-_:\s]?([\w+#.-]+)/i.exec(names)?.[1] ?? '';
      const text = ((code ?? pre).textContent ?? '').replace(/\n+$/, '');
      const fence = text.includes('```') ? '~~~~' : '```';
      return `\n\n${fence}${language.toLowerCase()}\n${text}\n${fence}\n\n`;
    },
  });
  td.addRule('linkWithoutText', {
    filter: (node) => node.nodeName === 'A' && (node.textContent ?? '').trim() === '' && (node as HTMLElement).querySelector('img') === null,
    replacement: () => '',
  });
  td.addRule('figureCaption', {
    filter: 'figcaption',
    replacement: (content) => (content.trim() === '' ? '' : `\n\n*${content.trim()}*\n\n`),
  });
  td.remove(['script', 'style', 'noscript', 'template']);
  turndown = td;
  return td;
}

export function htmlToMarkdown(html: string): string {
  if (html.trim() === '') return '';
  return tidyMarkdown(converter().turndown(html));
}

// --- The two entry points -------------------------------------------------------

/** A whole raw page in, its main content out. */
export function cleanPage(rawHtml: string, pageUrl: string): Cleaned {
  const document = parse(rawHtml);
  const body: Element = document.body ?? document.documentElement;

  const baseHref = document.querySelector('base[href]')?.getAttribute('href');
  const base = (baseHref ? resolve(baseHref, pageUrl) : null) ?? pageUrl;

  const docTitle = (document.title ?? '').replace(/\s+/g, ' ').trim();
  const description = meta(document, 'description', 'og:description', 'twitter:description');
  const language = document.documentElement?.getAttribute('lang')?.trim() || undefined;
  const metaPublished = meta(document, 'article:published_time', 'datePublished', 'date') ?? document.querySelector('time[datetime]')?.getAttribute('datetime') ?? undefined;
  const isArticlePage =
    document.querySelector('article, [itemprop="articleBody"]') !== null || meta(document, 'og:type') === 'article';
  const topHeadings = [...document.querySelectorAll('h1')].map((h) => (h.textContent ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const firstHeading = topHeadings[0] ?? '';

  removeJunk(document, body);
  absolutize(body, base);

  // The site's own furniture goes first, so neither way of finding the content can keep it.
  const whole = stripChrome(body);

  let article: ReturnType<Readability['parse']> = null;
  try {
    article = new Readability(document.cloneNode(true) as Document, { keepClasses: true, charThreshold: 200 }).parse();
  } catch {
    article = null;
  }
  const wholeLength = textLength(whole);
  const articleLength = (article?.textContent ?? '').replace(/\s+/g, ' ').trim().length;

  // The article finder is built for pages that hold one article. On a page made
  // of several sections it keeps some and silently drops others. Losing content
  // is worse than keeping a little too much, so:
  // - on an article page its result is used unless it lost most of the text;
  // - on any other page it is used only when it kept nearly everything.
  const share = isArticlePage ? 0.25 : 0.85;
  const useArticle = article !== null && article.content != null && articleLength >= 200 && articleLength >= wholeLength * share;

  let root: Element;
  if (useArticle && article?.content) {
    const holder = parse(article.content);
    root = holder.body ?? holder.documentElement;
    // The article finder turns every top heading into a second-level one. Put them back.
    for (const h2 of [...root.querySelectorAll('h2')]) {
      if (!topHeadings.includes((h2.textContent ?? '').replace(/\s+/g, ' ').trim())) continue;
      const h1 = holder.createElement('h1');
      h1.innerHTML = h2.innerHTML;
      h2.replaceWith(h1);
    }
    tidy(holder, root);
  } else {
    root = whole;
    pruneMenus(root);
    tidy(document, root);
  }
  const html = serialize(root);
  const markdown = htmlToMarkdown(html);

  const title = (useArticle ? article?.title?.trim() : '') || meta(document, 'og:title', 'twitter:title') || docTitle || firstHeading || '';
  const published = metaPublished ?? article?.publishedTime ?? undefined;

  return {
    title,
    ...(description ? { description } : {}),
    ...(language ? { language } : {}),
    ...(published ? { published } : {}),
    html,
    markdown,
    method: useArticle ? 'article' : 'whole-page',
  };
}

/**
 * For HTML that a helper already cut down to the main content: remove what is
 * left of scripts, styles and names, complete the links, and convert.
 */
export function tidyFragment(html: string, pageUrl: string): { html: string; markdown: string } {
  const document = parse(html);
  const body: Element = document.body ?? document.documentElement;
  removeJunk(document, body);
  absolutize(body, pageUrl);
  tidy(document, body);
  const out = serialize(body);
  return { html: out, markdown: htmlToMarkdown(out) };
}
