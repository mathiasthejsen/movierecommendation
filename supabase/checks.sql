-- Sanity checks for supabase/schema.sql. Run in the SQL editor after applying the schema.
-- Each query should return zero rows / `true`. Nothing here modifies data.

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
