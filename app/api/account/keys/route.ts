import { access, refusal } from '@/lib/access';
import { createAccountKey, listAccountKeys, revokeAccountKey } from '@/lib/accountKeys';
import { fromAnotherSite } from '@/lib/owner';
import { getLimiter, visitorOf } from '@/lib/limits';
import { ScrapyError } from '@/lib/errors';
import { currentSupabaseUser } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function answer(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function GET(request: Request): Promise<Response> {
  if (access() !== 'accounts') return answer({ error: 'User API keys are not enabled.' }, 404);
  const turnedAway = await refusal(request);
  if (turnedAway) return turnedAway;
  const user = await currentSupabaseUser();
  if (!user) return answer({ error: 'Sign in again.' }, 401);
  try {
    return answer({ ok: true, keys: await listAccountKeys(user.id) });
  } catch (error) {
    return answer({ error: error instanceof Error ? error.message : 'Keys could not be loaded.' }, 503);
  }
}

export async function POST(request: Request): Promise<Response> {
  if (access() !== 'accounts') return answer({ error: 'User API keys are not enabled.' }, 404);
  if (fromAnotherSite(request)) return answer({ error: "Keys are made from Scrapy's own pages." }, 403);
  const turnedAway = await refusal(request);
  if (turnedAway) return turnedAway;
  const user = await currentSupabaseUser();
  if (!user) return answer({ error: 'Sign in again.' }, 401);
  let body: { label?: unknown };
  try {
    body = (await request.json()) as { label?: unknown };
  } catch {
    return answer({ error: 'The request was not readable.' }, 400);
  }
  const label = typeof body.label === 'string' ? body.label : '';
  try {
    await getLimiter().check(`key-create:${user.id}:${visitorOf(request)}`);
    const minted = await createAccountKey(user, label);
    return answer({ ok: true, key: minted.key, record: minted.record }, 201);
  } catch (error) {
    const status = error instanceof ScrapyError ? 429 : error instanceof Error && error.message.startsWith('A key name') ? 400 : 503;
    return answer({ error: error instanceof Error ? error.message : 'The key could not be created.' }, status);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  if (access() !== 'accounts') return answer({ error: 'User API keys are not enabled.' }, 404);
  if (fromAnotherSite(request)) return answer({ error: "Keys are turned off from Scrapy's own pages." }, 403);
  const turnedAway = await refusal(request);
  if (turnedAway) return turnedAway;
  const user = await currentSupabaseUser();
  if (!user) return answer({ error: 'Sign in again.' }, 401);
  let body: { id?: unknown };
  try {
    body = (await request.json()) as { id?: unknown };
  } catch {
    return answer({ error: 'The request was not readable.' }, 400);
  }
  const id = typeof body.id === 'string' ? body.id : '';
  if (!/^[0-9a-f-]{36}$/i.test(id)) return answer({ error: 'Choose a key to turn off.' }, 400);
  try {
    return answer({ ok: true, found: await revokeAccountKey(user.id, id) });
  } catch (error) {
    return answer({ error: error instanceof Error ? error.message : 'The key could not be turned off.' }, 503);
  }
}
