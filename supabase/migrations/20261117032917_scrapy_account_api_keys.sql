-- Optional multi-user mode: one verified Supabase Auth account can issue several MCP keys.
-- The raw API key is returned once by Scrapy; only its SHA-256 hash is stored here.
create table if not exists public.scrapy_api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  label text not null check (char_length(label) between 1 and 64),
  key_hash text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  key_prefix text not null check (char_length(key_prefix) between 8 and 20),
  per_minute_limit integer not null default 30 check (per_minute_limit between 1 and 10000),
  daily_limit integer not null default 500 check (daily_limit between 1 and 1000000),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index if not exists scrapy_api_keys_user_created on public.scrapy_api_keys (user_id, created_at desc);
create index if not exists scrapy_api_keys_active_hash on public.scrapy_api_keys (key_hash) where revoked_at is null;

-- Each key has only two small rolling counters, one for the current UTC minute and one for today.
create table if not exists public.scrapy_api_key_usage (
  key_id uuid primary key references public.scrapy_api_keys(id) on delete cascade,
  minute_bucket timestamptz not null default date_trunc('minute', now()),
  minute_calls integer not null default 0 check (minute_calls >= 0),
  day_bucket date not null default (now() at time zone 'utc')::date,
  day_calls integer not null default 0 check (day_calls >= 0)
);

alter table public.scrapy_api_keys enable row level security;
alter table public.scrapy_api_key_usage enable row level security;
revoke all on public.scrapy_api_keys, public.scrapy_api_key_usage from public, anon, authenticated;
grant all on public.scrapy_api_keys, public.scrapy_api_key_usage to service_role;

create or replace function public.consume_scrapy_api_key_call(p_key_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_key public.scrapy_api_keys%rowtype;
  v_usage public.scrapy_api_key_usage%rowtype;
  v_minute timestamptz := date_trunc('minute', now());
  v_day date := (now() at time zone 'utc')::date;
  v_minute_calls integer;
  v_day_calls integer;
  v_retry integer;
begin
  -- Lock the key row to serialize concurrent calls and make revocation immediate.
  select * into v_key from public.scrapy_api_keys where id = p_key_id and revoked_at is null for update;
  if not found then
    return jsonb_build_object('allowed', false, 'reason', 'invalid_key');
  end if;

  insert into public.scrapy_api_key_usage (key_id) values (p_key_id) on conflict (key_id) do nothing;
  select * into v_usage from public.scrapy_api_key_usage where key_id = p_key_id for update;
  v_minute_calls := case when v_usage.minute_bucket = v_minute then v_usage.minute_calls else 0 end;
  v_day_calls := case when v_usage.day_bucket = v_day then v_usage.day_calls else 0 end;

  if v_day_calls >= v_key.daily_limit then
    return jsonb_build_object('allowed', false, 'reason', 'daily_limit', 'daily_limit', v_key.daily_limit);
  end if;
  if v_minute_calls >= v_key.per_minute_limit then
    v_retry := greatest(1, ceil(60 - extract(epoch from (now() - v_minute)))::integer);
    return jsonb_build_object('allowed', false, 'reason', 'minute_limit', 'retry_after', v_retry);
  end if;

  update public.scrapy_api_key_usage
    set minute_bucket = v_minute,
        minute_calls = v_minute_calls + 1,
        day_bucket = v_day,
        day_calls = v_day_calls + 1
    where key_id = p_key_id;
  update public.scrapy_api_keys set last_used_at = now() where id = p_key_id;
  return jsonb_build_object('allowed', true, 'minute_calls', v_minute_calls + 1, 'daily_calls', v_day_calls + 1);
end;
$$;
revoke all on function public.consume_scrapy_api_key_call(uuid) from public, anon, authenticated;
grant execute on function public.consume_scrapy_api_key_call(uuid) to service_role;

-- Read the live counters for the signed-in user's dashboard progress bars.
-- The database clock defines both buckets so UI/server clock skew cannot expose stale usage.
create or replace function public.get_scrapy_api_key_usage(p_user_id uuid)
returns table (
  key_id uuid,
  minute_calls integer,
  daily_calls integer,
  per_minute_limit integer,
  daily_limit integer
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    k.id,
    case when u.minute_bucket = date_trunc('minute', now()) then coalesce(u.minute_calls, 0) else 0 end,
    case when u.day_bucket = (now() at time zone 'utc')::date then coalesce(u.day_calls, 0) else 0 end,
    k.per_minute_limit,
    k.daily_limit
  from public.scrapy_api_keys as k
  left join public.scrapy_api_key_usage as u on u.key_id = k.id
  where k.user_id = p_user_id;
$$;
revoke all on function public.get_scrapy_api_key_usage(uuid) from public, anon, authenticated;
grant execute on function public.get_scrapy_api_key_usage(uuid) to service_role;
