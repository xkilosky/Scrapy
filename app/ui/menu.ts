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
] as const satisfies readonly MenuSection[];

export type ViewId = (typeof MENU)[number]['items'][number]['id'];

const ITEMS: readonly MenuItem[] = MENU.flatMap((section) => [...section.items]);

/** The part shown when the address names none: the first entry of the first section. */
export const FIRST_VIEW: ViewId = MENU[0].items[0].id;

export function menuItem(id: ViewId): MenuItem {
  return ITEMS.find((item) => item.id === id) ?? MENU[0].items[0];
}

/** Which part an address like "#try" names. Anything unknown means the first part. */
export function viewFromHash(hash: string): ViewId {
  const id = hash.replace(/^#/, '');
  const found = ITEMS.find((item) => item.id === id);
  return found ? (found.id as ViewId) : FIRST_VIEW;
}
