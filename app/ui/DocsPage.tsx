'use client';

/**
 * The docs as a page of their own, at /docs. Anybody can read it.
 *
 * It shows the same two pages as the dashboard's menu: the MCP doc ("#mcp-doc")
 * and the docs for the AI ("#docs-ai"). Links to a part of the dashboard, like
 * the live feed, lead to /dashboard, which asks its owner to log in first.
 */
import { useEffect, useState } from 'react';
import type { DocsPayload } from '@/lib/docs';
import { DocsAi } from './DocsAi';
import { McpDoc, type ClientId } from './McpDoc';
import { MENU, isOtherName, menuItem, viewFromHash, type MenuItem } from './menu';

type DocId = 'mcp-doc' | 'docs-ai';

const PAGES: readonly MenuItem[] = MENU.find((section) => section.title === 'Docs')?.items ?? [];

/** Which of the two pages an address names. Anything else means the first one. */
export function docFromHash(hash: string): DocId {
  return viewFromHash(hash) === 'docs-ai' ? 'docs-ai' : 'mcp-doc';
}

interface Status {
  release?: string;
  access?: 'personal' | 'open' | 'closed';
  allowed?: boolean;
  /** The key for an AI. Only the owner of a personal Scrapy, logged in, is given it. */
  key?: string | null;
}

export function DocsPage() {
  const [view, setView] = useState<DocId>('mcp-doc');
  const [origin, setOrigin] = useState('');
  const [status, setStatus] = useState<Status | null>(null);
  const [docs, setDocs] = useState<DocsPayload | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [client, setClient] = useState<ClientId>('cursor');

  useEffect(() => {
    setOrigin(window.location.origin);
    fetch('/api/status', { cache: 'no-store' })
      .then((r) => r.json())
      .then((s: Status) => setStatus(s))
      .catch(() => setStatus(null));
  }, []);

  useEffect(() => {
    const show = () => {
      const named = docFromHash(window.location.hash);
      setView(named);
      // Another name for a page ("#docs") is swapped for the page's own address. No step is added to the history.
      if (isOtherName(window.location.hash)) window.history.replaceState(window.history.state, '', `#${named}`);
    };
    show();
    const follow = () => {
      show();
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
  }, []);

  useEffect(() => {
    let stale = false;
    setFailed(false);
    fetch('/api/docs', { cache: 'no-store' })
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((d: DocsPayload) => {
        if (!stale) setDocs(d);
      })
      .catch(() => {
        if (!stale) setFailed(true);
      });
    return () => {
      stale = true;
    };
  }, [attempt]);

  const showing = menuItem(view);
  const retry = () => setAttempt((t) => t + 1);
  // Where the button in the bar leads: to the dashboard for those who may use it, to the login for the owner who is not logged in.
  const enter = !status || status.access === 'closed' ? null : status.allowed ? { href: '/dashboard', label: 'Dashboard' } : status.access === 'personal' ? { href: '/login', label: 'Log in' } : null;

  return (
    <>
      <header className="bar">
        <a className="brand" href="/" title="Home page">
          Scrapy
        </a>
        <nav className="bar-tabs" aria-label="Docs">
          {PAGES.map((page) => (
            <a key={page.id} href={`#${page.id}`} aria-current={page.id === view ? 'page' : undefined}>
              {page.label}
            </a>
          ))}
        </nav>
        {enter && (
          <a className="button small bar-end" href={enter.href}>
            {enter.label}
          </a>
        )}
      </header>

      <main>
        <h1>{showing.title ?? showing.label}</h1>
        <p className="lead">{showing.about}</p>

        {view === 'mcp-doc' && <McpDoc docs={docs} origin={origin} failed={failed} onRetry={retry} client={client} onClient={setClient} ownerKey={status?.key ?? null} dash="/dashboard" />}
        {view === 'docs-ai' && <DocsAi docs={docs} origin={origin} failed={failed} onRetry={retry} />}

        <footer>
          Scrapy {docs?.release ?? status?.release ?? ''}. These docs are open to everyone. The dashboard, with the checks and the live feed, is for those who may use this Scrapy.
        </footer>
      </main>
    </>
  );
}
