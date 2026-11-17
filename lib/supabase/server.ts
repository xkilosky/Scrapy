import { createServerClient } from '@supabase/ssr';
import { createClient, type User } from '@supabase/supabase-js';
import { cookies } from 'next/headers';

export interface SupabaseEnvironment {
  url: string;
  anonKey: string;
  serviceRoleKey: string;
}

export function supabaseEnvironment(): SupabaseEnvironment | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  return url && anonKey && serviceRoleKey ? { url, anonKey, serviceRoleKey } : null;
}

export async function supabaseServer() {
  const env = supabaseEnvironment();
  if (!env) throw new Error('Supabase account mode is not configured.');
  const jar = await cookies();
  return createServerClient(env.url, env.anonKey, {
    cookies: {
      getAll: () => jar.getAll(),
      setAll: (values) => {
        try {
          for (const { name, value, options } of values) jar.set(name, value, options);
        } catch {
          // Server components cannot write cookies; route handlers and server actions can.
        }
      },
    },
  });
}

export function supabaseAdmin() {
  const env = supabaseEnvironment();
  if (!env) throw new Error('Supabase account mode is not configured.');
  return createClient(env.url, env.serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
}

export async function currentSupabaseUser(): Promise<User | null> {
  if (!supabaseEnvironment()) return null;
  const { data, error } = await (await supabaseServer()).auth.getUser();
  // Account access and key issuance require a verified email even if the
  // Supabase project has email confirmation disabled by mistake.
  return error || !data.user?.email_confirmed_at ? null : data.user;
}
