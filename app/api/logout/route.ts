/** Behind "Log out": takes the browser's pass back. */
import { fromAnotherSite, noSessionCookie } from '@/lib/owner';
import { access } from '@/lib/access';
import { supabaseServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  // A page on another site has no business logging the owner out.
  if (fromAnotherSite(request)) return Response.json({ ok: false, error: "Log out from Scrapy's own pages." }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  if (access() === 'accounts') {
    const { error } = await (await supabaseServer()).auth.signOut();
    return error
      ? Response.json({ ok: false, error: error.message }, { status: 500 })
      : Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  }
  return Response.json({ ok: true }, { headers: { 'Set-Cookie': noSessionCookie(request), 'Cache-Control': 'no-store' } });
}
