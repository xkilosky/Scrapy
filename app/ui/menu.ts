/**
 * The menu in the drawer.
 *
 * The menu is a list of sections. Each section has a title and its entries.
 * To add a section, add one more object to this list. Every new entry also
 * needs its content in app/page.tsx: without it, the entry opens a part that
 * has a title and nothing else.
 *
 * An entry's id is also its address: "#try" opens "Try a tool".
 */
export interface MenuItem {
  id: string;
  /** Shown in the menu, and as the title of the part it opens. */
  label: string;
  /** The title of the part, when the label alone would not say enough there. */
  title?: string;
  /** One sentence shown under the title. */
  about: string;
}

export interface MenuSection {
  title: string;
  items: readonly MenuItem[];
}

export const MENU = [
  {
    title: 'Dashboard',
    items: [
      {
        id: 'checks',
        label: 'Run checks',
        about: 'Asks every free helper one small thing, times the tools, tries the fallback, and lists every address Scrapy contacted.',
      },
      {
        id: 'address',
        label: 'The address for your agent',
        about: 'An AI agent connects to this address with MCP and gets the tools.',
      },
      {
        id: 'try',
        label: 'Try a tool',
        about: 'Runs a tool exactly as an agent would, and shows the answer the agent gets.',
      },
    ],
  },
  {
    title: 'Logs',
    items: [
      {
        id: 'logs',
        label: 'Live feed',
        about: 'Every tool call, as it happens. The newest is at the bottom. Press a line to unfold it.',
      },
    ],
  },
  {
    title: 'Docs',
    items: [
      {
        id: 'mcp-doc',
        label: 'MCP doc',
        about: 'How to connect your AI, the limits, how Scrapy gets an answer, and how to read the logs.',
      },
      {
        id: 'docs-ai',
        label: 'For the AI',
        title: 'Docs for the AI',
        about: 'The rulebook your AI follows: which tool to use, the exact parameters to send, and what to do when a tool cannot do the job.',
      },
    ],
  },
] as const satisfies readonly MenuSection[];

export type ViewId = (typeof MENU)[number]['items'][number]['id'];

const ITEMS: readonly MenuItem[] = MENU.flatMap((section) => [...section.items]);

/** The part shown when the address names none: the first entry of the first section. */
export const FIRST_VIEW: ViewId = MENU[0].items[0].id;

export function menuItem(id: ViewId): MenuItem {
  return ITEMS.find((item) => item.id === id) ?? MENU[0].items[0];
}

/**
 * Other names for a part. "#docs" is the obvious address of the docs, so it opens their first page.
 * "#docs-humans" is what the MCP doc was called at first: a link saved then still works.
 */
const ALSO: ReadonlyMap<string, ViewId> = new Map<string, ViewId>([
  ['docs', 'mcp-doc'],
  ['docs-humans', 'mcp-doc'],
]);

/** Which part an address like "#try" names. Anything unknown means the first part. */
export function viewFromHash(hash: string): ViewId {
  const id = hash.replace(/^#/, '');
  const found = ITEMS.find((item) => item.id === id);
  return found ? (found.id as ViewId) : (ALSO.get(id) ?? FIRST_VIEW);
}

/** True when an address names a part by another name than its own, like "#docs". */
export function isOtherName(hash: string): boolean {
  return ALSO.has(hash.replace(/^#/, ''));
}
