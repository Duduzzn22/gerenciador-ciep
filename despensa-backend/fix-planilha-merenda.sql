-- Nova tabela + coluna + função: sincronização com o Mapa de Merenda
-- (planilha Excel do Google Drive).
--
-- O que isto adiciona:
--   1) planilha_merenda_mapa: pra cada item de Cozinha, guarda qual é o
--      texto exato da coluna "Gênero" na planilha (é assim que o sistema
--      sabe em qual linha escrever).
--   2) movements.sincronizado_planilha_em: marca quando uma movimentação
--      já foi levada pra planilha (fica nulo até a sincronização
--      acontecer — é isso que faz as movimentações "esperarem" quando a
--      planilha do mês ainda não existe).
--   3) marcar_movimentos_sincronizados(): função segura que o app usa pra
--      marcar como sincronizadas só as movimentações que realmente foram
--      escritas na planilha com sucesso (só administrador pode chamar).
--
-- Rode isto no SQL Editor do Supabase (não precisa rodar o schema.sql
-- inteiro de novo, só isto). Seguro rodar mesmo que já tenha rodado antes.

create table if not exists public.planilha_merenda_mapa (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null unique references public.items(id) on delete cascade,
  genero_planilha text not null,
  unidade_planilha text,
  criado_por text,
  criado_em timestamptz not null default now(),
  atualizado_por text,
  atualizado_em timestamptz
);
comment on table public.planilha_merenda_mapa is 'Pra cada item de Cozinha, qual linha ("Gênero") do Mapa de Merenda (planilha Excel) ele corresponde.';

alter table public.planilha_merenda_mapa enable row level security;

drop policy if exists "planilha_merenda_mapa_select_admin" on public.planilha_merenda_mapa;
create policy "planilha_merenda_mapa_select_admin" on public.planilha_merenda_mapa
  for select using (public.is_admin());
drop policy if exists "planilha_merenda_mapa_insert_admin" on public.planilha_merenda_mapa;
create policy "planilha_merenda_mapa_insert_admin" on public.planilha_merenda_mapa
  for insert with check (public.is_admin());
drop policy if exists "planilha_merenda_mapa_update_admin" on public.planilha_merenda_mapa;
create policy "planilha_merenda_mapa_update_admin" on public.planilha_merenda_mapa
  for update using (public.is_admin());
drop policy if exists "planilha_merenda_mapa_delete_admin" on public.planilha_merenda_mapa;
create policy "planilha_merenda_mapa_delete_admin" on public.planilha_merenda_mapa
  for delete using (public.is_admin());

-- Marca quando cada movimentação foi levada com sucesso pra planilha.
-- Fica NULL até a sincronização acontecer — é assim que a tela de
-- sincronização sabe quais movimentações ainda estão pendentes.
alter table public.movements add column if not exists sincronizado_planilha_em timestamptz;

-- Movimentações não passam por UPDATE/INSERT direto pra ninguém (nem
-- administrador) — sempre por uma função segura que confere a regra antes
-- de mexer, seguindo o mesmo padrão de registrar_movimento/
-- estornar_movimento já usado no resto do sistema. Esta função só marca a
-- data de sincronização (nunca mexe em quantidade, tipo, etc.) e só
-- aceita movimentações que ainda não tinham sido marcadas.
create or replace function public.marcar_movimentos_sincronizados(p_ids uuid[])
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total int;
begin
  if not public.is_admin() then
    raise exception 'só um administrador pode confirmar a sincronização com a planilha';
  end if;

  update public.movements
    set sincronizado_planilha_em = now()
    where id = any(p_ids) and sincronizado_planilha_em is null;
  get diagnostics v_total = row_count;

  return v_total;
end;
$$;
