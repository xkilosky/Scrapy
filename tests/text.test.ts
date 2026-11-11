import { describe, expect, it } from 'vitest';
import { applyFocus, focusTerms } from '../lib/page/focus';
import { codeRanges, headings, plainText, tidyMarkdown } from '../lib/page/markdown';
import { splitParts } from '../lib/page/parts';
import { judge } from '../lib/page/quality';

describe('tidyMarkdown', () => {
  it('turns underlined headings into # headings', () => {
    expect(tidyMarkdown('Example Domain\n==============\n\nSome text.\n\nSmaller\n-------\n\nMore.')).toBe('# Example Domain\n\nSome text.\n\n## Smaller\n\nMore.');
  });

  it('leaves a horizontal line and a table alone', () => {
    const md = 'Text.\n\n---\n\n| a | b |\n| --- | --- |\n| 1 | 2 |';
    expect(tidyMarkdown(md)).toBe(md);
  });

  it('drops pictures stored inside the page, links with no text, and extra blank lines', () => {
    expect(tidyMarkdown('A ![logo](data:image/png;base64,AAAA) B\n\n\n\n[](https://x.example) C')).toBe('A logo B\n\n C');
  });

  it('never changes what is inside a code block', () => {
    const md = 'Run:\n\n```bash\n# not a heading\n\n\n\necho "[](x)"   \n```';
    expect(tidyMarkdown(md)).toBe(md);
  });

  it('removes a "skip to content" link', () => {
    expect(tidyMarkdown('[Skip to content](#main)\n\n# Docs')).toBe('# Docs');
  });
});

describe('headings, codeRanges and plainText', () => {
  it('finds headings but not the ones inside code', () => {
    const md = '# One\n\n```\n# fake\n```\n\n## Two [link](https://x.example)';
    expect(headings(md).map((h) => `${h.level}:${h.text}`)).toEqual(['1:One', '2:Two link']);
    expect(codeRanges(md)).toHaveLength(1);
  });

  it('strips the marks from Markdown', () => {
    expect(plainText('# Title\n\nSome **bold** [link](https://x.example) and `code`.')).toBe('Title Some bold link and code.');
  });
});

describe('splitParts', () => {
  const section = (n: number): string => `## Section ${n}\n\n${`Paragraph about topic ${n}. `.repeat(40)}\n\n`;
  const long = `# Guide\n\n${Array.from({ length: 30 }, (_, i) => section(i + 1)).join('')}`;

  it('returns a short text as one part', () => {
    expect(splitParts('short text', 20_000)).toEqual(['short text']);
  });

  it('joins back into the full text, with nothing missing or repeated', () => {
    const parts = splitParts(long, 5_000);
    expect(parts.length).toBeGreaterThan(3);
    expect(parts.join('')).toBe(long);
  });

  it('keeps parts near the wanted size and cuts just before a heading', () => {
    const parts = splitParts(long, 5_000);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(5_000 * 1.15 + 1);
    for (const part of parts.slice(1)) expect(part.startsWith('## Section')).toBe(true);
  });

  it('does not cut inside a code block when it can avoid it', () => {
    const code = `\`\`\`js\n${'const x = 1;\n\n'.repeat(120)}\`\`\`\n\n`;
    const text = `${'Intro paragraph. '.repeat(150)}\n\n${code}${'Outro paragraph. '.repeat(250)}`;
    const parts = splitParts(text, 4_000);
    expect(parts.join('')).toBe(text);
    for (const part of parts) {
      const fences = part.match(/^```/gm)?.length ?? 0;
      expect(fences % 2, 'a part opens a code block without closing it').toBe(0);
    }
  });

  it('still cuts a text with no breaks at all', () => {
    const blob = 'x'.repeat(50_000);
    const parts = splitParts(blob, 20_000);
    expect(parts.join('')).toBe(blob);
    expect(parts.length).toBe(3);
  });
});

describe('applyFocus', () => {
  const doc = [
    '# API guide',
    'Welcome to the API.',
    '## Authentication',
    'Send your token in the Authorization header.',
    '## Rate limits',
    'Each key may send 100 requests per minute. When the limit is hit the API answers 429.',
    '### Raising your limit',
    'Contact support to raise the rate limit for your account.',
    '## Errors',
    'Errors come back as JSON with a code and a message.',
  ].join('\n\n');

  it('keeps only the sections about the focus', () => {
    const out = applyFocus(doc, 'rate limits');
    expect(out.matched).toBe(true);
    expect(out.text).toContain('## Rate limits');
    expect(out.text).toContain('100 requests per minute');
    expect(out.text).toContain('### Raising your limit');
    expect(out.text).not.toContain('Authorization header');
    expect(out.text).not.toContain('Errors come back');
    expect(out.kept).toBeLessThan(out.total);
  });

  it('names the headings above a kept sub-section', () => {
    expect(applyFocus(doc, 'raising limit support').text).toContain('_In: API guide > Rate limits_');
  });

  it('lists the page headings when nothing matches', () => {
    const out = applyFocus(doc, 'webhooks');
    expect(out.matched).toBe(false);
    expect(out.text).toContain('Nothing on this page matches the focus "webhooks"');
    expect(out.text).toContain('- Authentication');
  });

  it('works on a page without headings', () => {
    const flat = Array.from({ length: 12 }, (_, i) => `${'Filler sentence number '.repeat(30)}${i}.`).join('\n\n') + '\n\nThe refund policy allows returns within 30 days.';
    const out = applyFocus(flat, 'refund policy');
    expect(out.matched).toBe(true);
    expect(out.text).toContain('refund policy allows returns');
    expect(out.text.length).toBeLessThan(flat.length);
  });

  it('ignores small words and word endings', () => {
    expect(focusTerms('How to handle the rate limits')).toEqual(['handle', 'rate', 'limit']);
  });
});

describe('judge', () => {
  const article = `# Title\n\n${'A real sentence with real content in it. '.repeat(30)}`;

  it('accepts a normal page', () => {
    expect(judge({ markdown: article, title: 'Title' }).ok).toBe(true);
    expect(judge({ markdown: '# Example Domain\n\nThis domain is for use in documentation examples without needing permission.' }).ok).toBe(true);
  });

  it('rejects an empty page', () => {
    expect(judge({ markdown: '   \n\n ' })).toMatchObject({ ok: false, kind: 'empty' });
  });

  it('rejects a page that only says to turn on JavaScript', () => {
    expect(judge({ markdown: 'You need to enable JavaScript to run this app.' })).toMatchObject({ ok: false, kind: 'needs_js' });
    expect(judge({ markdown: 'Acme\n\nPlease enable JavaScript to continue using this application.' })).toMatchObject({ ok: false, kind: 'needs_js' });
  });

  it('rejects block pages', () => {
    expect(judge({ title: 'Just a moment...', markdown: 'Verifying you are human. This may take a few seconds. example.com needs to review the security of your connection.' })).toMatchObject({ ok: false, kind: 'blocked' });
    expect(judge({ title: 'Access Denied', markdown: "You don't have permission to access this resource on this server. Reference #18.abc" })).toMatchObject({ ok: false, kind: 'blocked' });
  });

  it('rejects login walls and "page not found" pages', () => {
    expect(judge({ title: 'Log in', markdown: 'Log in to continue. Email address Password Forgot your password? Create account' })).toMatchObject({ ok: false, kind: 'login' });
    expect(judge({ title: '404', markdown: 'Page not found. The page you are looking for does not exist or has moved.' })).toMatchObject({ ok: false, kind: 'not_found' });
  });

  it('does not mistake a long article about captchas or logins for a block page', () => {
    const text = `# How CAPTCHA works\n\n${'A captcha asks a visitor to prove they are human before they log in to continue. '.repeat(40)}`;
    expect(judge({ markdown: text, title: 'How CAPTCHA works' }).ok).toBe(true);
  });
});
