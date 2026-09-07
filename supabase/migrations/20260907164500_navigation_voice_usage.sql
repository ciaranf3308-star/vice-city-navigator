-- Vice City Navigator — navigation-voice daily usage counter.
--
-- One row per calendar day; bumped atomically by the Edge Function BEFORE it
-- spends anything on OpenAI. When the count passes VOICE_DAILY_CAP the
-- function answers 429, so a client bug can never hammer the OpenAI balance.
-- This cap is INDEPENDENT of the Google Places quota.
--
-- Run once in the Supabase SQL editor (or via the CLI).

create table if not exists public.navigation_voice_usage (
  day        date        primary key,
  count      integer     not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.navigation_voice_usage enable row level security;
-- Deliberately NO public policies: only the service_role key (used by the
-- Edge Function, which bypasses RLS) may touch this table.

create or replace function public.navigation_voice_bump()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  c integer;
begin
  insert into public.navigation_voice_usage (day, count)
  values (current_date, 1)
  on conflict (day) do update
    set count      = public.navigation_voice_usage.count + 1,
        updated_at = now();

  select count into c
  from public.navigation_voice_usage
  where day = current_date;

  -- housekeeping: keep the table tiny
  delete from public.navigation_voice_usage
  where day < current_date - interval '30 days';

  return c;
end;
$$;

-- Only service_role may execute the bump. The anon key (shipped in the
-- client) must NOT be able to call it directly, or anyone could burn the
-- daily cap with bare RPC calls.
revoke all on function public.navigation_voice_bump() from public, anon, authenticated;
grant execute on function public.navigation_voice_bump() to service_role;
