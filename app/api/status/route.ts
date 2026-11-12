/**
 * A quick look at Scrapy. Contacts nobody.
 *
 * Everybody gets the name, the version and who may use this Scrapy. The
 * settings, today's count and the health of the helpers are for those who may
 * use it. The owner of a personal Scrapy also gets the key for an AI.
 */
import { access, allowed, CLOSED_TEXT, LOGIN_TEXT } from '@/lib/access';
import { getMode, limits, pageOrder, RELEASE, searchOrder, switchedOff, VERSION } from '@/lib/config';
import { getHealth } from '@/lib/health';
import { getLimiter } from '@/lib/limits';
import { agentKey } from '@/lib/owner';
import { HELPER_HOSTS, PAGE_HELPERS, SEARCH_ENGINES } from '@/lib/providers';
import { TOOLS } from '@/lib/tools';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function answer(body: Record<string, unknown>): Response {
  return Response.json(body, { headers: { 'Cache-Control': 'no-store' } });
}

export async function GET(request: Request): Promise<Response> {
  const state = access();
  const basics = { name: 'scrapy', version: VERSION, release: RELEASE, access: state };
  if (state === 'closed') return answer({ ...basics, open: false, allowed: false, message: CLOSED_TEXT });
  if (!allowed(request)) return answer({ ...basics, open: true, allowed: false, message: LOGIN_TEXT });
  const off = switchedOff();
  return answer({
    ...basics,
    open: true,
    allowed: true,
    // Only the owner gets this far in a personal Scrapy.
    ...(state === 'personal' ? { key: agentKey() } : {}),
    mode: getMode(),
    tools: TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description })),
    search: { order: searchOrder(), engines: SEARCH_ENGINES.map((e) => ({ id: e.id, name: e.name, off: off.has(e.id) })) },
    pages: { order: pageOrder(), helpers: PAGE_HELPERS.map((w) => ({ id: w.id, name: w.name, browser: w.browser, off: off.has(w.id) })) },
    helperHosts: HELPER_HOSTS,
    limits: limits(),
    usage: getLimiter().usage(),
    health: getHealth().snapshot(),
    where: { vercel: process.env.VERCEL === '1', env: process.env.VERCEL_ENV ?? null, region: process.env.VERCEL_REGION ?? null },
  });
}
