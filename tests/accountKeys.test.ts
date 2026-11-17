import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { apiKeyForRequest, checkAccountKeyAllowance, createAccountKey, listAccountKeys } from '@/lib/accountKeys';

const createdRow = {
  id: '0ccf89de-8ea9-467e-a8fd-c9b906ea5e7f',
  user_id: '7c7b1e4d-a859-47a3-a2fc-1ab584ab5a73',
  label: 'Claude Desktop',
  key_prefix: 'scrapy_abcdef',
  created_at: '2026-11-11T00:00:00.000Z',
  last_used_at: null,
  revoked_at: null,
  per_minute_limit: 30,
  daily_limit: 500,
};

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://scrapy-test.supabase.co');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'test-anon-key');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-key');
  fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.endsWith('/rest/v1/rpc/consume_scrapy_api_key_call')) return Response.json({ allowed: true });
    if (url.pathname.endsWith('/rest/v1/rpc/get_scrapy_api_key_usage')) {
      return Response.json([{ key_id: createdRow.id, minute_calls: 7, daily_calls: 123, per_minute_limit: 30, daily_limit: 500 }]);
    }
    if (url.pathname.endsWith('/rest/v1/scrapy_api_keys')) {
      if (init?.method === 'POST') return Response.json(createdRow, { status: 201 });
      if (url.searchParams.has('order')) return Response.json([createdRow]);
      return Response.json({ id: createdRow.id, user_id: createdRow.user_id, label: createdRow.label, per_minute_limit: 30, daily_limit: 500 });
    }
    return Response.json({ message: `Unexpected test URL: ${url}` }, { status: 404 });
  });
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('account API keys', () => {
  it('stores only a hash and returns a fresh token once', async () => {
    const user = { id: createdRow.user_id, email: 'person@example.com' } as never;
    const { key, record } = await createAccountKey(user, 'Claude Desktop');
    expect(key).toMatch(/^scrapy_[A-Za-z0-9_-]{43}$/);
    expect(record).toMatchObject({ label: 'Claude Desktop', per_minute_limit: 30, daily_limit: 500 });
    const [, init] = fetchSpy.mock.calls[0] ?? [];
    const body = JSON.parse(String(init?.body)) as { key_hash: string; user_id: string; label: string };
    expect(body).toMatchObject({ key_hash: createHash('sha256').update(key).digest('hex'), user_id: createdRow.user_id, label: 'Claude Desktop' });
    expect(body.key_hash).not.toContain(key);
  });

  it('authenticates by the token hash, never sending the raw key to storage', async () => {
    const key = 'scrapy_test-secret';
    const request = new Request('https://scrapy.example/api/mcp', { headers: { authorization: `Bearer ${key}` } });
    await expect(apiKeyForRequest(request)).resolves.toMatchObject({ id: createdRow.id, userId: createdRow.user_id });
    const called = new URL(String(fetchSpy.mock.calls[0]?.[0]));
    expect(called.searchParams.get('key_hash')).toBe(`eq.${createHash('sha256').update(key).digest('hex')}`);
    expect(called.href).not.toContain(key);
  });

  it('loads the current per-key counters for the allowance meters', async () => {
    const keys = await listAccountKeys(createdRow.user_id);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ id: createdRow.id, used_this_minute: 7, used_today: 123, per_minute_limit: 30, daily_limit: 500 });
    const usageCall = fetchSpy.mock.calls.find(([input]) => String(input).includes('/rpc/get_scrapy_api_key_usage'));
    expect(usageCall).toBeDefined();
    expect(JSON.parse(String(usageCall?.[1]?.body))).toEqual({ p_user_id: createdRow.user_id });
  });

  it('uses the durable quota RPC and rejects a key when its daily allowance is spent', async () => {
    await expect(checkAccountKeyAllowance(createdRow.id)).resolves.toBeUndefined();
    fetchSpy.mockImplementationOnce(async () => Response.json({ allowed: false, reason: 'daily_limit', daily_limit: 500 }));
    await expect(checkAccountKeyAllowance(createdRow.id)).rejects.toMatchObject({ reason: 'daily_limit' });
  });
});
