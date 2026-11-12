/**
 * Tidies Markdown, wherever it came from. Each helper writes Markdown a little
 * differently; after this they all look the same.
 */

const FENCE = /^ {0,3}(```+|~~~+)/;

/** Calls fn for every stretch of text outside code blocks, and leaves code blocks untouched. */
function outsideCode(markdown: string, fn: (text: string) => string): string {
  const lines = markdown.split('\n');
  const out: string[] = [];
  let buffer: string[] = [];
  let open: string | null = null;
  const flush = (): void => {
    if (buffer.length > 0) out.push(fn(buffer.join('\n')));
    buffer = [];
  };
  for (const line of lines) {
    const fence = FENCE.exec(line)?.[1];
    if (open === null) {
      if (fence) {
        flush();
        open = fence[0] ?? '`';
        out.push(line);
      } else {
        buffer.push(line);
      }
    } else {
      out.push(line);
      if (fence && fence.startsWith(open) && line.trim() === fence) open = null;
    }
  }
  flush();
  return out.join('\n');
}

/** "Title\n=====" and "Title\n-----" become "# Title" and "## Title". */
function atxHeadings(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const next = lines[i + 1] ?? '';
    const prev = i === 0 ? '' : (lines[i - 1] ?? '');
    const plain = line.trim() !== '' && prev.trim() === '' && !/^\s*([#>|*+-]|\d+\.)\s?/.test(line) && line.length <= 300;
    if (plain && /^=+\s*$/.test(next) && next.trim().length >= 2) {
      out.push(`# ${line.trim()}`);
      i++;
    } else if (plain && /^-+\s*$/.test(next) && next.trim().length >= 3) {
      out.push(`## ${line.trim()}`);
      i++;
    } else {
      out.push(line);
    }
  }
  return out.join('\n');
}

export function tidyMarkdown(markdown: string): string {
  let md = markdown.replace(/\r\n?/g, '\n').replace(/[\u200b\u200c\u200d\ufeff\u00ad]/g, '').replace(/\u00a0/g, ' ');
  md = outsideCode(md, (text) => {
    let t = text;
    // Pictures stored inside the page itself are huge and unreadable. Their description stays.
    t = t.replace(/!\[([^\]]*)\]\(\s*data:[^)]*\)/g, '$1');
    // Links with no text.
    t = t.replace(/(?<!!)\[\s*\]\([^)]*\)/g, '');
    t = t.replace(/^\s*\[?\s*skip to (main )?(content|navigation)\s*\]?(\([^)]*\))?\s*$/gim, '');
    t = atxHeadings(t);
    t = t.replace(/[ \t]+$/gm, '');
    t = t.replace(/\n{3,}/g, '\n\n');
    return t;
  });
  return md.trim();
}

/** Markdown with its marks removed. Used to measure and judge a page, never shown. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```\w*/g, ''))
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^[#>\s]*[#>]\s?/gm, '')
    .replace(/[*_`~|]/g, '')
    .replace(/^\s*[-+]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface Heading {
  level: number;
  text: string;
  /** Character position of the heading line in the Markdown. */
  at: number;
}

/** Every heading of a Markdown text, in order. Headings inside code blocks do not count. */
export function headings(markdown: string): Heading[] {
  const found: Heading[] = [];
  let open: string | null = null;
  let at = 0;
  for (const line of markdown.split('\n')) {
    const fence = FENCE.exec(line)?.[1];
    if (open === null) {
      if (fence) {
        open = fence[0] ?? '`';
      } else {
        const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
        if (m) found.push({ level: (m[1] ?? '#').length, text: (m[2] ?? '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim(), at });
      }
    } else if (fence && fence.startsWith(open) && line.trim() === fence) {
      open = null;
    }
    at += line.length + 1;
  }
  return found;
}

/** Start and end positions of every code block. */
export function codeRanges(markdown: string): [number, number][] {
  const ranges: [number, number][] = [];
  let open: string | null = null;
  let openedAt = 0;
  let at = 0;
  for (const line of markdown.split('\n')) {
    const fence = FENCE.exec(line)?.[1];
    if (open === null) {
      if (fence) {
        open = fence[0] ?? '`';
        openedAt = at;
      }
    } else if (fence && fence.startsWith(open) && line.trim() === fence) {
      ranges.push([openedAt, at + line.length]);
      open = null;
    }
    at += line.length + 1;
  }
  if (open !== null) ranges.push([openedAt, markdown.length]);
  return ranges;
}
