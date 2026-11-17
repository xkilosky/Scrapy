import { describe, expect, it } from 'vitest';
import { imagesInPage } from '@/lib/tools/imageTools';

describe('imagesInPage', () => {
  it('finds normal, lazy, responsive, picture and metadata images, resolves links, and deduplicates', () => {
    const hits = imagesInPage(`<!doctype html><html><head>
      <meta property="og:image" content="/social.png">
      <meta name="twitter:image" content="https://cdn.example.com/social.png">
    </head><body>
      <img src="/hero.jpg" alt=" A hero " width="1200" height="800" srcset="/hero.jpg 1x, /hero@2x.jpg 2x">
      <img data-src="/lazy.webp" data-original="/old.webp" alt="Lazy illustration">
      <picture><source srcset="/large.png 1200w, /small.png 400w"><img src="/fallback.png"></picture>
      <img src="javascript:alert(1)"><img src="http://127.0.0.1/admin">
    </body></html>`, 'https://example.com/article');
    expect(hits.map((hit) => hit.url)).toEqual([
      'https://example.com/hero.jpg',
      'https://example.com/hero@2x.jpg',
      'https://example.com/lazy.webp',
      'https://example.com/old.webp',
      'https://example.com/fallback.png',
      'https://example.com/large.png',
      'https://example.com/small.png',
      'https://example.com/social.png',
      'https://cdn.example.com/social.png',
    ]);
    expect(hits.find((hit) => hit.url.endsWith('/hero.jpg'))).toMatchObject({ alt: 'A hero', width: '1200', height: '800' });
    expect(hits.find((hit) => hit.url.endsWith('/lazy.webp'))?.alt).toBe('Lazy illustration');
  });

  it('caps results at 100 unique public HTTP(S) images', () => {
    const html = `<main>${Array.from({ length: 120 }, (_, i) => `<img src="/image-${i}.png">`).join('')}</main>`;
    expect(imagesInPage(html, 'https://example.com/')).toHaveLength(100);
  });
});
