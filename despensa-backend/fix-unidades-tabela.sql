-- Nova tabela: units.
--
-- Antes, a lista de unidades (kg, L, un, pacote, cx, garrafa) ficava
-- fixa no código do site — só quem mexesse no código podia mudar. Isso
-- move a lista pro banco de dados, do mesmo jeito que já funciona pra
-- Categorias: agora um(a) administrador(a) pode adicionar ou remover
-- unidades pela própria tela (Cadastro → Unidades), sem precisar editar
-- código nem publicar nada de novo.
--
-- Rode isto no SQL Editor do Supabase (não precisa rodar o schema.sql
-- inteiro de novo, só isto). Seguro rodar mais de uma vez.

create table if not exists public.units (
  id uuid primary key default gen_random_uuid(),
  nome text not null unique,
  created_at timestamptz not null default now()
);
comment on table public.units is 'Unidades de medida disponíveis para os produtos (kg, L, un, caixa, etc.) — cadastradas por um(a) administrador(a) pela tela Cadastro → Unidades.';

alter table public.units enable row level security;

-- units: todo mundo logado lê (precisa pra montar os menus de "Unidade"
-- nas telas de produto); só admin cadastra/edita/remove — mesma regra
-- já usada em categories.
drop policy if exists "units_select_authenticated" on public.units;
create policy "units_select_authenticated" on public.units
  for select using (auth.role() = 'authenticated');

drop policy if exists "units_write_admin" on public.units;
create policy "units_write_admin" on public.units
  for insert with check (public.is_admin());

drop policy if exists "units_update_admin" on public.units;
create policy "units_update_admin" on public.units
  for update using (public.is_admin());

drop policy if exists "units_delete_admin" on public.units;
create policy "units_delete_admin" on public.units
  for delete using (public.is_admin());

-- Semeia as mesmas unidades que já existiam fixas no código, pra
-- ninguém perder nenhuma opção que já estava em uso. Seguro rodar de
-- novo — "on conflict do nothing" não duplica.
insert into public.units (nome) values
  ('kg'), ('L'), ('un'), ('pacote'), ('cx'), ('garrafa')
on conflict (nome) do nothing;

-- audit_log.tipo tinha uma lista fixa de categorias de ação permitidas;
-- precisa incluir 'unidade' pra registrar quando alguém cria/remove uma
-- unidade (mesma trilha de auditoria que já existe pra categoria).
alter table public.audit_log drop constraint if exists audit_log_tipo_check;
alter table public.audit_log add constraint audit_log_tipo_check
  check (tipo in ('perfil','categoria','unidade','config','arquivamento','produto','ajuste'));
