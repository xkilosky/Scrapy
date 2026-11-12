/**
 * The "focus" option: instead of a whole page, return only the parts that are
 * about what the agent asked for, for example "rate limits".
 *
 * Fixed rules, no AI: the page is cut into sections at its headings, each
 * section gets points for containing the focus words (more for the heading),
 * and the sections that score well are kept, in their original order.
 */
import { headings } from './markdown';

const STOP = new Set(
  'a an and are as at be but by can do does for from how i if in into is it its my of on or so that the their this to was what when where which who why will with you your about'.split(' '),
);

export interface FocusResult {
  /** The kept sections, or the page's list of headings when nothing matched. */
  text: string;
  matched: boolean;
  kept: number;
  total: number;
  /** Headings of the kept sections. */
  keptHeadings: string[];
}

interface Section {
  heading: string;
  /** Headings above this one, outermost first. */
  path: string[];
  body: string;
  start: number;
}

function stem(word: string): string {
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith('es')) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

export function focusTerms(focus: string): string[] {
  const words = focus
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((w) => w.length >= 2 && !STOP.has(w));
  return [...new Set(words.map(stem))];
}

function sections(markdown: string): Section[] {
  const heads = headings(markdown);
  const out: Section[] = [];
  const first = heads[0];
  if (!first || first.at > 0) {
    const intro = markdown.slice(0, first ? first.at : markdown.length);
    if (intro.trim() !== '') out.push({ heading: '', path: [], body: intro, start: 0 });
  }
  const stack: { level: number; text: string }[] = [];
  heads.forEach((h, i) => {
    while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= h.level) stack.pop();
    const end = heads[i + 1]?.at ?? markdown.length;
    out.push({ heading: h.text, path: stack.map((s) => s.text), body: markdown.slice(h.at, end), start: h.at });
    stack.push({ level: h.level, text: h.text });
  });
  return out;
}

/** A page without headings is cut into groups of paragraphs instead. */
function paragraphGroups(markdown: string): Section[] {
  const out: Section[] = [];
  let start = 0;
  let buffer = '';
  for (const piece of markdown.split(/(\n{2,})/)) {
    buffer += piece;
    if (buffer.length >= 1_200) {
      out.push({ heading: '', path: [], body: buffer, start });
      start += buffer.length;
      buffer = '';
    }
  }
  if (buffer.trim() !== '') out.push({ heading: '', path: [], body: buffer, start });
  return out;
}

function count(haystack: string, needle: string): number {
  let n = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return n;
    n++;
    from = at + needle.length;
  }
}

export function applyFocus(markdown: string, focus: string): FocusResult {
  const terms = focusTerms(focus);
  const phrase = focus.toLowerCase().replace(/\s+/g, ' ').trim();
  let parts = sections(markdown);
  if (parts.length <= 1) parts = paragraphGroups(markdown);
  const total = parts.length;

  if (terms.length === 0 || total === 0) {
    return { text: markdown, matched: false, kept: total, total, keptHeadings: [] };
  }

  const scored = parts.map((section) => {
    const head = `${section.path.join(' ')} ${section.heading}`.toLowerCase();
    const body = section.body.toLowerCase();
    let score = 0;
    let found = 0;
    for (const term of terms) {
      const inHead = head.includes(term);
      const inBody = Math.min(5, count(body, term));
      if (inHead || inBody > 0) found++;
      score += (inHead ? 6 : 0) + inBody;
    }
    if (phrase.includes(' ') && body.includes(phrase)) score += 8;
    // Sections that contain every focus word count for more than sections that contain one of them often.
    score *= found / terms.length;
    return { section, score, found };
  });

  const best = Math.max(...scored.map((s) => s.score));
  if (best <= 0) {
    const list = headings(markdown)
      .slice(0, 60)
      .map((h) => `${'  '.repeat(Math.max(0, h.level - 1))}- ${h.text}`)
      .join('\n');
    const text = list ? `Nothing on this page matches the focus "${focus}". These are its headings:\n\n${list}` : `Nothing on this page matches the focus "${focus}".`;
    return { text, matched: false, kept: 0, total, keptHeadings: [] };
  }

  const need = Math.max(1, Math.ceil(terms.length / 2));
  const kept = scored.filter((s) => s.score >= best * 0.35 && s.found >= need);
  const text = kept
    .map((s) => {
      const body = s.section.body.trim();
      // A sub-section alone can be hard to place, so the headings above it are named.
      const context = s.section.path.length > 0 ? `_In: ${s.section.path.join(' > ')}_\n\n` : '';
      return `${context}${body}`;
    })
    .join('\n\n');
  return { text, matched: true, kept: kept.length, total, keptHeadings: kept.map((s) => s.section.heading).filter(Boolean) };
}
