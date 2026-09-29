-- Supabase schema for the movie/TV recommender.
-- Run in the Supabase SQL editor (or `supabase db push` with this file as a migration).
--
-- Access model (family-only):
--   * Open sign-ups are DISABLED in Supabase Auth; family members are invited from the dashboard.
--   * The browser uses the anon/publishable key. Row-level security protects every table.
--   * ratings: private. Each person reads and writes only their own rows.
--   * watchlist: each person writes only their own rows. Every signed-in family member can
--     read everyone's watchlist, unless that person turned sharing off
--     (profiles.share_watchlist = false). Enforced in RLS, not just the UI.
--   * profiles: display name + sharing setting. Everyone signed in can read them; each person
--     can insert/update only their own row. No emails are stored here.
--   * curator_picks: every signed-in family member can read all picks; only the person who
--     added a pick can insert, update or delete it.
--   * tmdb_proxy_usage: no client access at all; used by the Edge Function for rate limiting.
--
-- Titles use composite keys: 'movie:<tmdb id>' or 'tv:<tmdb id>'.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------------
-- ratings
create table if not exists public.ratings (
  user_id     uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  media_key   text        not null check (media_key ~ '^(movie|tv):[0-9]+$'),
  kind        text        not null check (kind in ('thumb', 'star')),
  value       smallint    not null,
  title       text        check (char_length(title) <= 300),
  year        smallint,
  poster_path text        check (char_length(poster_path) <= 200),
  updated_at  timestamptz not null default now(),
  primary key (user_id, media_key),
  constraint ratings_value_range check (
    (kind = 'thumb' and value in (-1, 1)) or (kind = 'star' and value between 1 and 5)
  )
);

-- ---------------------------------------------------------------------------------
-- watchlist
create table if not exists public.watchlist (
  user_id     uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  media_key   text        not null check (media_key ~ '^(movie|tv):[0-9]+$'),
  title       text        check (char_length(title) <= 300),
  year        smallint,
  poster_path text        check (char_length(poster_path) <= 200),
  added_at    timestamptz not null default now(),
  primary key (user_id, media_key)
);

-- ---------------------------------------------------------------------------------
-- profiles: family display names and the watchlist-sharing setting.
create table if not exists public.profiles (
  user_id         uuid        primary key default auth.uid() references auth.users (id) on delete cascade,
  display_name    text        not null check (char_length(btrim(display_name)) between 1 and 40),
  share_watchlist boolean     not null default true,
  created_at      timestamptz not null default now()
);
-- Safe to re-run on older installs that created the table without the setting.
alter table public.profiles add column if not exists share_watchlist boolean not null default true;

-- ---------------------------------------------------------------------------------
-- curator_picks: titles recommended by an Instagram/TikTok curator, added via the
-- Share Target or the manual form. No captions or media are stored.
create table if not exists public.curator_picks (
  id          uuid        primary key default gen_random_uuid(),
  media_key   text        not null check (media_key ~ '^(movie|tv):[0-9]+$'),
  curator     text        not null check (curator ~ '^[A-Za-z0-9._]{1,30}$'),
  post_url    text        check (post_url is null or (post_url ~ '^https://' and char_length(post_url) <= 500)),
  source      text        not null default 'share' check (source in ('share', 'manual')),
  added_by    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  title       text        check (char_length(title) <= 300),
  year        smallint,
  poster_path text        check (char_length(poster_path) <= 200),
  created_at  timestamptz not null default now(),
  unique (media_key, curator, added_by)
);
create index if not exists curator_picks_media_key_idx on public.curator_picks (media_key);

-- ---------------------------------------------------------------------------------
-- Row-level security
alter table public.ratings       enable row level security;
alter table public.watchlist     enable row level security;
alter table public.curator_picks enable row level security;
alter table public.profiles      enable row level security;

drop policy if exists "ratings: own rows" on public.ratings;
create policy "ratings: own rows" on public.ratings
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- Watchlist: read your own rows, plus other family members' rows unless they turned
-- sharing off. A member without a profile row counts as sharing (the default).
drop policy if exists "watchlist: own rows" on public.watchlist;
drop policy if exists "watchlist: read own or shared" on public.watchlist;
create policy "watchlist: read own or shared" on public.watchlist
  for select to authenticated
  using (
    (select auth.uid()) = user_id
    or not exists (
      select 1 from public.profiles p
       where p.user_id = watchlist.user_id and p.share_watchlist = false
    )
  );

drop policy if exists "watchlist: insert own" on public.watchlist;
create policy "watchlist: insert own" on public.watchlist
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "watchlist: update own" on public.watchlist;
create policy "watchlist: update own" on public.watchlist
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "watchlist: delete own" on public.watchlist;
create policy "watchlist: delete own" on public.watchlist
  for delete to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "profiles: family can read" on public.profiles;
create policy "profiles: family can read" on public.profiles
  for select to authenticated
  using (true);

drop policy if exists "profiles: insert own" on public.profiles;
create policy "profiles: insert own" on public.profiles
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "profiles: update own" on public.profiles;
create policy "profiles: update own" on public.profiles
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "picks: family can read" on public.curator_picks;
create policy "picks: family can read" on public.curator_picks
  for select to authenticated
  using (true);

drop policy if exists "picks: insert own" on public.curator_picks;
create policy "picks: insert own" on public.curator_picks
  for insert to authenticated
  with check ((select auth.uid()) = added_by);

drop policy if exists "picks: update own" on public.curator_picks;
create policy "picks: update own" on public.curator_picks
  for update to authenticated
  using ((select auth.uid()) = added_by)
  with check ((select auth.uid()) = added_by);

drop policy if exists "picks: delete own" on public.curator_picks;
create policy "picks: delete own" on public.curator_picks
  for delete to authenticated
  using ((select auth.uid()) = added_by);

-- The anon role (not signed in) gets nothing.
revoke all on public.ratings, public.watchlist, public.curator_picks, public.profiles from anon;
grant select, insert, update, delete on public.ratings, public.watchlist, public.curator_picks to authenticated;
revoke delete on public.profiles from authenticated;
grant select, insert, update on public.profiles to authenticated;

-- ---------------------------------------------------------------------------------
-- Per-user rate limiting for the TMDB proxy Edge Function (fixed window).
create table if not exists public.tmdb_proxy_usage (
  user_id      uuid        primary key references auth.users (id) on delete cascade,
  window_start timestamptz not null default now(),
  count        integer     not null default 0
);
alter table public.tmdb_proxy_usage enable row level security;
-- No policies: clients can't read or write it. Only the service role (Edge Function) can.
revoke all on public.tmdb_proxy_usage from anon, authenticated;

create or replace function public.tmdb_proxy_consume(p_user uuid, p_limit integer, p_window_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  allowed boolean;
begin
  insert into public.tmdb_proxy_usage as u (user_id, window_start, count)
  values (p_user, now(), 1)
  on conflict (user_id) do update
    set window_start = case when u.window_start < now() - make_interval(secs => p_window_seconds) then now() else u.window_start end,
        count        = case when u.window_start < now() - make_interval(secs => p_window_seconds) then 1 else u.count + 1 end
  returning u.count <= p_limit into allowed;
  return allowed;
end;
$$;

revoke all on function public.tmdb_proxy_consume(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.tmdb_proxy_consume(uuid, integer, integer) to service_role;

-- ---------------------------------------------------------------------------------
-- Keep-alive: free Supabase projects pause after a week without activity. The GitHub
-- workflow calls this twice a week with the public anon key. It reads no data.
create or replace function public.keepalive()
returns timestamptz
language sql
stable
as $$ select now() $$;

revoke all on function public.keepalive() from public;
grant execute on function public.keepalive() to anon, authenticated;

-- ---------------------------------------------------------------------------------
-- "Update data now": on-demand pipeline triggers (trigger-pipeline Edge Function).
-- At most one per hour for the whole family. Only the service role can read or write.
create table if not exists public.pipeline_runs (
  id            bigint generated always as identity primary key,
  triggered_by  uuid references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  github_status text not null default 'pending' check (github_status in ('pending', 'dispatched', 'failed'))
);
create index if not exists pipeline_runs_created_at_idx on public.pipeline_runs (created_at desc);
alter table public.pipeline_runs enable row level security;
-- No policies: clients can't read or write it.
revoke all on public.pipeline_runs from anon, authenticated;

-- Atomically re-check the family-wide cooldown and record a pending trigger.
-- Failed dispatches don't count toward the cooldown.
create or replace function public.pipeline_reserve(p_user uuid, p_cooldown_seconds integer)
returns table (ok boolean, retry_after_seconds integer, run_id bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  last_at timestamptz;
  new_id  bigint;
begin
  perform pg_advisory_xact_lock(hashtext('public.pipeline_reserve'));
  select r.created_at into last_at
    from public.pipeline_runs r
   where r.github_status in ('pending', 'dispatched')
   order by r.created_at desc
   limit 1;
  if last_at is not null and last_at > now() - make_interval(secs => p_cooldown_seconds) then
    return query select false,
      greatest(1, ceil(extract(epoch from (last_at + make_interval(secs => p_cooldown_seconds) - now())))::integer),
      null::bigint;
    return;
  end if;
  insert into public.pipeline_runs (triggered_by) values (p_user) returning id into new_id;
  return query select true, 0, new_id;
end;
$$;

revoke all on function public.pipeline_reserve(uuid, integer) from public, anon, authenticated;
grant execute on function public.pipeline_reserve(uuid, integer) to service_role;
