import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cleanPage, htmlToMarkdown, tidyFragment } from '../lib/page/clean';

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

describe('cleanPage on an article', () => {
  const page = cleanPage(fixture('article.html'), 'https://blog.example.com/posts/hydration');

  it('reads the title, description, language and date', () => {
    expect(page.title).toBe('How to fix hydration errors');
    expect(page.description).toBe('A guide to hydration errors.');
    expect(page.language).toBe('en');
    expect(page.published).toBe('2026-03-02T10:00:00Z');
    expect(page.method).toBe('article');
  });

  it('keeps the article text, headings, code, table and picture', () => {
    expect(page.markdown).toContain('Hydration errors happen when the HTML rendered on the server');
    expect(page.markdown).toContain('## Reading cookies during render');
    expect(page.markdown).toContain('## Dates and random values');
    expect(page.markdown).toContain("```tsx\nuseEffect(() => {\n  setTheme(localStorage.getItem('theme'));\n}, []);\n```");
    expect(page.markdown).toContain('| Cause | Fix |');
    expect(page.markdown).toContain('| Math.random() | Use a seeded id |');
    expect(page.markdown).toContain('![Diagram of hydration](https://blog.example.com/img/diagram.png)');
  });

  it('makes links complete', () => {
    expect(page.markdown).toContain('[why they happen](https://blog.example.com/docs/why)');
  });

  it('removes menus, ads, cookie banners, pop-ups, share bars, side columns and the footer', () => {
    for (const junk of ['We use cookies', 'Accept all', 'Your privacy choices', 'Join 10,000 readers', 'Subscribe', 'Buy our course', 'Sponsored', 'Tweet', 'Related posts', 'Ten CSS tricks', 'Copyright 2026', 'Pricing', 'Hidden tracking text']) {
      expect(page.markdown, junk).not.toContain(junk);
      expect(page.html, junk).not.toContain(junk);
    }
  });

  it('leaves no scripts, styles, classes or ids in the HTML', () => {
    expect(page.html).not.toMatch(/<script|<style|alert\(|dataLayer/);
    expect(page.html).not.toMatch(/\sid=|\sstyle=|data-src/);
    expect(page.html).not.toMatch(/class="(?!language-)/);
    expect(page.html).toContain('<h2>Reading cookies during render</h2>');
  });
});

describe('cleanPage on a page made of several sections', () => {
  const page = cleanPage(fixture('landing.html'), 'https://acme.example/');

  it('keeps every section, not just one', () => {
    expect(page.markdown).toContain('# Write together, without the mess');
    expect(page.markdown).toContain('## Everything in one place');
    expect(page.markdown).toContain('### Works offline');
    expect(page.markdown).toContain('## Simple pricing');
    expect(page.markdown).toContain('## Loved by small teams');
    expect(page.markdown).toContain('nobody on the team has asked to go back');
  });

  it('drops the menu and the footer', () => {
    expect(page.markdown).not.toContain('Log in');
    expect(page.markdown).not.toContain('Privacy');
    expect(page.markdown).not.toContain('Acme Inc.');
  });

  it('uses the social-preview title', () => {
    expect(page.title).toBe('Acme Notes');
    expect(page.markdown).toContain('[Start for free](https://acme.example/signup)');
  });
});

describe('cleanPage edge cases', () => {
  it('does not throw away a page whose content sits in a box marked hidden', () => {
    const body = 'This is the real page. '.repeat(30);
    const page = cleanPage(`<html><body><div id="app" aria-hidden="true"><h1>Shop</h1><p>${body}</p></div><div role="dialog">Sign up now</div></body></html>`, 'https://x.example/');
    expect(page.markdown).toContain('This is the real page.');
    expect(page.markdown).not.toContain('Sign up now');
  });

  it('keeps a long documentation section that happens to be called "cookies"', () => {
    const docs = 'A cookie is a small piece of data a server sends to the browser. '.repeat(40);
    const page = cleanPage(`<html><body><main><h1>HTTP guide</h1><section id="cookies" class="cookies"><h2>Cookies</h2><p>${docs}</p><a href="/more">More</a></section></main></body></html>`, 'https://docs.example/');
    expect(page.markdown).toContain('## Cookies');
    expect(page.markdown).toContain('A cookie is a small piece of data');
  });

  it('copes with a bare fragment and with an empty page', () => {
    expect(cleanPage('<p>Just one paragraph of text here.</p>', 'https://x.example/').markdown).toBe('Just one paragraph of text here.');
    expect(cleanPage('', 'https://x.example/').markdown).toBe('');
  });

  it('turns an embedded video into a link', () => {
    const page = cleanPage('<html><body><main><h1>Demo</h1><p>Watch how it works in two minutes.</p><iframe src="https://www.youtube.com/embed/abc" title="Product demo"></iframe><iframe src="https://ads.example/x"></iframe></main></body></html>', 'https://x.example/');
    expect(page.markdown).toContain('[Video: Product demo](https://www.youtube.com/embed/abc)');
    expect(page.markdown).not.toContain('ads.example');
  });
});

describe('tidyFragment and htmlToMarkdown', () => {
  it('cleans HTML that a helper already cut down', () => {
    const out = tidyFragment('<div class="wrap" onclick="x()"><h1 id="t">Title</h1><script>bad()</script><p>Hello <a href="/a">link</a></p></div>', 'https://site.example/dir/page');
    expect(out.html).toBe('<h1>Title</h1>\n<p>Hello <a href="https://site.example/a">link</a></p>');
    expect(out.markdown).toBe('# Title\n\nHello [link](https://site.example/a)');
  });

  it('converts lists and strikethrough', () => {
    expect(htmlToMarkdown('<ul><li>One</li><li>Two <del>old</del></li></ul>')).toBe('-   One\n-   Two ~old~');
  });
});
