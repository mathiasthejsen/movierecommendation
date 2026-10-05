-- Sanity checks for supabase/schema.sql. Run in the SQL editor after applying the schema.
-- Each query should return zero rows / `true`. Nothing here modifies data: the behavioural
-- checks (4 and 8) run inside blocks that are always rolled back.

-- 1. RLS is enabled on every public table.
select relname as table_without_rls
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;

-- 2. The anon role has no table privileges.
select table_name, privilege_type
from information_schema.role_table_grants
where grantee = 'anon' and table_schema = 'public';

-- 3. Clients cannot call the rate-limit function.
select not has_function_privilege('authenticated', 'public.tmdb_proxy_consume(uuid, integer, integer)', 'execute')
   and not has_function_privilege('anon', 'public.tmdb_proxy_consume(uuid, integer, integer)', 'execute') as rate_limit_locked;

-- 4. Composite-key checks reject malformed keys (inside a rolled-back transaction).
begin;
  do $$
  begin
    begin
      insert into public.ratings (user_id, media_key, kind, value)
      values ('00000000-0000-0000-0000-000000000000', 'person:1', 'thumb', 1);
      raise exception 'bad key was accepted';
    exception when check_violation or foreign_key_violation then
      null; -- expected
    end;
  end $$;
rollback;

-- 5. Clients cannot touch pipeline triggers.
select not has_table_privilege('authenticated', 'public.pipeline_runs', 'select')
   and not has_table_privilege('anon', 'public.pipeline_runs', 'select')
   and not has_function_privilege('authenticated', 'public.pipeline_reserve(uuid, integer)', 'execute') as pipeline_locked;

-- 6. Signed-out visitors cannot read watchlists or profiles.
select not has_table_privilege('anon', 'public.watchlist', 'select')
   and not has_table_privilege('anon', 'public.profiles', 'select') as anon_cannot_read_watchlist_or_profiles;

-- 7. Ratings stay private: exactly one policy, own rows only.
select count(*) = 1
   and bool_and(cmd = 'ALL' and qual like '%auth.uid()%= user_id%' and qual not like '%profiles%') as ratings_own_rows_only
from pg_policies
where schemaname = 'public' and tablename = 'ratings';

-- 8. Behaviour, as a real signed-in user: family can read a shared watchlist, not a private
--    one, and never another person's ratings. Uses two throwaway users inside a savepoint that
--    is always rolled back. Raises an error if anything is wrong; otherwise the query after it
--    returns true.
do $$
declare
  a uuid := gen_random_uuid();
  b uuid := gen_random_uuid();
  seen_shared int;
  seen_private int;
  seen_own_private int;
  seen_ratings int;
  wrote_other int;
begin
  begin
    insert into auth.users (id, aud, role, email)
    values (a, 'authenticated', 'authenticated', a || '@checks.invalid'),
           (b, 'authenticated', 'authenticated', b || '@checks.invalid');
    insert into public.profiles (user_id, display_name, share_watchlist) values (a, 'Check A', true), (b, 'Check B', true);
    insert into public.watchlist (user_id, media_key) values (a, 'movie:603');
    insert into public.ratings (user_id, media_key, kind, value) values (a, 'movie:603', 'thumb', 1);

    -- As B: A's watchlist is visible while shared; A's ratings never are.
    perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    select count(*) into seen_shared from public.watchlist where user_id = a;
    select count(*) into seen_ratings from public.ratings where user_id = a;
    update public.watchlist set title = 'hijacked' where user_id = a;
    get diagnostics wrote_other = row_count;
    execute 'reset role';

    -- A turns sharing off: B can no longer see it, A still can.
    update public.profiles set share_watchlist = false where user_id = a;
    execute 'set local role authenticated';
    select count(*) into seen_private from public.watchlist where user_id = a;
    perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
    select count(*) into seen_own_private from public.watchlist where user_id = a;
    execute 'reset role';

    raise exception using errcode = 'P0001', message = 'rollback checks';
  exception when sqlstate 'P0001' then
    null; -- everything above is rolled back
  end;
  if seen_shared <> 1 or seen_private <> 0 or seen_own_private <> 1 or seen_ratings <> 0 or wrote_other <> 0 then
    raise exception 'watchlist sharing check FAILED: shared=%, private=%, own_private=%, others_ratings=%, wrote_other=%',
      seen_shared, seen_private, seen_own_private, seen_ratings, wrote_other;
  end if;
end $$;
select true as watchlist_sharing_enforced;
-- 9. Notifications and push subscriptions: no access for signed-out visitors; signed-in users
--    can't create or delete notifications and may only change read_at; the notify rate limit is
--    service-role only.
select not has_table_privilege('anon', 'public.notifications', 'select')
   and not has_table_privilege('anon', 'public.push_subscriptions', 'select')
   and not has_table_privilege('authenticated', 'public.notifications', 'insert')
   and not has_table_privilege('authenticated', 'public.notifications', 'delete')
   and has_column_privilege('authenticated', 'public.notifications', 'read_at', 'update')
   and not has_column_privilege('authenticated', 'public.notifications', 'title_key', 'update')
   and not has_column_privilege('authenticated', 'public.notifications', 'user_id', 'update')
   and not has_table_privilege('authenticated', 'public.notify_usage', 'select')
   and not has_function_privilege('authenticated', 'public.notify_consume(uuid, integer, integer)', 'execute')
   and not has_function_privilege('anon', 'public.notify_consume(uuid, integer, integer)', 'execute') as notifications_locked;

-- 10. Behaviour (rolled back, throwaway users only): a recipient sees and can mark their own
--     notification read; the actor can neither read nor insert notifications; push
--     subscriptions are own-rows only.
do $$
declare
  a uuid := gen_random_uuid(); -- actor
  b uuid := gen_random_uuid(); -- recipient
  b_sees int;
  a_sees int;
  a_marked int;
  b_marked int;
  a_inserted boolean := false;
  a_sub_for_b boolean := false;
  b_sees_a_sub int;
begin
  begin
    insert into auth.users (id, aud, role, email)
    values (a, 'authenticated', 'authenticated', a || '@checks.invalid'),
           (b, 'authenticated', 'authenticated', b || '@checks.invalid');
    insert into public.notifications (user_id, actor_id, title_key) values (b, a, 'movie:603');

    -- As A (the actor).
    perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    select count(*) into a_sees from public.notifications;
    update public.notifications set read_at = now() where user_id = b;
    get diagnostics a_marked = row_count;
    begin
      insert into public.notifications (user_id, actor_id, title_key) values (b, a, 'movie:604');
      a_inserted := true;
    exception when insufficient_privilege then null;
    end;
    insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values (a, 'https://push.checks.invalid/a', 'x', 'y');
    begin
      insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values (b, 'https://push.checks.invalid/b', 'x', 'y');
      a_sub_for_b := true;
    exception when insufficient_privilege or check_violation then null; -- RLS: new row violates policy
    end;
    execute 'reset role';

    -- As B (the recipient).
    perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    select count(*) into b_sees from public.notifications where user_id = b;
    update public.notifications set read_at = now() where user_id = b;
    get diagnostics b_marked = row_count;
    select count(*) into b_sees_a_sub from public.push_subscriptions where user_id = a;
    execute 'reset role';

    raise exception using errcode = 'P0001', message = 'rollback checks';
  exception when sqlstate 'P0001' then
    null; -- everything above is rolled back
  end;
  if b_sees <> 1 or b_marked <> 1 or a_sees <> 0 or a_marked <> 0 or a_inserted or a_sub_for_b or b_sees_a_sub <> 0 then
    raise exception 'notification RLS check FAILED: b_sees=%, b_marked=%, a_sees=%, a_marked=%, a_inserted=%, a_sub_for_b=%, b_sees_a_sub=%',
      b_sees, b_marked, a_sees, a_marked, a_inserted, a_sub_for_b, b_sees_a_sub;
  end if;
end $$;
select true as notifications_rls_enforced;
