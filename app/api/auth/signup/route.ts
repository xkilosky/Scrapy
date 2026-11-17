import { access } from '@/lib/access';
import { fromAnotherSite } from '@/lib/owner';
import { supabaseServer, supabaseEnvironment } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  if (access() !== 'accounts') return Response.json({ error: 'Account signup is not enabled.' }, { status: 404 });
  if (fromAnotherSite(request)) return Response.json({ error: "Sign up from Scrapy's own page." }, { status: 403 });
  if (!supabaseEnvironment()) return Response.json({ error: 'Supabase is not configured for account signup.' }, { status: 503 });
  let body: { email?: unknown; password?: unknown };
  try {
    body = (await request.json()) as { email?: unknown; password?: unknown };
  } catch {
    return Response.json({ error: 'The request was not readable.' }, { status: 400 });
  }
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return Response.json({ error: 'Enter a valid email address.' }, { status: 400 });
  if (password.length < 12 || password.length > 256) return Response.json({ error: 'Use a password between 12 and 256 characters.' }, { status: 400 });

  const origin = new URL(request.url).origin;
  const { data, error } = await (await supabaseServer()).auth.signUp({
    email,
    password,
    options: { emailRedirectTo: new URL('/auth/callback', origin).toString() },
  });
  if (error) return Response.json({ error: error.message }, { status: 400 });
  return Response.json({ ok: true, confirmationRequired: !data.session }, { headers: { 'Cache-Control': 'no-store' } });
}
