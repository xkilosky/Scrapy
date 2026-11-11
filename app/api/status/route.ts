/** A quick look at Scrapy's settings. Contacts nobody. */
import { CLOSED_TEXT, isOpen } from '@/lib/access';
import { getMode, limits, pageOrder, searchOrder, switchedOff, VERSION } from '@/lib/config';
import { getHealth } from '@/lib/health';
import { getLimiter } from '@/lib/limits';
import { HELPER_HOSTS, PAGE_HELPERS, SEARCH_ENGINES } from '@/lib/providers';
import { TOOLS } from '@/lib/tools';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  if (!isOpen()) return Response.json({ name: 'scrapy', version: VERSION, open: false, message: CLOSED_TEXT });
  const off = switchedOff();
  return Response.json({
    name: 'scrapy',
    version: VERSION,
    open: true,
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
