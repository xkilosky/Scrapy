/**
 * Who is looking at a page, as the server sees it. For the pages themselves:
 * the home page, the login page and the dashboard.
 */
import { cookies } from 'next/headers';
import { access, type Access } from '@/lib/access';
import { ownerPassword } from '@/lib/config';
import { SESSION_COOKIE, sessionFits } from '@/lib/owner';

export interface Viewer {
  /** Who may use this Scrapy: see lib/access.ts. */
  state: Access;
  /** True in a personal Scrapy, for a browser that is logged in. */
  loggedIn: boolean;
  /** True when a password is set that is too short to be used. Nobody can log in then. */
  locked: boolean;
}

export async function viewer(): Promise<Viewer> {
  const state = access();
  const loggedIn = state === 'personal' && sessionFits((await cookies()).get(SESSION_COOKIE)?.value);
  return { state, loggedIn, locked: state === 'personal' && !ownerPassword().usable };
}
