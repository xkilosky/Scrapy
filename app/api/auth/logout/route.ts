import { access } from '@/lib/access';
import { fromAnotherSite } from '@/lib/owner';
import { supabaseServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  if (access() !== 'accounts') return Response.json({ error: 'Account sign-out is not enabled.' }, { status: 404 });
  if (fromAnotherSite(request)) return Response.json({ error: "Sign out from Scrapy's own page." }, { status: 403 });
  const { error } = await (await supabaseServer()).auth.signOut();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
}
