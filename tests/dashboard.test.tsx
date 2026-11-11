// @vitest-environment jsdom
/**
 * The dashboard and its menu drawer, in a browser-like environment.
 * The three addresses the page calls (/api/status, /api/check, /api/try) are stand-ins.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CheckPage from '@/app/page';
import { Drawer } from '@/app/ui/Drawer';
import { MENU, viewFromHash } from '@/app/ui/menu';

const STATUS = {
  name: 'scrapy',
  version: '0.1.0',
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

const REPORT = {
  at: '2026-11-11T20:00:00.000Z',
  version: '0.1.0',
  mode: 'safe',
  region: 'iad1',
  helpers: [
    { id: 'tavily', name: 'Tavily', job: 'search', answers: true, ms: 900, note: '5 results. First: Center a div' },
    { id: 'jina', name: 'Jina Reader', job: 'page', answers: true, ms: 150, note: 'read example.com (911 characters)' },
  ],
  speed: [{ what: 'search_web', ok: true, ms: 650, targetMs: 3000, note: '8 results from tavily + exa' }],
  fallback: [{ what: 'fetch_url with jina switched off', ok: true, ms: 4300, note: 'loaded by Firecrawl' }],
  safe: { applies: true, ok: true, note: 'Only free helpers were contacted: r.jina.ai.' },
  hosts: ['r.jina.ai'],
  contacts: [{ purpose: 'jina page', method: 'GET', address: 'https://r.jina.ai/https://example.com/', host: 'r.jina.ai', status: 200, ms: 150 }],
  tookMs: 5000,
  reused: false,
};

/** What a contact looks like when no answer arrived at all (seen for real where there is no internet access). */
const NO_ANSWER = { purpose: 'tavily search', method: 'POST', address: 'https://api.tavily.com/search', host: 'api.tavily.com', status: null, ms: 12, note: 'ECONNRESET' };

let asked: string[] = [];
let historyLength = 0;
const scrollTo = vi.fn();

function standIns(answers: { status?: unknown; report?: unknown } = {}): void {
  asked = [];
  scrollTo.mockClear();
  // The test environment has no real scrolling.
  vi.stubGlobal('scrollTo', scrollTo);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      asked.push(url);
      if (url.endsWith('/api/status')) return Response.json(answers.status ?? STATUS);
      if (url.endsWith('/api/check')) return Response.json(answers.report ?? REPORT);
      if (url.endsWith('/api/try')) return Response.json({ ok: true, text: 'Title: Example Domain', trace: { totalMs: 200, cache: 'miss', steps: [], contacts: [], hosts: [] } });
      return new Response('not found', { status: 404 });
    }),
  );
}

const menuButton = (): HTMLElement => screen.getByRole('button', { name: 'Open menu' });
const title = (name: string): Promise<HTMLElement> => screen.findByRole('heading', { level: 1, name });

async function openMenu(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(menuButton());
  return screen.getByRole('dialog', { name: 'Menu' });
}

beforeEach(() => {
  // Back to the plain address, without the "address changed" event that setting location.hash would send late.
  window.history.replaceState(null, '', '/');
  historyLength = window.history.length;
  standIns();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the menu list', () => {
  it('has Dashboard as its first section, with the three parts in order', () => {
    expect(MENU[0].title).toBe('Dashboard');
    expect(MENU[0].items.map((item) => item.label)).toEqual(['Run checks', 'The address for your agent', 'Try a tool']);
  });

  it('reads the part from the page address, and falls back to the first part', () => {
    expect(viewFromHash('#try')).toBe('try');
    expect(viewFromHash('#address')).toBe('address');
    expect(viewFromHash('')).toBe('checks');
    expect(viewFromHash('#no-such-part')).toBe('checks');
  });
});

describe('the dashboard', () => {
  it('starts on "Run checks", with the menu closed and out of reach', async () => {
    render(<CheckPage />);
    await title('Run checks');
    expect(screen.getByRole('button', { name: 'Run checks' })).toBeTruthy();
    expect(menuButton().getAttribute('aria-expanded')).toBe('false');
    expect(menuButton().getAttribute('aria-controls')).toBe('menu');
    expect(menuButton().getAttribute('aria-haspopup')).toBe('dialog');
    expect(await screen.findByText('position: safe')).toBeTruthy();
    // Closed: no screen reader and no keyboard can get into it.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Try a tool' })).toBeNull();
    expect(document.getElementById('menu')?.hasAttribute('inert')).toBe(true);
    expect(screen.getByRole('main').hasAttribute('inert')).toBe(false);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('opens the drawer with the Dashboard section and its three entries', async () => {
    const user = userEvent.setup();
    render(<CheckPage />);
    const menu = await openMenu(user);

    expect(menuButton().getAttribute('aria-expanded')).toBe('true');
    expect(menu.hasAttribute('inert')).toBe(false);
    expect(within(menu).getByRole('heading', { name: 'Dashboard' })).toBeTruthy();
    const links = within(within(menu).getByRole('list', { name: 'Dashboard' })).getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual(['Run checks', 'The address for your agent', 'Try a tool']);
    expect(links.map((l) => l.getAttribute('href'))).toEqual(['#checks', '#address', '#try']);
    // The part that is showing is marked.
    expect(links.map((l) => l.getAttribute('aria-current'))).toEqual(['page', null, null]);
    // The keyboard is inside the menu; the page behind does not scroll and is out of reach.
    expect(document.activeElement).toBe(within(menu).getByRole('button', { name: 'Close menu' }));
    expect(document.body.style.overflow).toBe('hidden');
    expect(document.querySelector('main')?.hasAttribute('inert')).toBe(true);
    expect(await within(menu).findByText('Scrapy version 0.1.0')).toBeTruthy();
  });

  it('shows the chosen part, closes the drawer, and gives the keyboard back to the menu button', async () => {
    const user = userEvent.setup();
    render(<CheckPage />);
    const menu = await openMenu(user);
    await user.click(within(menu).getByRole('link', { name: 'Try a tool' }));

    await title('Try a tool');
    expect(window.location.hash).toBe('#try');
    expect(screen.getByLabelText('Question')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Run checks' })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(menuButton());
    // The page behind scrolls again, and is as wide as it was.
    expect(document.body.style.overflow).toBe('');
    expect(document.body.style.paddingRight).toBe('');
    expect(screen.getByRole('main').hasAttribute('inert')).toBe(false);
    // The new part starts at the top of the page.
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith(0, 0);

    // Opened again, the menu marks the new part.
    const again = await openMenu(user);
    expect(within(again).getByRole('link', { name: 'Try a tool' }).getAttribute('aria-current')).toBe('page');
    await user.click(within(again).getByRole('link', { name: 'The address for your agent' }));
    await title('The address for your agent');
    expect(screen.getByText('http://localhost:3000/api/mcp')).toBeTruthy();
    expect(await screen.findByText(/Tools ready now: search_web, fetch_url\./)).toBeTruthy();
  });

  it('closes with the Escape key, with its close button, and with a click outside', async () => {
    const user = userEvent.setup();
    render(<CheckPage />);

    await openMenu(user);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(menuButton());

    const second = await openMenu(user);
    await user.click(within(second).getByRole('button', { name: 'Close menu' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(menuButton());

    await openMenu(user);
    await user.click(screen.getByTestId('menu-backdrop'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(menuButton().getAttribute('aria-expanded')).toBe('false');
    // Closing without choosing changes nothing.
    expect(screen.getByRole('heading', { level: 1, name: 'Run checks' })).toBeTruthy();
    expect(window.location.hash).toBe('');
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('gives the keyboard back to the menu button even in a browser where a click does not focus a button', async () => {
    const user = userEvent.setup();
    render(<CheckPage />);
    // A bare click: unlike a real press in most browsers, it leaves the keyboard where it was.
    fireEvent.click(menuButton());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close menu' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(menuButton());
  });

  it('keeps the Tab key inside the open drawer', async () => {
    const user = userEvent.setup();
    render(<CheckPage />);
    const menu = await openMenu(user);
    const close = within(menu).getByRole('button', { name: 'Close menu' });
    const last = within(menu).getByRole('link', { name: 'Try a tool' });

    await user.tab({ shift: true });
    expect(document.activeElement).toBe(last);
    await user.tab();
    expect(document.activeElement).toBe(close);
    await user.tab();
    expect(document.activeElement).toBe(within(menu).getByRole('link', { name: 'Run checks' }));
  });

  it('opens the part named in the page address, and follows it when it changes', async () => {
    window.history.replaceState(null, '', '/#address');
    render(<CheckPage />);
    await title('The address for your agent');
    // Arriving on a part is not a change of part: the page is not moved.
    expect(scrollTo).not.toHaveBeenCalled();

    // The back and forward buttons, or a typed address, change the part too.
    window.location.hash = '#try';
    await title('Try a tool');
    expect(scrollTo).toHaveBeenCalledTimes(1);

    window.location.hash = '#no-such-part';
    await title('Run checks');
  });

  it('only closes the menu when the part that is showing is chosen again', async () => {
    const user = userEvent.setup();
    render(<CheckPage />);
    await user.click(within(await openMenu(user)).getByRole('link', { name: 'Run checks' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(menuButton());
    expect(window.location.hash).toBe('');
    expect(window.history.length).toBe(historyLength);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { level: 1, name: 'Run checks' })).toBeTruthy();
  });

  it('keeps what was checked while another part is showing', async () => {
    const user = userEvent.setup();
    render(<CheckPage />);
    await user.click(screen.getByRole('button', { name: 'Run checks' }));
    expect(await screen.findByText('Jina Reader')).toBeTruthy();
    expect(screen.getByText('loaded by Firecrawl')).toBeTruthy();

    await user.click(within(await openMenu(user)).getByRole('link', { name: 'Try a tool' }));
    await title('Try a tool');
    expect(screen.queryByText('Jina Reader')).toBeNull();
    await user.clear(screen.getByLabelText('Question'));
    await user.type(screen.getByLabelText('Question'), 'my own question');

    await user.click(within(await openMenu(user)).getByRole('link', { name: 'Run checks' }));
    await title('Run checks');
    expect(screen.getByText('Jina Reader')).toBeTruthy();
    expect(asked.filter((url) => url.endsWith('/api/check'))).toHaveLength(1);

    await user.click(within(await openMenu(user)).getByRole('link', { name: 'Try a tool' }));
    await title('Try a tool');
    expect((screen.getByLabelText('Question') as HTMLInputElement).value).toBe('my own question');
  });

  it('says so plainly when not one address answered', async () => {
    const unreachable = (id: string, name: string, job: string) => ({ id, name, job, answers: false, ms: 20, note: 'could not be reached (ECONNRESET)' });
    standIns({
      report: {
        ...REPORT,
        helpers: [unreachable('tavily', 'Tavily', 'search'), unreachable('jina', 'Jina Reader', 'page')],
        contacts: [NO_ANSWER, { ...NO_ANSWER, purpose: 'jina page', method: 'GET', address: 'https://r.jina.ai/https://example.com/', host: 'r.jina.ai' }],
      },
    });
    const user = userEvent.setup();
    render(<CheckPage />);
    await user.click(screen.getByRole('button', { name: 'Run checks' }));
    expect(await screen.findByText(/None of the addresses Scrapy contacted answered\. This copy of Scrapy seems to have no internet access/)).toBeTruthy();
  });

  it('does not say that when some addresses answer, or when everything works', async () => {
    const user = userEvent.setup();
    standIns({ report: { ...REPORT, contacts: [NO_ANSWER, ...REPORT.contacts] } });
    render(<CheckPage />);
    await user.click(screen.getByRole('button', { name: 'Run checks' }));
    await screen.findByText('Jina Reader');
    expect(screen.queryByText(/seems to have no internet access/)).toBeNull();
    cleanup();

    standIns();
    render(<CheckPage />);
    await user.click(screen.getByRole('button', { name: 'Run checks' }));
    await screen.findByText('Jina Reader');
    expect(screen.queryByText(/seems to have no internet access/)).toBeNull();
  });

  it('shows no menu at an address where Scrapy is closed', async () => {
    standIns({ status: { name: 'scrapy', version: '0.1.0', open: false, message: 'Scrapy is closed at this address. Its owner has not opened it yet.' } });
    render(<CheckPage />);
    expect(await screen.findByRole('heading', { name: 'This address is closed' })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Open menu' })).toBeNull());
    expect(screen.queryByRole('button', { name: 'Run checks' })).toBeNull();
    expect(document.getElementById('menu')).toBeNull();
  });
});

describe('the drawer', () => {
  it('shows every section it is given, each with its own title and entries', () => {
    const sections = [
      { title: 'Dashboard', items: [{ id: 'checks', label: 'Run checks', about: '' }] },
      {
        title: 'Second section',
        items: [
          { id: 'one', label: 'First entry', about: '' },
          { id: 'two', label: 'Second entry', about: '' },
        ],
      },
    ];
    render(<Drawer id="menu" open onClose={() => {}} sections={sections} current="two" />);
    const menu = screen.getByRole('dialog', { name: 'Menu' });
    expect(within(menu).getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['Dashboard', 'Second section']);
    expect(within(within(menu).getByRole('list', { name: 'Dashboard' })).getAllByRole('link').map((l) => l.textContent)).toEqual(['Run checks']);
    const second = within(within(menu).getByRole('list', { name: 'Second section' })).getAllByRole('link');
    expect(second.map((l) => l.textContent)).toEqual(['First entry', 'Second entry']);
    expect(second.map((l) => l.getAttribute('aria-current'))).toEqual([null, 'page']);
  });

  it('tells its owner to close it, and does not close itself', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Drawer id="menu" open onClose={onClose} sections={MENU} current="checks" />);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog', { name: 'Menu' })).toBeTruthy();
  });
});
