-- Corrige a área "Ambas" para pessoas de papel "padrão".
-- Rode isto no SQL Editor do Supabase (não precisa rodar o schema.sql
-- inteiro de novo, só isto).
--
-- O que estava acontecendo: era possível marcar a área de uma pessoa
-- padrão como "Ambas" (cozinha e limpeza), mas o banco não reconhecia esse
-- valor — as regras de permissão só comparavam a área da pessoa com a área
-- da categoria (cozinha=cozinha ou limpeza=limpeza), e "ambas" nunca é
-- igual a "cozinha" nem a "limpeza". Na prática, uma pessoa marcada como
-- "Ambas" não conseguia ver NENHUM item nem registrar NENHUMA
-- entrada/saída — ficava com a tela vazia.
--
-- Agora: sempre que a área da pessoa for "ambas", ela tem acesso de leitura
-- e de ajuste às duas áreas (cozinha e limpeza), sem precisar ser
-- administradora.

create or replace function public.registrar_movimento(
  p_item_id uuid,
  p_tipo text,
  p_qty numeric,
  p_unidade text,
  p_fornecedor text default '',
  p_motivo text default '',
  p_nota text default ''
)
returns public.movements
language plpgsql
security definer
set search_path = public
as $$
declare
  v_area_item text;
  v_qty_atual numeric;
  v_delta numeric;
  v_nome text;
  v_mov public.movements;
begin
  if p_tipo not in ('entrada','saida') then
    raise exception 'tipo inválido: %', p_tipo;
  end if;
  if p_qty is null or p_qty <= 0 then
    raise exception 'quantidade precisa ser maior que zero';
  end if;

  select c.area, i.qty into v_area_item, v_qty_atual
  from public.items i join public.categories c on c.id = i.category_id
  where i.id = p_item_id
  for update of i;

  if not found then
    raise exception 'item não encontrado';
  end if;

  if not (public.is_admin() or v_area_item = public.my_area() or public.my_area() = 'ambas') then
    raise exception 'sem permissão para esta área';
  end if;

  select name into v_nome from public.profiles where id = auth.uid();

  v_delta := case when p_tipo = 'entrada' then p_qty else -p_qty end;
  update public.items
    set qty = greatest(0, qty + v_delta),
        unit = p_unidade,
        ajustado_por = v_nome,
        ajustado_em = now()
    where id = p_item_id;

  insert into public.movements (item_id, type, qty, unidade, who_id, who_name, fornecedor, motivo, nota, at)
  values (p_item_id, p_tipo, p_qty, p_unidade, auth.uid(), coalesce(v_nome, 'desconhecido'),
          p_fornecedor, p_motivo, p_nota, now())
  returning * into v_mov;

  return v_mov;
end;
$$;

create or replace function public.estornar_movimento(p_mov_id uuid)
returns public.movements
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mov public.movements;
  v_area_item text;
  v_nome text;
begin
  select m.* into v_mov from public.movements m where m.id = p_mov_id for update;
  if not found then raise exception 'movimentação não encontrada'; end if;
  if v_mov.estornado then raise exception 'movimentação já estornada'; end if;

  select c.area into v_area_item
  from public.items i join public.categories c on c.id = i.category_id
  where i.id = v_mov.item_id;

  if not (public.is_admin() or v_area_item = public.my_area() or public.my_area() = 'ambas') then
    raise exception 'sem permissão para esta área';
  end if;

  select name into v_nome from public.profiles where id = auth.uid();

  update public.items
    set qty = greatest(0, qty + (case when v_mov.type = 'entrada' then -v_mov.qty else v_mov.qty end))
    where id = v_mov.item_id;

  update public.movements
    set estornado = true, estornado_por = auth.uid(), estornado_por_nome = v_nome, estornado_em = now()
    where id = p_mov_id
    returning * into v_mov;

  return v_mov;
end;
$$;

drop policy if exists "items_select_por_area" on public.items;
create policy "items_select_por_area" on public.items
  for select using (
    public.is_admin()
    or public.my_area() = 'ambas'
    or exists (select 1 from public.categories c where c.id = items.category_id and c.area = public.my_area())
  );

drop policy if exists "items_update_por_area" on public.items;
create policy "items_update_por_area" on public.items
  for update using (
    public.is_admin()
    or public.my_area() = 'ambas'
    or exists (select 1 from public.categories c where c.id = items.category_id and c.area = public.my_area())
  );

drop policy if exists "movements_select_por_area" on public.movements;
create policy "movements_select_por_area" on public.movements
  for select using (
    public.is_admin()
    or public.my_area() = 'ambas'
    or exists (
      select 1 from public.items i join public.categories c on c.id = i.category_id
      where i.id = movements.item_id and c.area = public.my_area()
    )
  );
