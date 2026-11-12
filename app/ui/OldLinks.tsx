'use client';

/**
 * Until release G - 1.0 the dashboard was the home page, and "/#try" opened one
 * of its parts. A link saved then still works: it is sent on to where that
 * part is now. The docs went to /docs, everything else to /dashboard.
 */
import { useEffect } from 'react';
import { goInstead } from './go';
import { FIRST_VIEW, isOtherName, viewFromHash } from './menu';

const DOCS = new Set<string>(['mcp-doc', 'docs-ai']);

/** Where an old address like "#try" leads now, or null when it names no part. */
export function newHome(hash: string): string | null {
  const id = hash.replace(/^#/, '');
  if (id === '') return null;
  const view = viewFromHash(hash);
  // An unknown name falls back to the first part. That is no reason to leave the home page.
  if (view === FIRST_VIEW && id !== FIRST_VIEW && !isOtherName(hash)) return null;
  return `${DOCS.has(view) ? '/docs' : '/dashboard'}#${view}`;
}

export function OldLinks() {
  useEffect(() => {
    const to = newHome(window.location.hash);
    // In place of the home page: "Back" must not lead to an address that sends the reader on again.
    if (to) goInstead(to);
  }, []);
  return null;
}
