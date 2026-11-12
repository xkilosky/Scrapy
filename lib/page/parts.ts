/**
 * Cuts a long page into numbered parts, so one page never floods the agent.
 *
 * The parts are exact slices: joined together they give back the full text,
 * with nothing missing and nothing repeated. Cuts are made at the best nearby
 * place: before a heading, else between paragraphs, else between lines.
 */
import { codeRanges } from './markdown';

export function splitParts(text: string, size: number): string[] {
  const slack = Math.floor(size * 0.15);
  if (text.length <= size + slack) return [text];

  const ranges = codeRanges(text);
  const insideCode = (pos: number): boolean => ranges.some(([from, to]) => pos > from && pos < to);

  const parts: string[] = [];
  let start = 0;
  while (text.length - start > size + slack) {
    const min = start + Math.floor(size * 0.6);
    const max = start + size;
    const cut = bestCut(text, min, max, insideCode);
    parts.push(text.slice(start, cut));
    start = cut;
  }
  parts.push(text.slice(start));
  return parts;
}

function lastMatch(text: string, min: number, max: number, pattern: RegExp, ok: (pos: number) => boolean): number {
  const window = text.slice(min, max);
  let best = -1;
  for (const m of window.matchAll(pattern)) {
    const pos = min + (m.index ?? 0) + m[0].length;
    if (pos > min && pos <= max && ok(pos)) best = pos;
  }
  return best;
}

function bestCut(text: string, min: number, max: number, insideCode: (pos: number) => boolean): number {
  const outside = (pos: number): boolean => !insideCode(pos);
  // 1. Just before a heading.
  let cut = lastMatch(text, min, max, /\n(?=#{1,6} )/g, outside);
  if (cut !== -1) return cut;
  // 2. Between two paragraphs.
  cut = lastMatch(text, min, max, /\n{2,}/g, outside);
  if (cut !== -1) return cut;
  // 3. Between two lines. Allowed inside a code block: a huge code block has no better place.
  cut = lastMatch(text, min, max, /\n/g, () => true);
  if (cut !== -1) return cut;
  // 4. Between two words.
  cut = lastMatch(text, min, max, / /g, () => true);
  if (cut !== -1) return cut;
  return max;
}
