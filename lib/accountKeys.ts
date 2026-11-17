import { createHash, randomBytes } from 'node:crypto';
import type { User } from '@supabase/supabase-js';
import { ScrapyError } from './errors';
import { API_KEY_LIMITS } from './config';
import { supabaseAdmin } from './supabase/server';

export const KEY_CALLS_PER_MINUTE = API_KEY_LIMITS.perMinute;
export const KEY_CALLS_PER_DAY = API_KEY_LIMITS.perDay;
export const KEY_LABEL_MAX = 64;

export interface AccountKey {
  id: string;
  user_id: string;
  label: string;
  key_prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  per_minute_limit: number;
  daily_limit: number;
  used_this_minute: number;
  used_today: number;
}

export interface ApiKeyIdentity {
  id: string;
  userId: string;
  label: string;
  perMinuteLimit: number;
  dailyLimit: number;
}

const byRequest = new WeakMap<Request, ApiKeyIdentity | null>();
const digest = (key: string): string => createHash('sha256').update(key).digest('hex');

function tokenFrom(request: Request): string | null {
  const bearer = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const custom = request.headers.get('x-scrapy-key')?.trim();
  const token = bearer || custom;
  return token && token.length <= 200 && token.startsWith('scrapy_') ? token : null;
}

/** Find a live user key by its one-way hash. The raw token is never stored. */
export async function apiKeyForRequest(request: Request): Promise<ApiKeyIdentity | null> {
  if (byRequest.has(request)) return byRequest.get(request) ?? null;
  const token = tokenFrom(request);
  if (!token) {
    byRequest.set(request, null);
    return null;
  }
  const { data, error } = await supabaseAdmin()
    .from('scrapy_api_keys')
    .select('id,user_id,label,per_minute_limit,daily_limit')
    .eq('key_hash', digest(token))
    .is('revoked_at', null)
    .maybeSingle();
  if (error) throw new Error('The API key could not be checked against Supabase.');
  const identity = data
    ? {
        id: String(data.id),
        userId: String(data.user_id),
        label: String(data.label),
        perMinuteLimit: Number(data.per_minute_limit),
        dailyLimit: Number(data.daily_limit),
      }
    : null;
  byRequest.set(request, identity);
  return identity;
}

export async function createAccountKey(user: User, label: string): Promise<{ key: string; record: AccountKey }> {
  const cleanLabel = label.trim();
  if (cleanLabel.length < 1 || cleanLabel.length > KEY_LABEL_MAX) throw new ScrapyError('bad_input', `A key name must be 1 to ${KEY_LABEL_MAX} characters.`);
  const key = `scrapy_${randomBytes(32).toString('base64url')}`;
  const { data, error } = await supabaseAdmin()
    .from('scrapy_api_keys')
    .insert({
      user_id: user.id,
      label: cleanLabel,
      key_hash: digest(key),
      key_prefix: key.slice(0, 13),
      per_minute_limit: KEY_CALLS_PER_MINUTE,
      daily_limit: KEY_CALLS_PER_DAY,
    })
    .select('id,user_id,label,key_prefix,created_at,last_used_at,revoked_at,per_minute_limit,daily_limit')
    .single();
  if (error || !data) throw new Error('The key could not be saved. Check the Supabase migration and try again.');
  return { key, record: { ...(data as Omit<AccountKey, 'used_this_minute' | 'used_today'>), used_this_minute: 0, used_today: 0 } };
}

export async function listAccountKeys(userId: string): Promise<AccountKey[]> {
  const { data, error } = await supabaseAdmin()
    .from('scrapy_api_keys')
    .select('id,user_id,label,key_prefix,created_at,last_used_at,revoked_at,per_minute_limit,daily_limit')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw new Error('Keys could not be loaded from Supabase.');
  const keys = (data ?? []) as Omit<AccountKey, 'used_this_minute' | 'used_today'>[];
  if (keys.length === 0) return [];
  const { data: usage, error: usageError } = await supabaseAdmin().rpc('get_scrapy_api_key_usage', { p_user_id: userId });
  if (usageError) throw new Error('Key usage could not be loaded from Supabase. Apply the latest Scrapy migration and try again.');
  const usageRows = (usage ?? []) as { key_id: string; minute_calls: number; daily_calls: number }[];
  const byId = new Map<string, (typeof usageRows)[number]>(usageRows.map((row) => [row.key_id, row]));
  return keys.map((key) => {
    const current = byId.get(key.id);
    return {
      ...key,
      used_this_minute: Number(current?.minute_calls ?? 0),
      used_today: Number(current?.daily_calls ?? 0),
    };
  });
}

export async function revokeAccountKey(userId: string, id: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin()
    .from('scrapy_api_keys')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', userId)
    .is('revoked_at', null)
    .select('id');
  if (error) throw new Error('The key could not be revoked.');
  return Boolean(data?.length);
}

/** Atomic, cross-instance per-key quota check backed by the Supabase RPC. */
export async function checkAccountKeyAllowance(id: string): Promise<void> {
  const { data, error } = await supabaseAdmin().rpc('consume_scrapy_api_key_call', { p_key_id: id });
  if (error || !data || typeof data !== 'object') throw new ScrapyError('failed', 'The per-key allowance check could not be completed. Try again later.');
  const result = data as { allowed?: boolean; reason?: string; retry_after?: number; daily_limit?: number };
  if (result.allowed) return;
  if (result.reason === 'daily_limit') {
    throw new ScrapyError('daily_limit', `This key has reached its daily allowance of ${result.daily_limit ?? KEY_CALLS_PER_DAY} calls. It resets at midnight UTC.`, 86_400);
  }
  const wait = Math.max(1, Number(result.retry_after ?? 60));
  throw new ScrapyError('slow_down', `Slow down: this key allows ${KEY_CALLS_PER_MINUTE} calls per minute. Try again in about ${wait} seconds.`, wait);
}
