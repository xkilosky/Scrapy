import { NextResponse, type NextRequest } from 'next/server';
import { access } from '@/lib/access';
import { supabaseServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  if (access() !== 'accounts' || !code) return NextResponse.redirect(new URL('/login?auth=link-expired', url.origin));
  const { error } = await (await supabaseServer()).auth.exchangeCodeForSession(code);
  if (error) return NextResponse.redirect(new URL('/login?auth=link-expired', url.origin));
  return NextResponse.redirect(new URL('/dashboard', url.origin));
}
