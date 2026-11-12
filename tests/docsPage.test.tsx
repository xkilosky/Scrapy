// @vitest-environment jsdom
/**
 * The two Docs pages, in a browser-like environment.
 *
 * What the pages are given is made by the real code (docsPayload), so these
 * tests also hold the pages and the server together. Only the numbers are
 * changed here and there, to prove that the pages quote what they are given
 * and have nothing typed in.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CheckPage from '@/app/page';
import { CLIENTS, connectSnippets, handCheck } from '@/app/ui/McpDoc';
import { MENU, isOtherName, viewFromHash } from '@/app/ui/menu';
import { docsPayload, type DocsPayload } from '@/lib/docs';

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

/** jsdom serves the page from here. */
const ORIGIN = 'http://localhost:3000';
const ADDRESS = `${ORIGIN}/api/mcp`;
const SECRET = 'x-vercel-protection-bypass';

let payload: DocsPayload;
let docsAnswer: 'ok' | 'down' = 'ok';
let asked: string[] = [];
let copied: string[] = [];

/** A fresh copy of what Scrapy hands the Docs pages, with changes. */
function given(change: (p: DocsPayload) => void = () => undefined): void {
  payload = JSON.parse(JSON.stringify(docsPayload())) as DocsPayload;
  change(payload);
}

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  asked = [];
  copied = [];
  docsAnswer = 'ok';
  given();
  vi.stubGlobal('scrollTo', vi.fn());
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      asked.push(url);
      if (url.endsWith('/api/status')) return Response.json(STATUS);
      if (url.endsWith('/api/docs')) return docsAnswer === 'ok' ? Response.json(payload) : new Response('no', { status: 500 });
      if (url.startsWith('/api/logs')) return Response.json({ open: true, on: true, rev: '0', entries: [], keep: 100, hours: 24, where: 'memory' });
      return new Response('not found', { status: 404 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** A user, with a clipboard that remembers what was copied. */
function user(): ReturnType<typeof userEvent.setup> {
  const u = userEvent.setup();
  vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(async (text: string) => {
    copied.push(text);
  });
  return u;
}

async function open(hash: string, heading: string): Promise<void> {
  window.history.replaceState(null, '', `/${hash}`);
  render(<CheckPage />);
  await screen.findByRole('heading', { level: 1, name: heading });
}

const openMcpDoc = async (): Promise<void> => {
  await open('#mcp-doc', 'MCP doc');
  await screen.findByRole('heading', { level: 2, name: '1. Connect your AI' });
};
const openAi = async (): Promise<void> => {
  await open('#docs-ai', 'Docs for the AI');
  await screen.findByRole('heading', { level: 2, name: 'How your AI gets these rules' });
};

/** The card (section) that a heading belongs to. */
function card(name: string | RegExp): HTMLElement {
  const section = screen.getByRole('heading', { level: 2, name }).closest('section');
  if (!section) throw new Error(`no section for ${String(name)}`);
  return section;
}

const codeOf = (label: string | RegExp): string => screen.getByLabelText(label).textContent ?? '';
const docsCalls = (): number => asked.filter((u) => u.endsWith('/api/docs')).length;

describe('the menu', () => {
  it('has a third section, Docs, with the MCP doc and a page for the AI', () => {
    expect(MENU.map((section) => section.title)).toEqual(['Dashboard', 'Logs', 'Docs']);
    expect(MENU[2].items.map((item) => `${item.id}: ${item.label}`)).toEqual(['mcp-doc: MCP doc', 'docs-ai: For the AI']);
    expect(viewFromHash('#mcp-doc')).toBe('mcp-doc');
    expect(viewFromHash('#docs-ai')).toBe('docs-ai');
    // The obvious address works too.
    expect(viewFromHash('#docs')).toBe('mcp-doc');
    // And so does the address the MCP doc had under its first name.
    expect(viewFromHash('#docs-humans')).toBe('mcp-doc');
    expect(isOtherName('#docs')).toBe(true);
    expect(isOtherName('#docs-humans')).toBe(true);
    expect(isOtherName('#mcp-doc')).toBe(false);
    expect(isOtherName('#nothing-like-this')).toBe(false);
  });

  it('takes a word that every JavaScript object knows for an unknown address, like any other', () => {
    for (const word of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
      expect(viewFromHash(`#${word}`)).toBe('checks');
      expect(isOtherName(`#${word}`)).toBe(false);
    }
  });

  it('calls the page "MCP doc" in the menu, as its title, and wherever another part points to it', async () => {
    await openMcpDoc();
    expect(document.body.textContent).not.toMatch(/for humans/i);
    cleanup();
    await openAi();
    expect(document.body.textContent).not.toMatch(/for humans/i);
  });

  it('opens the MCP doc at its first address too, and puts its own address in its place', async () => {
    const steps = window.history.length;
    await open('#docs-humans', 'MCP doc');
    await screen.findByRole('heading', { level: 2, name: '1. Connect your AI' });
    expect(window.location.hash).toBe('#mcp-doc');
    // The address was swapped, not added: Back does not lead to the old one.
    expect(window.history.length).toBe(steps);
    cleanup();

    await open('#docs', 'MCP doc');
    expect(window.location.hash).toBe('#mcp-doc');
    cleanup();

    // An unknown address is left as it was typed.
    await open('#nothing-like-this', 'Run checks');
    expect(window.location.hash).toBe('#nothing-like-this');
  });

  it('opens the two pages from the drawer, and reads the docs from Scrapy once', async () => {
    const u = user();
    render(<CheckPage />);
    await screen.findByRole('heading', { level: 1, name: 'Run checks' });
    // Nothing is read before a Docs page is opened.
    expect(docsCalls()).toBe(0);

    await u.click(screen.getByRole('button', { name: 'Open menu' }));
    const menu = screen.getByRole('dialog', { name: 'Menu' });
    expect(within(menu).getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['Dashboard', 'Logs', 'Docs']);
    const list = within(menu).getByRole('list', { name: 'Docs' });
    expect(within(list).getAllByRole('link').map((a) => a.textContent)).toEqual(['MCP doc', 'For the AI']);

    await u.click(within(list).getByRole('link', { name: 'MCP doc' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'MCP doc' })).toBeTruthy();
    expect(window.location.hash).toBe('#mcp-doc');
    await screen.findByRole('heading', { level: 2, name: '1. Connect your AI' });
    expect(docsCalls()).toBe(1);

    await u.click(screen.getByRole('button', { name: 'Open menu' }));
    await u.click(within(screen.getByRole('dialog', { name: 'Menu' })).getByRole('link', { name: 'For the AI' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Docs for the AI' })).toBeTruthy();
    expect(window.location.hash).toBe('#docs-ai');
    await screen.findByRole('heading', { level: 2, name: 'How your AI gets these rules' });
    // The second page needed no second reading.
    expect(docsCalls()).toBe(1);
  });

  it('says so when the docs cannot be read, and tries again when asked', async () => {
    const u = user();
    docsAnswer = 'down';
    await open('#docs-ai', 'Docs for the AI');
    expect(await screen.findByText('The docs could not be loaded from Scrapy.')).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 2, name: 'How your AI gets these rules' })).toBeNull();

    docsAnswer = 'ok';
    await u.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'How your AI gets these rules' })).toBeTruthy();
    expect(screen.queryByText('The docs could not be loaded from Scrapy.')).toBeNull();
    expect(docsCalls()).toBe(2);
  });
});

describe('The MCP doc', () => {
  it('has the four things a person needs, in order', async () => {
    await openMcpDoc();
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(['1. Connect your AI', '2. Limits', '3. How Scrapy gets an answer', '4. How to read the logs']);
    const nav = screen.getByRole('navigation', { name: 'On this page' });
    expect(within(nav).getAllByRole('button').map((b) => b.textContent)).toEqual(headings);
  });

  it('jumps to a section, and takes the keyboard there too', async () => {
    const u = user();
    await openMcpDoc();
    await u.click(within(screen.getByRole('navigation', { name: 'On this page' })).getByRole('button', { name: '3. How Scrapy gets an answer' }));
    const section = card('3. How Scrapy gets an answer');
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(section);
  });

  it('gives the address, and copies it', async () => {
    const u = user();
    await openMcpDoc();
    const connect = card('1. Connect your AI');
    expect(connect.querySelector('code.address')?.textContent).toBe(ADDRESS);
    await u.click(within(connect).getAllByRole('button', { name: 'Copy' })[0] as HTMLElement);
    expect(copied).toEqual([ADDRESS]);
    expect(within(connect).getByText(/Streamable HTTP/)).toBeTruthy();
  });

  it('shows where the address goes, for each kind of AI app', async () => {
    const u = user();
    await openMcpDoc();
    const tabs = within(screen.getByRole('tablist', { name: 'Kind of AI app' })).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Cursor', 'Claude Code', 'VS Code', 'Local apps only', 'Your own code']);
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false', 'false', 'false']);

    // Cursor: a file with the address in it.
    expect(screen.getByRole('tabpanel').textContent).toContain('.cursor/mcp.json');
    expect(JSON.parse(codeOf('For Cursor'))).toEqual({ mcpServers: { scrapy: { url: ADDRESS } } });

    await u.click(screen.getByRole('tab', { name: 'Claude Code' }));
    expect(screen.getByRole('tab', { name: 'Claude Code' }).getAttribute('aria-selected')).toBe('true');
    expect(codeOf('For Claude Code')).toBe(`claude mcp add --transport http scrapy ${ADDRESS}`);

    await u.click(screen.getByRole('tab', { name: 'VS Code' }));
    expect(JSON.parse(codeOf('For VS Code'))).toEqual({ mcpServers: { scrapy: { type: 'http', url: ADDRESS } } });

    await u.click(screen.getByRole('tab', { name: 'Local apps only' }));
    expect(JSON.parse(codeOf('For Local apps only'))).toEqual({ mcpServers: { scrapy: { command: 'npx', args: ['-y', 'mcp-remote', ADDRESS] } } });

    await u.click(screen.getByRole('tab', { name: 'Your own code' }));
    expect(codeOf('AI SDK (@ai-sdk/mcp)')).toContain(`transport: { type: 'http', url: '${ADDRESS}' }`);
    expect(codeOf('MCP SDK (@modelcontextprotocol/client)')).toContain(`new StreamableHTTPClientTransport(new URL('${ADDRESS}'))`);

    // The copy button of a block copies that block.
    await u.click(within(screen.getByRole('tabpanel')).getAllByRole('button', { name: 'Copy' })[0] as HTMLElement);
    expect(copied.at(-1)).toBe(codeOf('AI SDK (@ai-sdk/mcp)'));

    // No secret is mentioned where none is needed.
    expect(document.body.textContent).not.toContain(SECRET);
    expect(codeOf('A check by hand')).toBe(handCheck(ADDRESS, false));
  });

  it('lets the arrow keys move between the kinds of app, and the Tab key reach only the chosen one', async () => {
    const u = user();
    await openMcpDoc();
    const tab = (name: string): HTMLElement => screen.getByRole('tab', { name });
    expect(screen.getAllByRole('tab').map((t) => t.getAttribute('tabindex'))).toEqual(['0', '-1', '-1', '-1', '-1']);

    tab('Cursor').focus();
    await u.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(tab('Claude Code'));
    expect(tab('Claude Code').getAttribute('aria-selected')).toBe('true');
    expect(codeOf('For Claude Code')).toContain('claude mcp add');
    expect(screen.getAllByRole('tab').map((t) => t.getAttribute('tabindex'))).toEqual(['-1', '0', '-1', '-1', '-1']);

    // Round the ends, and straight to the first and the last.
    await u.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(document.activeElement).toBe(tab('Your own code'));
    await u.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(tab('Cursor'));
    await u.keyboard('{End}');
    expect(document.activeElement).toBe(tab('Your own code'));
    await u.keyboard('{Home}');
    expect(document.activeElement).toBe(tab('Cursor'));
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe('tab-cursor');
  });

  it('still has the chosen kind of app after a visit to another part', async () => {
    const u = user();
    await openMcpDoc();
    await u.click(screen.getByRole('tab', { name: 'Claude Code' }));
    expect(codeOf('For Claude Code')).toContain('claude mcp add');

    await u.click(within(card('4. How to read the logs')).getAllByRole('link', { name: 'Live feed' })[0] as HTMLElement);
    await screen.findByRole('heading', { level: 1, name: 'Live feed' });
    expect(screen.queryByRole('tab', { name: 'Claude Code' })).toBeNull();

    window.history.back();
    await screen.findByRole('heading', { level: 1, name: 'MCP doc' });
    expect(screen.getByRole('tab', { name: 'Claude Code' }).getAttribute('aria-selected')).toBe('true');
    expect(codeOf('For Claude Code')).toContain('claude mcp add');
  });

  it('at a Vercel test address, says that Vercel guards it, and puts the secret header in every example', async () => {
    const u = user();
    given((p) => {
      p.facts.where = { vercel: true, env: 'preview' };
    });
    await openMcpDoc();
    const note = screen.getByRole('note');
    expect(note.textContent).toContain('This is a test address, and Vercel guards it.');
    expect(note.textContent).toContain('Protection Bypass for Automation');
    expect(note.textContent).toContain(SECRET);

    expect(JSON.parse(codeOf('For Cursor'))).toEqual({ mcpServers: { scrapy: { url: ADDRESS, headers: { [SECRET]: 'YOUR_SECRET' } } } });
    for (const client of CLIENTS) {
      await u.click(screen.getByRole('tab', { name: client.label }));
      const blocks = within(screen.getByRole('tabpanel')).getAllByRole('button', { name: 'Copy' });
      expect(blocks.length).toBeGreaterThan(0);
      for (const pre of screen.getByRole('tabpanel').querySelectorAll('pre')) expect(pre.textContent, client.label).toContain(SECRET);
    }
    expect(codeOf('A check by hand')).toContain(`-H '${SECRET}: YOUR_SECRET'`);
  });

  it('says so when the address is open to everybody', async () => {
    given((p) => {
      p.facts.where = { vercel: true, env: 'production' };
    });
    await openMcpDoc();
    expect(screen.getByRole('note').textContent).toContain('This address is open.');
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it('quotes the limits it is given, with nothing typed in', async () => {
    given((p) => {
      p.facts.limits = { perMinute: 7, perDay: 4_321 };
      p.facts.search.defaultResults = 6;
      p.facts.search.maxResults = 15;
      p.facts.search.perSite = 2;
      p.facts.search.memoryMinutes = 9;
      p.facts.page.partChars = 12_345;
      p.facts.page.budgetSeconds = 33;
      p.facts.logs = { on: true, keep: 77, hours: 11 };
      p.facts.rest.busyMinutes = 13;
    });
    await openMcpDoc();
    const rows = within(card('2. Limits'))
      .getAllByRole('row')
      .slice(1)
      .map((row) =>
        within(row)
          .getAllByRole('cell')
          .slice(0, 2)
          .map((cell) => cell.textContent)
          .join(' = '),
      );
    expect(rows).toEqual([
      'Calls a minute, for each caller = 7',
      'Calls a day, all callers together = 4,321',
      'Results of one search = 6, up to 15',
      'Length of a search question = 1 to 500 characters',
      'Length of a page = 12,345 characters',
      'Time for one page = 33 seconds',
      'Memory = 9 minutes',
      'The log = 77 calls, 11 hours',
    ]);
    const text = card('2. Limits').textContent ?? '';
    expect(text).toContain('Every call is refused until midnight UTC.');
    expect(text).toContain('Never more than 2 from one site.');
    expect(text).toContain('Scrapy lets it rest (13 minutes, unless it says how long)');
    expect(text).toContain('SCRAPY_VISITOR_PER_MINUTE');
    // The user's own example of a limit, with the real setting: 30 calls a minute.
    cleanup();
    given();
    await openMcpDoc();
    expect(within(card('2. Limits')).getAllByRole('row')[1]?.textContent).toContain('Calls a minute, for each caller30');
  });

  it('explains free, fast and smart, and walks through a search and a page in the order Scrapy uses', async () => {
    await openMcpDoc();
    const how = card('3. How Scrapy gets an answer');
    // "Fast/Free/Smart", in the words and the order of the request.
    expect(within(how).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Fast', 'Free', 'Smart', 'A search, step by step', 'A page, step by step', 'Resting and remembering']);

    const searchSteps = within(within(how).getByRole('list', { name: 'A search, step by step' })).getAllByRole('listitem');
    expect(searchSteps.map((li) => li.querySelector('.step-title')?.textContent)).toEqual(['Memory', 'Two engines at the same time', 'The fallback, only when needed', 'Merge and clean']);
    expect([...(searchSteps[1] as HTMLElement).querySelectorAll('.chip')].map((c) => c.textContent)).toEqual(['Tavily', 'Exa']);
    expect([...(searchSteps[2] as HTMLElement).querySelectorAll('.chip')].map((c) => c.textContent)).toEqual(['Parallel', 'Firecrawl']);
    expect(searchSteps[1]?.textContent).toContain('the other gets 2.5 more seconds');
    expect(searchSteps[2]?.textContent).toContain('fewer than 5 usable results');
    expect(searchSteps[3]?.textContent).toMatch(/Results from \d\d known copycat sites are left out/);

    const pageSteps = within(within(how).getByRole('list', { name: 'A page, step by step' })).getAllByRole('listitem');
    expect(pageSteps.map((li) => li.querySelector('.step-title')?.textContent)).toEqual(['Memory', 'The ways, in this order', 'Scrapy checks the answer', 'A second look at thin pages', 'Clean and cut']);
    expect([...(pageSteps[1] as HTMLElement).querySelectorAll('.chip')].map((c) => c.textContent)).toEqual(['Jina Readerreal browser', 'Firecrawlreal browser', 'Tavily', 'Parallelreal browser', 'Exa']);
    expect(pageSteps[1]?.textContent).toContain('after 6 seconds');
    expect(pageSteps[3]?.textContent).toContain('fewer than 500 characters');

    expect(how.textContent).toContain('A helper that fails 2 times in a row rests for 90 seconds.');
    expect(how.textContent).toContain('For 24 hours Scrapy also remembers which way worked for a site');
    expect(how.textContent).toContain('This Scrapy is in the safe position');
  });

  it('follows another order, a helper that is switched off, and another position', async () => {
    given((p) => {
      p.mode = 'full';
      p.facts.search.order = [
        { id: 'exa', name: 'Exa' },
        { id: 'firecrawl', name: 'Firecrawl' },
        { id: 'parallel', name: 'Parallel' },
      ];
      p.facts.search.off = ['Tavily'];
      p.facts.page.order = [{ id: 'tavily', name: 'Tavily', browser: false }];
      p.facts.page.off = ['Jina Reader', 'Exa'];
      p.facts.page.own = 'first';
    });
    await openMcpDoc();
    const how = card('3. How Scrapy gets an answer');
    const searchSteps = within(within(how).getByRole('list', { name: 'A search, step by step' })).getAllByRole('listitem');
    expect([...(searchSteps[1] as HTMLElement).querySelectorAll('.chip')].map((c) => c.textContent)).toEqual(['Exa', 'Firecrawl']);
    expect([...(searchSteps[2] as HTMLElement).querySelectorAll('.chip')].map((c) => c.textContent)).toEqual(['Parallel']);
    const pageSteps = within(within(how).getByRole('list', { name: 'A page, step by step' })).getAllByRole('listitem');
    expect([...(pageSteps[1] as HTMLElement).querySelectorAll('.chip')].map((c) => c.textContent)).toEqual(["Scrapy's own download", 'Tavily']);
    expect(how.textContent).toContain('Switched off by a setting: Tavily.');
    expect(how.textContent).toContain('Switched off by a setting: Jina Reader and Exa.');
    expect(how.textContent).toContain('This Scrapy is in the full-speed position');
  });

  it('explains one line of the live feed, the kinds of method, and what to look for', async () => {
    await openMcpDoc();
    const logs = card('4. How to read the logs');
    // The example line is the user's own example of a call.
    expect(logs.querySelector('.anatomy')?.getAttribute('aria-label')).toContain('11:45:02 AM, search_web, how to fix hydration error');
    expect([...logs.querySelectorAll('.anatomy-label')].map((l) => l.textContent)).toEqual(['Time', 'Tool', 'Query or URL', 'Method', 'Took', 'Result']);
    const tables = within(logs).getAllByRole('table');
    expect(within(tables[0] as HTMLElement).getAllByRole('row').slice(1).map((row) => row.querySelector('td')?.textContent)).toEqual(['Time', 'Tool', 'Query or URL', 'Method', 'Took', 'Result']);
    expect(within(tables[1] as HTMLElement).getAllByRole('row').map((row) => row.querySelector('td')?.textContent)).toEqual(['Tier 1 (Fast HTTP)', 'Tier 2 (Real browser)', 'Memory', 'None worked', 'Not started']);
    expect(logs.textContent).toContain('Press a line and it unfolds into a card.');
    expect(logs.textContent).toContain('Payload, unfolds once more into the response exactly as the AI received it.');
    expect(logs.textContent).toContain('The log is on at this address. It keeps the last 100 calls for up to 24 hours');
    expect(within(logs).getAllByRole('link', { name: 'Live feed' })[0]?.getAttribute('href')).toBe('#logs');
  });

  it('says so when the log is off at this address', async () => {
    given((p) => {
      p.facts.logs.on = false;
    });
    await openMcpDoc();
    expect(card('4. How to read the logs').textContent).toContain('The log is off at this address, so the Live feed stays empty here.');
  });

  it('points to the page for the AI', async () => {
    await openMcpDoc();
    expect(screen.getByRole('link', { name: 'For the AI' }).getAttribute('href')).toBe('#docs-ai');
  });
});

describe('the examples for connecting', () => {
  it('are proper JSON where a file is meant, and carry the secret only when asked', () => {
    for (const withSecret of [false, true]) {
      const all = connectSnippets('https://scrapy.example/api/mcp', withSecret);
      expect(Object.keys(all)).toEqual(CLIENTS.map((c) => c.id));
      for (const id of ['cursor', 'vscode', 'local'] as const) {
        const parsed = JSON.parse(all[id].blocks[0]?.code ?? '') as { mcpServers: { scrapy: Record<string, unknown> } };
        expect(Object.keys(parsed.mcpServers)).toEqual(['scrapy']);
      }
      for (const snippet of Object.values(all)) {
        expect(snippet.where.length).toBeGreaterThan(10);
        for (const block of snippet.blocks) {
          expect(block.code).toContain('https://scrapy.example/api/mcp');
          expect(block.code.includes(SECRET)).toBe(withSecret);
        }
      }
    }
  });

  it('follow what each app expects', () => {
    const plain = connectSnippets('https://scrapy.example/api/mcp', false);
    const secret = connectSnippets('https://scrapy.example/api/mcp', true);
    // Claude Code skips an entry with a url and no type. VS Code wants the type too.
    expect(JSON.parse(plain.vscode.blocks[0]?.code ?? '')).toEqual({ mcpServers: { scrapy: { type: 'http', url: 'https://scrapy.example/api/mcp' } } });
    expect(secret.claude.blocks[0]?.code).toBe(`claude mcp add --transport http scrapy https://scrapy.example/api/mcp \\\n  --header "${SECRET}: YOUR_SECRET"`);
    // mcp-remote: no space after the colon, because some apps break arguments at spaces. The value comes from the environment.
    expect(JSON.parse(secret.local.blocks[0]?.code ?? '')).toEqual({
      mcpServers: { scrapy: { command: 'npx', args: ['-y', 'mcp-remote', 'https://scrapy.example/api/mcp', '--header', `${SECRET}:\${SCRAPY_SECRET}`], env: { SCRAPY_SECRET: 'YOUR_SECRET' } } },
    });
    // In code, the secret is read from the environment and never written out.
    expect(secret.code.blocks.map((b) => b.code).join('\n')).not.toContain('YOUR_SECRET');
    expect(secret.code.blocks[0]?.code).toContain(`headers: { '${SECRET}': process.env.SCRAPY_SECRET }`);
  });

  it('the check by hand asks for the list of tools, the way MCP wants to be asked', () => {
    const text = handCheck('https://scrapy.example/api/mcp', false);
    expect(text).toContain('curl -s -X POST https://scrapy.example/api/mcp');
    expect(text).toContain("-H 'Accept: application/json, text/event-stream'");
    expect(text).toContain(`-d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`);
    expect(text).not.toContain(SECRET);
  });
});

describe('Docs for the AI', () => {
  it('says that the AI never opens this page, and how it gets the rules instead', async () => {
    await openAi();
    const how = card('How your AI gets these rules');
    expect(how.textContent).toContain('Your AI never opens this page. Scrapy tells it the rules itself.');
    const ways = within(how).getAllByRole('listitem');
    expect(ways).toHaveLength(3);
    expect(ways[0]?.textContent).toContain('When it connects. Nothing to do.');
    expect(ways[1]?.textContent).toContain('scrapy://rulebook');
    expect(ways[2]?.textContent).toContain('paste the rulebook into its own instructions');
    expect(within(how).getByRole('link', { name: 'Open /llms.txt' }).getAttribute('href')).toBe('/llms.txt');
  });

  it('at a Vercel test address, says that /llms.txt is behind the login too', async () => {
    await openAi();
    expect(card('How your AI gets these rules').textContent).not.toContain('Vercel asks for a login first');
    cleanup();
    given((p) => {
      p.facts.where = { vercel: true, env: 'preview' };
    });
    await openAi();
    expect(card('How your AI gets these rules').textContent).toContain('At this test address Vercel asks for a login first, so an AI can open /llms.txt only with the secret header that the MCP doc describes.');
    expect(document.body.textContent).not.toMatch(/for humans/i);
  });

  it('shows, word for word, what every AI is told when it connects', async () => {
    await openAi();
    const first = card('What every AI is told when it connects');
    expect(first.querySelector('blockquote')?.textContent).toBe(payload.instructions);
    expect(first.textContent).toContain('Then it gets the 2 tools below: search_web and fetch_url.');
  });

  it('lists the exact parameters of each tool, as the tool itself defines them', async () => {
    await openAi();
    for (const tool of payload.tools) {
      const section = card(new RegExp(`^${tool.name} `));
      expect(section.textContent).toContain(tool.description);
      const rows = within(within(section).getByRole('table')).getAllByRole('row').slice(1);
      expect(rows.map((row) => row.querySelector('td')?.textContent)).toEqual(tool.params.map((p) => p.name));
      for (const [i, p] of tool.params.entries()) {
        const cells = within(rows[i] as HTMLElement)
          .getAllByRole('cell')
          .map((cell) => cell.textContent);
        expect(cells).toEqual([p.name, `${p.type}${p.limits}`, `${p.required ? 'required' : 'optional'}${p.default !== undefined ? `default ${p.default}` : ''}`, p.about]);
      }
      expect(section.textContent).toContain('One that is not in this list is refused.');
    }
    // In plain sight: the user's own example, "use the search_web tool, here are the exact parameters".
    const search = card(/^search_web /);
    expect(within(search).getAllByRole('row')[1]?.textContent).toContain('querystring1 to 500 charactersrequired');
    expect(within(search).getAllByRole('row')[2]?.textContent).toContain('max_resultsinteger1 to 20optionaldefault 8');
  });

  it('shows examples of what to send, what comes back, and what a guess is answered with', async () => {
    await openAi();
    for (const tool of payload.tools) {
      const section = card(new RegExp(`^${tool.name} `));
      for (const example of tool.examples) {
        expect(JSON.parse(within(section).getByLabelText(`${tool.name}: ${example.about}`).textContent ?? '')).toEqual(example.args);
      }
      expect(within(section).getByLabelText(`An example answer of ${tool.name}`).textContent).toBe(tool.answer.sample);
      for (const note of tool.answer.notes) expect(section.textContent).toContain(note);
      expect(section.querySelector('blockquote')?.textContent).toBe(tool.wrongInput.answer);
      expect(section.textContent).toContain(JSON.stringify(tool.wrongInput.args));
    }
    expect(card(/^search_web /).querySelector('blockquote')?.textContent).toMatch(/^The input for search_web is not right\. It has no parameter "q" or "limit"\. Parameters of search_web: query \(string, required/);
  });

  it('has the table of failures: how the answer starts, what it means, what the AI should do', async () => {
    await openAi();
    const rows = within(card('When a tool cannot do the job')).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(payload.failures.length);
    expect(rows).toHaveLength(12);
    for (const [i, failure] of payload.failures.entries()) {
      const cells = within(rows[i] as HTMLElement).getAllByRole('cell');
      expect([...(cells[0] as HTMLElement).querySelectorAll('.starts')].map((s) => s.textContent)).toEqual(failure.starts);
      expect(cells[1]?.textContent).toBe(failure.means);
      expect(cells[2]?.textContent).toBe(failure.then);
    }
  });

  it('copies the whole rulebook, with the address of this Scrapy in it', async () => {
    const u = user();
    await openAi();
    const buttons = screen.getAllByRole('button', { name: 'Copy the rulebook' });
    expect(buttons).toHaveLength(2);
    await u.click(buttons[0] as HTMLElement);
    expect(copied).toHaveLength(1);
    const text = copied[0] ?? '';
    // The same text as /llms.txt gives: the rulebook, and where Scrapy is.
    expect(text).toContain(`\n\nMCP address: ${ADDRESS} (Streamable HTTP, no key needed).\n\n## Which tool to use\n`);
    expect(text.replace(`MCP address: ${ADDRESS} (Streamable HTTP, no key needed).\n\n`, '')).toBe(payload.rulebook);
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Copied' })).toHaveLength(1));
  });

  it('shows the rulebook as the AI reads it, folded away until asked for', async () => {
    const u = user();
    await openAi();
    const section = card('The whole rulebook, as the AI reads it');
    const details = section.querySelector('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    await u.click(within(section).getByText(/^Show the rulebook \([\d,]+ characters\)$/));
    expect(details.open).toBe(true);
    expect(within(section).getByLabelText('The rulebook for AI agents').textContent).toContain('# Scrapy: the rulebook for AI agents');
    expect(within(section).getByLabelText('The rulebook for AI agents').textContent).toContain(`MCP address: ${ADDRESS}`);
  });

  it('points to the MCP doc', async () => {
    await openAi();
    expect(screen.getByRole('link', { name: 'MCP doc' }).getAttribute('href')).toBe('#mcp-doc');
  });
});

describe('the address part of the dashboard', () => {
  it('points to the docs for where to put the address', async () => {
    await open('#address', 'The address for your agent');
    expect(screen.getByRole('link', { name: 'MCP doc' }).getAttribute('href')).toBe('#mcp-doc');
  });
});
