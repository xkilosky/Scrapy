/** Behind "Log out": takes the browser's pass back. */
import { fromAnotherSite, noSessionCookie } from '@/lib/owner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  // A page on another site has no business logging the owner out.
  if (fromAnotherSite(request)) return Response.json({ ok: false, error: "Log out from Scrapy's own pages." }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  return Response.json({ ok: true }, { headers: { 'Set-Cookie': noSessionCookie(request), 'Cache-Control': 'no-store' } });
}
