// @vitest-environment jsdom
/**
 * Release G - 1.0, in a browser-like environment: the home page, the login,
 * the dashboard of a personal Scrapy, and the docs for everybody.
 *
 * A test environment cannot leave a page. So the two functions that do it
 * (app/ui/go.ts) are stand-ins here, and write down where the page would go.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DashboardPage from '@/app/dashboard/page';
import LoginPage from '@/app/login/page';
import HomePage from '@/app/page';
import Console from '@/app/ui/Console';
import { DocsPage, docFromHash } from '@/app/ui/DocsPage';
import { LoginForm } from '@/app/ui/LoginForm';
import { CLIENTS, connectSnippets, handCheck, KEY_PLACE } from '@/app/ui/McpDoc';
import { newHome, OldLinks } from '@/app/ui/OldLinks';
import { docsPayload, type DocsPayload } from '@/lib/docs';
import { newSession, SESSION_COOKIE } from '@/lib/owner';

const nav = vi.hoisted(() => ({ went: [] as string[], instead: [] as string[], cookie: undefined as string | undefined }));

vi.mock('@/app/ui/go', () => ({
  go: (path: string) => {
    nav.went.push(path);
  },
  goInstead: (path: string) => {
    nav.instead.push(path);
  },
}));

// The cookie a page is asked with, and the "go there instead" of a page made on the server.
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (name === 'scrapy_session' && nav.cookie !== undefined ? { name, value: nav.cookie } : undefined) }),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`sent to ${to}`);
  },
}));

const PASSWORD = 'four quiet green rivers';
const KEY = 'scrapy_0123456789abcdefghijklmnopqrstuv';
/** jsdom serves the page from here. */
const ORIGIN = 'http://localhost:3000';
const ADDRESS = `${ORIGIN}/api/mcp`;

const OPEN = {
  name: 'scrapy',
  version: '1.0.0',
  release: 'G - 1.0',
  access: 'open',
  allowed: true,
  open: true,
  mode: 'safe',
  tools: [
    { name: 'search_web', title: 'Search the web' },
    { name: 'fetch_url', title: 'Read a web page' },
  ],
  limits: { visitorPerMinute: 30, dailyCalls: 1500 },
  usage: { today: 0 },
  where: { vercel: false, env: null, region: null },
};
/** What the owner of a personal Scrapy is told, logged in. */
const OWNER = { ...OPEN, access: 'personal', key: KEY };
/** What everybody else is told there. */
const STRANGER = { name: 'scrapy', version: '1.0.0', release: 'G - 1.0', access: 'personal', open: true, allowed: false, message: 'This Scrapy is personal. Log in to use it.' };
const CLOSED = { name: 'scrapy', version: '1.0.0', release: 'G - 1.0', access: 'closed', open: false, allowed: false, message: 'Scrapy is closed at this address. Its owner has not opened it yet.' };
const LOG_IN_FIRST = { ok: false, login: true, text: 'This Scrapy is personal. Log in to use it.', error: 'This Scrapy is personal. Log in to use it.' };
const EMPTY_FEED = { open: true, on: true, rev: '0', entries: [], keep: 100, hours: 24, where: 'memory' };

interface Asked {
  url: string;
  method: string;
  body: unknown;
}

let asked: Asked[] = [];
let copied: string[] = [];
let answers: { status: unknown; docs: DocsPayload | 'down'; login: () => Response | Promise<Response>; loggedIn: boolean };

/** What Scrapy hands the docs pages, made by the real code, for a Scrapy of the given kind. */
function docsOf(access: 'personal' | 'open' | 'closed'): DocsPayload {
  const payload = JSON.parse(JSON.stringify(docsPayload())) as DocsPayload;
  payload.facts.access = access;
  return payload;
}

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  asked = [];
  copied = [];
  nav.went.length = 0;
  nav.instead.length = 0;
  nav.cookie = undefined;
  answers = { status: OWNER, docs: docsOf('personal'), login: () => Response.json({ ok: true }), loggedIn: true };
  vi.stubGlobal('scrollTo', vi.fn());
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      asked.push({ url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
      const refused = (): Response => Response.json(LOG_IN_FIRST, { status: 401 });
      if (url.endsWith('/api/status')) return Response.json(answers.status);
      if (url.endsWith('/api/docs')) return answers.docs === 'down' ? new Response('no', { status: 500 }) : Response.json(answers.docs);
      if (url.endsWith('/api/login')) return answers.login();
      if (url.endsWith('/api/logout')) return Response.json({ ok: true });
      if (url.startsWith('/api/logs')) return answers.loggedIn ? Response.json(EMPTY_FEED) : refused();
      if (url.endsWith('/api/try')) return answers.loggedIn ? Response.json({ ok: true, text: 'Title: Example Domain', trace: { totalMs: 200, cache: 'miss', steps: [], contacts: [], hosts: [] } }) : refused();
      if (url.endsWith('/api/check')) return answers.loggedIn ? Response.json({ error: 'not in this test' }, { status: 500 }) : refused();
      return new Response('not found', { status: 404 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete process.env.SCRAPY_PASSWORD;
  delete process.env.VERCEL_ENV;
  delete process.env.SCRAPY_OPEN;
});

/** A user, with a clipboard that remembers what was copied. */
function user(): ReturnType<typeof userEvent.setup> {
  const u = userEvent.setup();
  vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(async (text: string) => {
    copied.push(text);
  });
  return u;
}

async function dashboard(hash: string, heading: string): Promise<void> {
  window.history.replaceState(null, '', `/dashboard${hash}`);
  render(<Console />);
  await screen.findByRole('heading', { level: 1, name: heading });
}

const requests = (path: string): Asked[] => asked.filter((a) => a.url.endsWith(path));
const shown = (): string => document.body.textContent ?? '';
const linkTo = (name: string | RegExp): string | null => screen.getByRole('link', { name }).getAttribute('href');

describe('the dashboard of a personal Scrapy: the key', () => {
  it('has the key under the address, hidden until it is asked for', async () => {
    await dashboard('#address', 'The address for your agent');
    const heading = await screen.findByRole('heading', { level: 2, name: 'The key' });
    const box = document.querySelector('code[aria-labelledby="key-title"]');
    expect(heading.id).toBe('key-title');
    expect(box?.textContent).toBe('\u2022'.repeat(24));
    expect(shown()).not.toContain(KEY);

    const u = user();
    const show = screen.getByRole('button', { name: 'Show' });
    expect(show.getAttribute('aria-pressed')).toBe('false');
    await u.click(show);
    expect(box?.textContent).toBe(KEY);
    const hide = screen.getByRole('button', { name: 'Hide' });
    expect(hide.getAttribute('aria-pressed')).toBe('true');
    await u.click(hide);
    expect(box?.textContent).toBe('\u2022'.repeat(24));
    expect(shown()).not.toContain(KEY);
  });

  it('copies the key, and the address with the key, without showing either', async () => {
    await dashboard('#address', 'The address for your agent');
    await screen.findByRole('heading', { level: 2, name: 'The key' });
    const u = user();
    await u.click(screen.getByRole('button', { name: 'Copy the key' }));
    await u.click(screen.getByRole('button', { name: 'Copy the address with the key' }));
    await u.click(screen.getAllByRole('button', { name: 'Copy' })[0] as HTMLElement);
    expect(copied).toEqual([KEY, `${ADDRESS}?key=${KEY}`, ADDRESS]);
    expect(shown()).not.toContain(KEY);
  });

  it('says what the key is for, where it goes, and what a new password does', async () => {
    await dashboard('#address', 'The address for your agent');
    await screen.findByRole('heading', { level: 2, name: 'The key' });
    expect(shown()).toContain('This Scrapy is personal: it answers only to you. Your AI sends the key with every request, in the header Authorization: Bearer followed by the key.');
    expect(shown()).toContain('Keep the key to yourself: whoever has it can use this Scrapy.');
    expect(shown()).toContain('A new password (the setting SCRAPY_PASSWORD) makes a new key and logs every browser out.');
    // One owner: the limits are not "for each visitor".
    expect(shown()).toContain('Limits: 30 calls a minute, 1,500 calls a day.');
  });

  it('has no key, and nothing about one, where Scrapy has no password', async () => {
    answers.status = OPEN;
    await dashboard('#address', 'The address for your agent');
    await screen.findByText(/Tools ready now/);
    expect(screen.queryByRole('heading', { name: 'The key' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy the key' })).toBeNull();
    expect(shown()).toContain('Limits: 30 calls a minute for each visitor, 1,500 calls a day in total.');
    expect(shown()).toContain('Where to put this address in your AI app is in the MCP doc.');
  });

  it('does not take a key from a status that is not personal', async () => {
    // A key could only be there by mistake. It is not shown, and not put into what is copied.
    answers.status = { ...OPEN, key: KEY };
    answers.docs = docsOf('open');
    await dashboard('#address', 'The address for your agent');
    await screen.findByText(/Tools ready now/);
    expect(screen.queryByRole('heading', { name: 'The key' })).toBeNull();
  });
});

describe('the dashboard of a personal Scrapy: logging out', () => {
  it('has "Log out" and the release at the foot of the menu', async () => {
    await dashboard('', 'Run checks');
    const u = user();
    await u.click(screen.getByRole('button', { name: 'Open menu' }));
    const menu = screen.getByRole('dialog', { name: 'Menu' });
    expect(await within(menu).findByRole('button', { name: 'Log out' })).toBeTruthy();
    expect(within(menu).getByText('Scrapy G - 1.0')).toBeTruthy();
  });

  it('takes the pass back and leaves for the home page', async () => {
    await dashboard('#try', 'Try a tool');
    const u = user();
    await u.click(screen.getByRole('button', { name: 'Open menu' }));
    await u.click(await screen.findByRole('button', { name: 'Log out' }));
    await waitFor(() => expect(nav.went).toEqual(['/']));
    expect(requests('/api/logout').map((a) => a.method)).toEqual(['POST']);
  });

  it('leaves for the home page also when Scrapy does not answer', async () => {
    await dashboard('', 'Run checks');
    const u = user();
    await u.click(screen.getByRole('button', { name: 'Open menu' }));
    const button = await screen.findByRole('button', { name: 'Log out' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('offline');
      }),
    );
    await u.click(button);
    await waitFor(() => expect(nav.went).toEqual(['/']));
  });

  it('has no "Log out" where there is nothing to log out of', async () => {
    answers.status = OPEN;
    await dashboard('', 'Run checks');
    const u = user();
    await u.click(screen.getByRole('button', { name: 'Open menu' }));
    const menu = screen.getByRole('dialog', { name: 'Menu' });
    expect(await within(menu).findByText('Scrapy G - 1.0')).toBeTruthy();
    expect(within(menu).queryByRole('button', { name: 'Log out' })).toBeNull();
  });
});

describe('the dashboard of a personal Scrapy: a login that has ended', () => {
  const loggedOut = async (part: string): Promise<void> => {
    expect(await screen.findByRole('heading', { level: 2, name: 'You are logged out' })).toBeTruthy();
    expect(shown()).toContain('Your login has ended. Log in again to go on where you were.');
    // Back to the same part after the login.
    expect(linkTo('Log in')).toBe(`/login#${part}`);
    // Nothing of the dashboard is left on the screen.
    expect(screen.queryByRole('button', { name: 'Open menu' })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(shown()).not.toContain(KEY);
  };

  it('says so when a tool is tried, instead of showing a failure', async () => {
    await dashboard('#try', 'Try a tool');
    answers.loggedIn = false;
    await user().click(screen.getByRole('button', { name: 'Run search_web' }));
    await loggedOut('try');
  });

  it('says so when the checks are started', async () => {
    await dashboard('#checks', 'Run checks');
    answers.loggedIn = false;
    await user().click(screen.getByRole('button', { name: 'Run checks' }));
    await loggedOut('checks');
  });

  it('says so when the live feed is refused, and the feed stops asking', async () => {
    answers.loggedIn = false;
    window.history.replaceState(null, '', '/dashboard#logs');
    render(<Console />);
    await loggedOut('logs');
    const before = asked.filter((a) => a.url.startsWith('/api/logs')).length;
    expect(before).toBe(1);
    await new Promise((r) => setTimeout(r, 60));
    expect(asked.filter((a) => a.url.startsWith('/api/logs')).length).toBe(before);
  });

  it('says so at once when the status already tells that this browser is not logged in', async () => {
    answers.status = STRANGER;
    answers.loggedIn = false;
    window.history.replaceState(null, '', '/dashboard#address');
    render(<Console />);
    await loggedOut('address');
  });

  it('shows the closed notice, not a login, where Scrapy is closed', async () => {
    answers.status = CLOSED;
    window.history.replaceState(null, '', '/dashboard');
    render(<Console />);
    expect(await screen.findByRole('heading', { level: 2, name: 'This address is closed' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Log in' })).toBeNull();
    expect(linkTo('docs')).toBe('/docs');
    expect(linkTo('home page')).toBe('/');
  });
});

describe('the MCP doc in the dashboard of a personal Scrapy', () => {
  const openDoc = async (): Promise<void> => {
    await dashboard('#mcp-doc', 'MCP doc');
    await screen.findByRole('heading', { level: 2, name: '1. Connect your AI' });
  };

  it('shows YOUR_KEY in every example, and copies them with the real key', async () => {
    await openDoc();
    const u = user();
    for (const client of CLIENTS) {
      await u.click(screen.getByRole('tab', { name: client.label }));
      const panel = screen.getByRole('tabpanel');
      const buttons = within(panel).queryAllByRole('button', { name: 'Copy with your key' });
      const blocks = connectSnippets(ADDRESS, { key: true })[client.id].blocks;
      // In an agent's own code the key comes from the environment: there is nothing to fill in, and the button says "Copy".
      const withPlace = blocks.filter((b) => b.code.includes(KEY_PLACE));
      expect(buttons.length, client.id).toBe(withPlace.length);
      expect(withPlace.length > 0, client.id).toBe(client.id !== 'code');
      for (const [i, button] of buttons.entries()) {
        copied.length = 0;
        await u.click(button);
        expect(copied, client.id).toEqual([(withPlace[i]?.code ?? '').split(KEY_PLACE).join(KEY)]);
        expect(copied[0]).not.toContain(KEY_PLACE);
      }
    }
    expect(shown()).not.toContain(KEY);
  });

  it('copies proper JSON for Cursor, with the key in the header', async () => {
    await openDoc();
    const u = user();
    await u.click(within(screen.getByRole('tabpanel')).getByRole('button', { name: 'Copy with your key' }));
    expect(JSON.parse(copied[0] ?? '')).toEqual({ mcpServers: { scrapy: { url: ADDRESS, headers: { Authorization: `Bearer ${KEY}` } } } });
    expect(within(screen.getByRole('tabpanel')).getByRole('group').textContent).toContain('"Authorization": "Bearer YOUR_KEY"');
  });

  it('tells the owner that the buttons fill the key in', async () => {
    await openDoc();
    const section = screen.getByRole('heading', { level: 2, name: '1. Connect your AI' }).closest('section') as HTMLElement;
    expect(section.textContent).toContain('This Scrapy is personal: it answers only to its owner. So your AI also sends the owner\u2019s key.');
    expect(section.textContent).toContain('This Scrapy is personal. A request without the owner\'s key gets one sentence that says so, and nothing else.');
    expect(section.textContent).toContain('You are logged in, so the copy buttons below put your real key where the examples say YOUR_KEY. The key itself stays off the screen.');
    expect(section.textContent).toContain(`An app with no place for a header can carry the key at the end of the address instead: ${ADDRESS}?key=YOUR_KEY.`);
    expect(section.textContent).toContain('If the answer says "personal", the key is missing or wrong.');
    expect(section.textContent).not.toContain('Scrapy asks for no key and no account.');
    // Links to other parts stay inside the dashboard.
    expect(within(section).getByRole('link', { name: 'The address for your agent' }).getAttribute('href')).toBe('#address');
  });

  it('copies the check by hand with the key too', async () => {
    await openDoc();
    const u = user();
    const check = screen.getByRole('group', { name: 'A check by hand' });
    expect(check.textContent).toBe(handCheck(ADDRESS, { key: true }));
    expect(check.textContent).toContain("-H 'Authorization: Bearer YOUR_KEY'");
    const button = within(check.closest('.codeblock') as HTMLElement).getByRole('button', { name: 'Copy with your key' });
    await u.click(button);
    expect(copied).toEqual([handCheck(ADDRESS, { key: true }).replace(KEY_PLACE, KEY)]);
  });
});

describe('the docs page, for everybody', () => {
  const openDocs = async (hash = ''): Promise<void> => {
    window.history.replaceState(null, '', `/docs${hash}`);
    render(<DocsPage />);
  };

  it('reads which of the two pages an address names', () => {
    expect(docFromHash('')).toBe('mcp-doc');
    expect(docFromHash('#mcp-doc')).toBe('mcp-doc');
    expect(docFromHash('#docs-ai')).toBe('docs-ai');
    // Names from before, and names of parts that are not docs.
    expect(docFromHash('#docs')).toBe('mcp-doc');
    expect(docFromHash('#docs-humans')).toBe('mcp-doc');
    expect(docFromHash('#logs')).toBe('mcp-doc');
    expect(docFromHash('#constructor')).toBe('mcp-doc');
  });

  it('shows the MCP doc to a stranger, with a way to log in and none into the dashboard', async () => {
    answers.status = STRANGER;
    answers.loggedIn = false;
    await openDocs();
    expect(await screen.findByRole('heading', { level: 1, name: 'MCP doc' })).toBeTruthy();
    expect(await screen.findByRole('heading', { level: 2, name: '1. Connect your AI' })).toBeTruthy();
    const tabs = within(screen.getByRole('navigation', { name: 'Docs' })).getAllByRole('link');
    expect(tabs.map((t) => `${t.textContent}${t.getAttribute('aria-current') === 'page' ? '*' : ''}`)).toEqual(['MCP doc*', 'For the AI']);
    expect(linkTo('Log in')).toBe('/login');
    expect(screen.queryByRole('link', { name: 'Dashboard' })).toBeNull();
    expect(linkTo('Scrapy')).toBe('/');
    // Only what everybody may read was asked for.
    expect([...new Set(asked.map((a) => a.url))].sort()).toEqual(['/api/docs', '/api/status']);
    expect(shown()).toContain('Scrapy G - 1.0. These docs are open to everyone.');
  });

  it('gives a stranger the examples with YOUR_KEY, copied as they are shown', async () => {
    answers.status = STRANGER;
    await openDocs();
    await screen.findByRole('heading', { level: 2, name: '1. Connect your AI' });
    const u = user();
    const panel = screen.getByRole('tabpanel');
    expect(within(panel).queryByRole('button', { name: 'Copy with your key' })).toBeNull();
    await u.click(within(panel).getByRole('button', { name: 'Copy' }));
    expect(copied).toEqual([connectSnippets(ADDRESS, { key: true }).cursor.blocks[0]?.code]);
    expect(copied[0]).toContain('Bearer YOUR_KEY');
    const section = screen.getByRole('heading', { level: 2, name: '1. Connect your AI' }).closest('section') as HTMLElement;
    expect(section.textContent).toContain('In the examples below, put the key where they say YOUR_KEY.');
    expect(section.textContent).not.toContain('You are logged in');
  });

  it('sends links to parts of the dashboard to the dashboard', async () => {
    answers.status = STRANGER;
    await openDocs();
    await screen.findByRole('heading', { level: 2, name: '1. Connect your AI' });
    const main = screen.getByRole('main');
    const hrefs = within(main)
      .getAllByRole('link')
      .map((a) => a.getAttribute('href') ?? '');
    expect(hrefs).toContain('/dashboard#address');
    expect(hrefs).toContain('/dashboard#logs');
    expect(hrefs).toContain('/dashboard#checks');
    // No link names a part that this page does not have.
    const here = new Set(['#mcp-doc', '#docs-ai', ...[...main.querySelectorAll('[id]')].map((el) => `#${el.id}`)]);
    for (const href of hrefs.filter((h) => h.startsWith('#'))) expect(here.has(href), href).toBe(true);
  });

  it('opens the docs for the AI by address, and changes page without leaving', async () => {
    answers.status = STRANGER;
    await openDocs('#docs-ai');
    expect(await screen.findByRole('heading', { level: 1, name: 'Docs for the AI' })).toBeTruthy();
    const tabs = (): string[] => within(screen.getByRole('navigation', { name: 'Docs' })).getAllByRole('link').map((t) => `${t.textContent}${t.getAttribute('aria-current') === 'page' ? '*' : ''}`);
    expect(tabs()).toEqual(['MCP doc', 'For the AI*']);
    window.location.hash = '#mcp-doc';
    fireEvent(window, new HashChangeEvent('hashchange'));
    expect(await screen.findByRole('heading', { level: 1, name: 'MCP doc' })).toBeTruthy();
    expect(tabs()).toEqual(['MCP doc*', 'For the AI']);
    // The docs were fetched once for both pages.
    expect(requests('/api/docs').length).toBe(1);
    expect(nav.went).toEqual([]);
  });

  it('swaps an older name in the address for the page\'s own', async () => {
    await openDocs('#docs-humans');
    expect(await screen.findByRole('heading', { level: 1, name: 'MCP doc' })).toBeTruthy();
    expect(window.location.hash).toBe('#mcp-doc');
  });

  it('leads the owner, logged in, to the dashboard, and fills the key in', async () => {
    await openDocs();
    await screen.findByRole('heading', { level: 2, name: '1. Connect your AI' });
    expect(await screen.findByRole('link', { name: 'Dashboard' })).toBeTruthy();
    expect(linkTo('Dashboard')).toBe('/dashboard');
    expect(screen.queryByRole('link', { name: 'Log in' })).toBeNull();
    const u = user();
    await u.click(await within(screen.getByRole('tabpanel')).findByRole('button', { name: 'Copy with your key' }));
    expect(copied[0]).toContain(`Bearer ${KEY}`);
    expect(shown()).not.toContain(KEY);
  });

  it('says "no key" where Scrapy has no password, and leads into the dashboard', async () => {
    answers.status = OPEN;
    answers.docs = docsOf('open');
    await openDocs();
    const section = (await screen.findByRole('heading', { level: 2, name: '1. Connect your AI' })).closest('section') as HTMLElement;
    expect(section.textContent).toContain('Scrapy asks for no key and no account.');
    expect(section.textContent).not.toContain('personal');
    expect(within(screen.getByRole('tabpanel')).getByRole('group').textContent).toBe(connectSnippets(ADDRESS).cursor.blocks[0]?.code);
    expect(shown()).not.toContain(KEY_PLACE);
    expect(linkTo('Dashboard')).toBe('/dashboard');
  });

  it('can be read where Scrapy is closed, with no way in', async () => {
    answers.status = CLOSED;
    answers.docs = docsOf('closed');
    await openDocs();
    expect(await screen.findByRole('heading', { level: 2, name: '1. Connect your AI' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Log in' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Dashboard' })).toBeNull();
  });

  it('says so when the docs cannot be loaded, and tries again', async () => {
    answers.status = STRANGER;
    answers.docs = 'down';
    await openDocs();
    const retry = await screen.findByRole('button', { name: 'Try again' });
    answers.docs = docsOf('personal');
    await user().click(retry);
    expect(await screen.findByRole('heading', { level: 2, name: '1. Connect your AI' })).toBeTruthy();
    expect(requests('/api/docs').length).toBe(2);
  });
});

describe('the examples for a personal Scrapy', () => {
  const withKey = connectSnippets(ADDRESS, { key: true });

  it('send the key in every example, the way each app wants it', () => {
    expect(JSON.parse(withKey.cursor.blocks[0]?.code ?? '')).toEqual({ mcpServers: { scrapy: { url: ADDRESS, headers: { Authorization: 'Bearer YOUR_KEY' } } } });
    expect(withKey.claude.blocks[0]?.code).toBe(`claude mcp add --transport http scrapy ${ADDRESS} \\\n  --header "Authorization: Bearer YOUR_KEY"`);
    expect(JSON.parse(withKey.vscode.blocks[0]?.code ?? '')).toEqual({ mcpServers: { scrapy: { type: 'http', url: ADDRESS, headers: { Authorization: 'Bearer YOUR_KEY' } } } });
    // mcp-remote takes a header as one word. The space of "Bearer KEY" is kept out of it by an environment variable.
    expect(JSON.parse(withKey.local.blocks[0]?.code ?? '')).toEqual({
      mcpServers: { scrapy: { command: 'npx', args: ['-y', 'mcp-remote', ADDRESS, '--header', 'Authorization:${SCRAPY_AUTH}'], env: { SCRAPY_AUTH: 'Bearer YOUR_KEY' } } },
    });
    // In code the key comes from the environment, not from the file.
    expect(withKey.code.where).toContain('Put your key in the environment variable SCRAPY_KEY, not in the code.');
    for (const block of withKey.code.blocks) {
      expect(block.code).toContain('headers: { Authorization: `Bearer ${process.env.SCRAPY_KEY}` }');
      expect(block.code).not.toContain(KEY_PLACE);
    }
  });

  it('send both the key and Vercel\'s secret where both are needed', () => {
    const both = connectSnippets(ADDRESS, { key: true, secret: true });
    expect(JSON.parse(both.cursor.blocks[0]?.code ?? '')).toEqual({ mcpServers: { scrapy: { url: ADDRESS, headers: { Authorization: 'Bearer YOUR_KEY', 'x-vercel-protection-bypass': 'YOUR_SECRET' } } } });
    expect(both.claude.blocks[0]?.code).toBe(`claude mcp add --transport http scrapy ${ADDRESS} \\\n  --header "Authorization: Bearer YOUR_KEY" \\\n  --header "x-vercel-protection-bypass: YOUR_SECRET"`);
    expect(both.code.where).toContain("Put your key in the environment variable SCRAPY_KEY and Vercel's secret in SCRAPY_SECRET, not in the code.");
    expect(both.code.blocks[0]?.code).toContain("    headers: {\n      Authorization: `Bearer ${process.env.SCRAPY_KEY}`,\n      'x-vercel-protection-bypass': process.env.SCRAPY_SECRET,\n    },");
    expect(handCheck(ADDRESS, { key: true, secret: true }).split('\n')).toEqual([
      `curl -s -X POST ${ADDRESS} \\`,
      "  -H 'Content-Type: application/json' \\",
      "  -H 'Accept: application/json, text/event-stream' \\",
      "  -H 'Authorization: Bearer YOUR_KEY' \\",
      "  -H 'x-vercel-protection-bypass: YOUR_SECRET' \\",
      `  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
    ]);
  });

  it('send no key where none is needed', () => {
    for (const client of CLIENTS) for (const block of connectSnippets(ADDRESS)[client.id].blocks) expect(block.code).not.toMatch(/YOUR_KEY|SCRAPY_KEY|Authorization/);
    expect(handCheck(ADDRESS)).not.toContain('Authorization');
  });
});

describe('the login form', () => {
  const field = (): HTMLInputElement => screen.getByLabelText('Password') as HTMLInputElement;
  const message = (): string => screen.getByRole('alert').textContent ?? '';

  it('asks for the password when none was typed, and sends nothing', async () => {
    render(<LoginForm />);
    expect(document.activeElement).toBe(field());
    const u = user();
    await u.click(screen.getByRole('button', { name: 'Log in' }));
    expect(message()).toBe('Type the password.');
    await u.type(field(), '   ');
    await u.click(screen.getByRole('button', { name: 'Log in' }));
    expect(message()).toBe('Type the password.');
    expect(asked).toEqual([]);
    expect(nav.went).toEqual([]);
  });

  it('sends the password to Scrapy and goes on to the dashboard', async () => {
    window.history.replaceState(null, '', '/login');
    render(<LoginForm />);
    const u = user();
    await u.type(field(), `${PASSWORD}{Enter}`);
    await waitFor(() => expect(nav.went).toEqual(['/dashboard']));
    // The password goes to the login address, and nowhere else. Then one look: did the browser keep the login?
    expect(asked).toEqual([
      { url: '/api/login', method: 'POST', body: { password: PASSWORD } },
      { url: '/api/status', method: 'GET', body: undefined },
    ]);
    expect(message()).toBe('');
  });

  it('says so when the password is right and the browser does not keep the login', async () => {
    // Inside another site's page, a browser drops the cookie. Scrapy then still sees a stranger.
    answers.status = STRANGER;
    window.history.replaceState(null, '', '/login#logs');
    render(<LoginForm />);
    const u = user();
    await u.type(field(), `${PASSWORD}{Enter}`);
    await waitFor(() => expect(message()).toContain('The password is right, but this browser did not keep the login.'));
    expect(message()).toContain("That happens when Scrapy is shown inside another site's page, or when the browser refuses cookies.");
    const link = screen.getByRole('link', { name: 'Open Scrapy in a tab of its own' });
    expect(link.getAttribute('href')).toBe('/login');
    expect(link.getAttribute('target')).toBe('_blank');
    // The page stays, instead of going to a dashboard that would send it straight back.
    expect(nav.went).toEqual([]);
    expect((screen.getByRole('button', { name: 'Log in' }) as HTMLButtonElement).disabled).toBe(false);
    // The password itself was not wrong: the field is not marked as wrong.
    expect(field().getAttribute('aria-invalid')).toBe('false');
    expect(field().getAttribute('aria-describedby')).toBe('login-error');

    // Trying again where the login is kept goes on, and the message goes away first.
    answers.status = OWNER;
    await u.click(screen.getByRole('button', { name: 'Log in' }));
    await waitFor(() => expect(nav.went).toEqual(['/dashboard#logs']));
    expect(message()).toBe('');
  });

  it('goes on to the dashboard when that look gets no answer', async () => {
    let logins = 0;
    answers.login = () => {
      logins += 1;
      // From now on nothing answers: the look at the status fails.
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new TypeError('offline');
        }),
      );
      return Response.json({ ok: true });
    };
    render(<LoginForm />);
    await user().type(field(), `${PASSWORD}{Enter}`);
    await waitFor(() => expect(nav.went).toEqual(['/dashboard']));
    expect(logins).toBe(1);
  });

  it('goes on to the part of the dashboard that was asked for', async () => {
    window.history.replaceState(null, '', '/login#logs');
    render(<LoginForm />);
    await user().type(field(), `${PASSWORD}{Enter}`);
    await waitFor(() => expect(nav.went).toEqual(['/dashboard#logs']));
  });

  it('says what Scrapy answered to a wrong password, and stays', async () => {
    answers.login = () => Response.json({ ok: false, error: 'That is not the password.' }, { status: 401 });
    render(<LoginForm />);
    const u = user();
    expect(field().getAttribute('aria-invalid')).toBe('false');
    await u.type(field(), 'a wrong password{Enter}');
    await waitFor(() => expect(message()).toBe('That is not the password.'));
    expect(field().getAttribute('aria-invalid')).toBe('true');
    expect(field().getAttribute('aria-describedby')).toBe('login-error');
    expect(screen.getByRole('alert').id).toBe('login-error');
    expect(nav.went).toEqual([]);
    // What was typed is still there, and the form can be sent again.
    expect(field().value).toBe('a wrong password');
    expect((screen.getByRole('button', { name: 'Log in' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('says when to try again after too many wrong passwords', async () => {
    answers.login = () => Response.json({ ok: false, error: 'Too many wrong passwords. Try again in about 15 minutes.' }, { status: 429 });
    render(<LoginForm />);
    await user().type(field(), 'whatever it is{Enter}');
    await waitFor(() => expect(message()).toBe('Too many wrong passwords. Try again in about 15 minutes.'));
  });

  it('says so when the request does not get through, or the answer is not readable', async () => {
    answers.login = () => {
      throw new TypeError('offline');
    };
    render(<LoginForm />);
    const u = user();
    await u.type(field(), 'whatever it is{Enter}');
    await waitFor(() => expect(message()).toBe('The request did not get through. Try again.'));
    answers.login = () => new Response('<html>bad gateway</html>', { status: 502 });
    await u.click(screen.getByRole('button', { name: 'Log in' }));
    await waitFor(() => expect(message()).toBe('The login did not work (502). Try again.'));
    expect(nav.went).toEqual([]);
  });

  it('does not go on when the answer is "ok" in status only', async () => {
    // An answer from something that is not Scrapy, like a sign-in page of a network, must not count as a login.
    answers.login = () => new Response('<html>welcome</html>', { status: 200 });
    render(<LoginForm />);
    await user().type(field(), 'whatever it is{Enter}');
    await waitFor(() => expect(message()).toBe('The login did not work (200). Try again.'));
    expect(nav.went).toEqual([]);
  });

  it('shows that it is busy, and sends the password once', async () => {
    let answer: (response: Response) => void = () => undefined;
    answers.login = () => new Promise<Response>((resolve) => (answer = resolve));
    render(<LoginForm />);
    const u = user();
    await u.type(field(), PASSWORD);
    await u.click(screen.getByRole('button', { name: 'Log in' }));
    const busy = (await screen.findByRole('button', { name: 'Logging in...' })) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    await u.type(field(), '{Enter}{Enter}');
    expect(requests('/api/login').length).toBe(1);
    answer(Response.json({ ok: true }));
    await waitFor(() => expect(nav.went).toEqual(['/dashboard']));
  });

  it('hides the password, and shows it on request', async () => {
    render(<LoginForm />);
    const u = user();
    await u.type(field(), 'abc');
    expect(field().type).toBe('password');
    expect(field().getAttribute('autocomplete')).toBe('current-password');
    await u.click(screen.getByRole('checkbox', { name: 'Show the password' }));
    expect(field().type).toBe('text');
    expect(field().value).toBe('abc');
    await u.click(screen.getByRole('checkbox', { name: 'Show the password' }));
    expect(field().type).toBe('password');
  });
});

describe('links saved before the release', () => {
  it('lead to where each part is now', () => {
    expect(newHome('#try')).toBe('/dashboard#try');
    expect(newHome('#address')).toBe('/dashboard#address');
    expect(newHome('#logs')).toBe('/dashboard#logs');
    expect(newHome('#checks')).toBe('/dashboard#checks');
    expect(newHome('#mcp-doc')).toBe('/docs#mcp-doc');
    expect(newHome('#docs-ai')).toBe('/docs#docs-ai');
    // Names the docs had before.
    expect(newHome('#docs')).toBe('/docs#mcp-doc');
    expect(newHome('#docs-humans')).toBe('/docs#mcp-doc');
  });

  it('stay on the home page when they name no part', () => {
    expect(newHome('')).toBeNull();
    expect(newHome('#')).toBeNull();
    expect(newHome('#hero-title')).toBeNull();
    expect(newHome('#no-such-part')).toBeNull();
    expect(newHome('#constructor')).toBeNull();
    expect(newHome('#toString')).toBeNull();
  });

  it('are followed by the home page, in place of it', () => {
    window.history.replaceState(null, '', '/#try');
    render(<OldLinks />);
    expect(nav.instead).toEqual(['/dashboard#try']);
    expect(nav.went).toEqual([]);
    cleanup();
    nav.instead.length = 0;
    window.history.replaceState(null, '', '/');
    render(<OldLinks />);
    window.history.replaceState(null, '', '/#tools-title');
    render(<OldLinks />);
    expect(nav.instead).toEqual([]);
  });
});

describe('the home page', () => {
  const home = async (): Promise<void> => {
    render(await HomePage());
  };
  const buttons = (): string[] => [...document.querySelectorAll('.cta a')].map((a) => `${a.textContent?.trim()} -> ${a.getAttribute('href')}`);
  const bar = (): string[] => within(screen.getByRole('navigation', { name: 'Pages' })).getAllByRole('link').map((a) => `${a.textContent?.trim()} -> ${a.getAttribute('href')}`);
  const note = (): string => document.querySelector('.hero-note')?.textContent ?? '';

  it('says what Scrapy is, names the release, and quotes the running Scrapy', async () => {
    await home();
    expect(screen.getByRole('heading', { level: 1, name: 'The web, for your AI.' })).toBeTruthy();
    expect(shown()).toContain('Release G - 1.0');
    expect(screen.getByRole('heading', { level: 3, name: 'Search the web' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3, name: 'Read a web page' })).toBeTruthy();
    expect(shown()).toContain('These 2 tools are ready in release G - 1.0. Coming next: extract_text, extract_images, extract_design, deep_crawl, crawl_status.');
    // Numbers come from the running Scrapy, as on the docs pages.
    const f = docsPayload().facts;
    expect(shown()).toContain(`Your AI gets ${f.search.defaultResults} links, or up to ${f.search.maxResults} when it asks for more.`);
    expect(shown()).toContain(`A long page comes in parts of about ${f.page.partChars.toLocaleString('en-US')} characters.`);
    expect(shown()).toContain(`gets company after ${f.page.hedgeSeconds} seconds. Anything asked in the last ${f.search.memoryMinutes} minutes is answered from memory.`);
    expect(shown()).toContain('Tavily, Exa, Parallel, Firecrawl and Jina Reader each have a door that needs no account and no payment. Scrapy uses all 5');
    expect(linkTo('/llms.txt')).toBe('/llms.txt');
  });

  it('offers a stranger at a personal Scrapy the login and the docs', async () => {
    process.env.SCRAPY_PASSWORD = PASSWORD;
    await home();
    expect(buttons()).toEqual(['Log in -> /login', 'Read the docs -> /docs']);
    expect(bar()).toEqual(['Docs -> /docs', 'Log in -> /login']);
    expect(note()).toBe('This Scrapy is personal. It answers only to its owner. The docs are open to everyone.');
  });

  it('leads the owner, logged in, straight to the dashboard', async () => {
    process.env.SCRAPY_PASSWORD = PASSWORD;
    nav.cookie = newSession() ?? '';
    await home();
    expect(buttons()).toEqual(['Open the dashboard -> /dashboard', 'Read the docs -> /docs']);
    expect(bar()).toEqual(['Docs -> /docs', 'Dashboard -> /dashboard']);
    expect(note()).toBe('This Scrapy is personal. It answers only to its owner, and you are logged in. The docs are open to everyone.');
  });

  it('does not take a pass that does not fit, or one made for another password', async () => {
    process.env.SCRAPY_PASSWORD = 'the password before this one';
    const old = newSession() ?? '';
    process.env.SCRAPY_PASSWORD = PASSWORD;
    for (const cookie of [old, '', 'x', `${newSession() ?? ''}x`]) {
      cleanup();
      nav.cookie = cookie;
      await home();
      expect(buttons(), cookie.slice(0, 12)).toEqual(['Log in -> /login', 'Read the docs -> /docs']);
    }
  });

  it('says that there is nothing to log in to where there is no password', async () => {
    await home();
    expect(buttons()).toEqual(['Open the dashboard -> /dashboard', 'Read the docs -> /docs']);
    expect(note()).toContain('This copy of Scrapy has no password, so there is nothing to log in to');
    expect(note()).toContain('SCRAPY_PASSWORD');
    // A pass from somewhere means nothing here.
    cleanup();
    nav.cookie = 'anything';
    await home();
    expect(note()).not.toContain('logged in');
  });

  it('has no way in where Scrapy is closed, and says how its owner opens it', async () => {
    process.env.VERCEL_ENV = 'production';
    await home();
    expect(buttons()).toEqual(['Read the docs -> /docs']);
    expect(bar()).toEqual(['Docs -> /docs']);
    expect(note()).toContain('This address is closed. Its owner has not opened it yet, so it answers no calls. The docs can be read all the same.');
    expect(note()).toContain('give it a password with the setting SCRAPY_PASSWORD');
  });

  it('says so when the password is too short for anybody to log in', async () => {
    process.env.SCRAPY_PASSWORD = 'short';
    await home();
    expect(buttons()).toEqual(['Read the docs -> /docs']);
    expect(note()).toBe('Nobody can log in right now. The password set for this Scrapy is too short. If this is your Scrapy: set one of at least 10 characters, in the setting SCRAPY_PASSWORD.');
  });
});

describe('the login page and the dashboard page', () => {
  it('ask a stranger at a personal Scrapy for the password', async () => {
    process.env.SCRAPY_PASSWORD = PASSWORD;
    render(await LoginPage());
    expect(screen.getByRole('heading', { level: 1, name: 'Log in' })).toBeTruthy();
    expect(screen.getByLabelText('Password')).toBeTruthy();
    expect(shown()).toContain('This Scrapy is personal. Its password opens the dashboard.');
    expect(linkTo('Home page')).toBe('/');
    expect(linkTo('Docs')).toBe('/docs');
    await expect(DashboardPage()).rejects.toThrow('sent to /login');
  });

  it('let the owner through who is logged in', async () => {
    process.env.SCRAPY_PASSWORD = PASSWORD;
    nav.cookie = newSession() ?? '';
    await expect(LoginPage()).rejects.toThrow('sent to /dashboard');
    render(await DashboardPage());
    expect(await screen.findByRole('button', { name: 'Open menu' })).toBeTruthy();
  });

  it('do not let a pass through that does not fit', async () => {
    process.env.SCRAPY_PASSWORD = PASSWORD;
    for (const cookie of ['', 'nonsense', `${newSession() ?? ''}0`, `1.${Date.now() + 1_000_000}.aaaa.bbbb`]) {
      nav.cookie = cookie;
      await expect(DashboardPage(), cookie.slice(0, 12)).rejects.toThrow('sent to /login');
    }
    expect(SESSION_COOKIE).toBe('scrapy_session');
  });

  it('have nothing to ask where there is no password: the dashboard opens', async () => {
    await expect(LoginPage()).rejects.toThrow('sent to /dashboard');
    answers.status = OPEN;
    render(await DashboardPage());
    expect(await screen.findByRole('button', { name: 'Open menu' })).toBeTruthy();
  });

  it('say that the address is closed, with no form', async () => {
    process.env.VERCEL_ENV = 'production';
    render(await LoginPage());
    expect(shown()).toContain('This address is closed. Its owner has not opened it yet, so there is nothing to log in to.');
    expect(screen.queryByLabelText('Password')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Log in' })).toBeNull();
  });

  it('say so when the password is too short, with no form', async () => {
    process.env.SCRAPY_PASSWORD = 'short';
    render(await LoginPage());
    expect(screen.getByRole('alert').textContent).toBe('The password set for this Scrapy is too short. If this is your Scrapy: set one of at least 10 characters, in the setting SCRAPY_PASSWORD.');
    expect(screen.queryByLabelText('Password')).toBeNull();
    // And the dashboard stays shut: a short password must not open anything.
    await expect(DashboardPage()).rejects.toThrow('sent to /login');
  });
});
