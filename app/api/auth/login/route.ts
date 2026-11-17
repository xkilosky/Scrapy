import { access } from '@/lib/access';
import { fromAnotherSite } from '@/lib/owner';
import { supabaseServer, supabaseEnvironment } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  if (access() !== 'accounts') return Response.json({ error: 'Account sign-in is not enabled.' }, { status: 404 });
  if (fromAnotherSite(request)) return Response.json({ error: "Sign in from Scrapy's own page." }, { status: 403 });
  if (!supabaseEnvironment()) return Response.json({ error: 'Supabase is not configured for account sign-in.' }, { status: 503 });
  let body: { email?: unknown; password?: unknown };
  try {
    body = (await request.json()) as { email?: unknown; password?: unknown };
  } catch {
    return Response.json({ error: 'The request was not readable.' }, { status: 400 });
  }
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!email || !password || email.length > 254 || password.length > 256) return Response.json({ error: 'Enter your email and password.' }, { status: 400 });
  const { error } = await (await supabaseServer()).auth.signInWithPassword({ email, password });
  if (error) return Response.json({ error: error.message }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
}
