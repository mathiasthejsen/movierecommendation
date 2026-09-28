-- Supabase schema for the movie/TV recommender.
-- Run in the Supabase SQL editor (or `supabase db push` with this file as a migration).
--
-- Access model (family-only):
--   * Open sign-ups are DISABLED in Supabase Auth; family members are invited from the dashboard.
--   * The browser uses the anon/publishable key. Row-level security protects every table.
--   * ratings / watchlist: each person reads and writes only their own rows.
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

drop policy if exists "ratings: own rows" on public.ratings;
create policy "ratings: own rows" on public.ratings
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "watchlist: own rows" on public.watchlist;
create policy "watchlist: own rows" on public.watchlist
  for all to authenticated
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
revoke all on public.ratings, public.watchlist, public.curator_picks from anon;
grant select, insert, update, delete on public.ratings, public.watchlist, public.curator_picks to authenticated;

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
