-- Stub minimal do schema "auth" do Supabase, só o suficiente para simular
-- localmente RLS/policies/funções que dependem de auth.uid()/auth.role().
create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb not null default '{}'::jsonb
);

create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

create or replace function auth.role() returns text
language sql stable as $$
  select nullif(current_setting('request.jwt.claim.role', true), '');
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated;
  end if;
end
$$;

grant usage on schema auth to authenticated;
grant usage on schema public to authenticated;

-- Em produção (Supabase de verdade) o role "authenticated" já vem com esses
-- privilégios padrão configurados pela própria plataforma; aqui replicamos
-- isso manualmente pro simulador local funcionar do mesmo jeito.
alter default privileges in schema public grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public grant usage, select on sequences to authenticated;
alter default privileges in schema public grant execute on functions to authenticated;
