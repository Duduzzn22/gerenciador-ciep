-- Importação do ESTOQUE FINAL da planilha do mês anterior como
-- ESTOQUE INICIAL do mês atual na Despensa Digital.
--
-- A importação NÃO cria movimentação de "entrada", porque estoque inicial
-- é saldo carregado do mês anterior. Se já existirem movimentações no mês
-- atual, a função recalcula:
--   estoque atual = estoque inicial importado + entradas - saídas
-- preservando tudo que já foi registrado no app.
--
-- Seguro rodar mais de uma vez.

create table if not exists public.estoque_inicial_planilha (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.items(id) on delete cascade,
  ano int not null check (ano between 2020 and 2100),
  mes int not null check (mes between 1 and 12),
  quantidade numeric not null check (quantidade >= 0),
  genero_planilha text,
  arquivo_origem text,
  importado_por text,
  importado_em timestamptz not null default now(),
  atualizado_em timestamptz,
  unique (item_id, ano, mes)
);

comment on table public.estoque_inicial_planilha is
  'Saldo inicial mensal importado da coluna Estoque Final da aba MENSAL do mês anterior.';

alter table public.estoque_inicial_planilha enable row level security;

drop policy if exists "estoque_inicial_planilha_select_admin" on public.estoque_inicial_planilha;
create policy "estoque_inicial_planilha_select_admin" on public.estoque_inicial_planilha
  for select using (public.is_admin());

drop policy if exists "estoque_inicial_planilha_insert_admin" on public.estoque_inicial_planilha;
create policy "estoque_inicial_planilha_insert_admin" on public.estoque_inicial_planilha
  for insert with check (public.is_admin());

drop policy if exists "estoque_inicial_planilha_update_admin" on public.estoque_inicial_planilha;
create policy "estoque_inicial_planilha_update_admin" on public.estoque_inicial_planilha
  for update using (public.is_admin());

drop policy if exists "estoque_inicial_planilha_delete_admin" on public.estoque_inicial_planilha;
create policy "estoque_inicial_planilha_delete_admin" on public.estoque_inicial_planilha
  for delete using (public.is_admin());

create or replace function public.aplicar_estoque_inicial_planilha(
  p_ano int,
  p_mes int,
  p_arquivo text,
  p_itens jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inicio timestamptz;
  v_fim timestamptz;
  v_nome text;
  v_item jsonb;
  v_item_id uuid;
  v_item_nome text;
  v_genero text;
  v_qtd numeric;
  v_saldo_mov numeric;
  v_nova_qtd numeric;
  v_total int := 0;
  v_resultados jsonb := '[]'::jsonb;
begin
  if not public.is_admin() then
    raise exception 'só um administrador pode importar o estoque inicial';
  end if;
  if p_ano is null or p_ano < 2020 or p_ano > 2100 or p_mes is null or p_mes < 1 or p_mes > 12 then
    raise exception 'ano/mês inválidos';
  end if;
  if p_itens is null or jsonb_typeof(p_itens) <> 'array' or jsonb_array_length(p_itens) = 0 then
    raise exception 'nenhum item válido foi enviado';
  end if;

  select name into v_nome from public.profiles where id = auth.uid();
  v_inicio := make_timestamptz(p_ano, p_mes, 1, 0, 0, 0, 'America/Sao_Paulo');
  if p_mes = 12 then
    v_fim := make_timestamptz(p_ano + 1, 1, 1, 0, 0, 0, 'America/Sao_Paulo');
  else
    v_fim := make_timestamptz(p_ano, p_mes + 1, 1, 0, 0, 0, 'America/Sao_Paulo');
  end if;

  for v_item in select value from jsonb_array_elements(p_itens)
  loop
    begin
      v_item_id := (v_item->>'item_id')::uuid;
      v_qtd := (v_item->>'estoque_inicial')::numeric;
      v_genero := nullif(trim(v_item->>'genero_planilha'), '');
    exception when others then
      raise exception 'item da importação possui formato inválido';
    end;

    if v_qtd is null or v_qtd <= 0 then
      continue;
    end if;

    select i.name into v_item_nome
    from public.items i
    join public.categories c on c.id = i.category_id
    where i.id = v_item_id and c.area = 'cozinha'
    for update of i;

    if not found then
      raise exception 'produto de Cozinha não encontrado: %', v_item_id;
    end if;

    insert into public.estoque_inicial_planilha
      (item_id, ano, mes, quantidade, genero_planilha, arquivo_origem, importado_por, importado_em, atualizado_em)
    values
      (v_item_id, p_ano, p_mes, v_qtd, v_genero, coalesce(p_arquivo,''), coalesce(v_nome,'Admin'), now(), now())
    on conflict (item_id, ano, mes) do update
      set quantidade = excluded.quantidade,
          genero_planilha = excluded.genero_planilha,
          arquivo_origem = excluded.arquivo_origem,
          importado_por = excluded.importado_por,
          atualizado_em = now();

    select coalesce(sum(case when m.type = 'entrada' then m.qty else -m.qty end), 0)
    into v_saldo_mov
    from public.movements m
    where m.item_id = v_item_id
      and not m.estornado
      and m.at >= v_inicio
      and m.at < v_fim;

    v_nova_qtd := greatest(0, v_qtd + v_saldo_mov);

    update public.items
      set qty = v_nova_qtd,
          ajustado_por = coalesce(v_nome,'Admin'),
          ajustado_em = now()
      where id = v_item_id;

    v_total := v_total + 1;
    v_resultados := v_resultados || jsonb_build_array(jsonb_build_object(
      'item_id', v_item_id,
      'item_nome', v_item_nome,
      'estoque_inicial', v_qtd,
      'movimentacao_liquida_mes', v_saldo_mov,
      'estoque_atual', v_nova_qtd
    ));
  end loop;

  insert into public.audit_log (tipo, descricao, actor_id, em)
  values (
    'ajuste',
    coalesce(v_nome,'Admin') || ' importou o estoque inicial de ' ||
      lpad(p_mes::text,2,'0') || '/' || p_ano || ' a partir de "' ||
      coalesce(p_arquivo,'planilha') || '" — ' || v_total ||
      ' produto(s) atualizado(s).',
    auth.uid(),
    now()
  );

  return jsonb_build_object(
    'ok', true,
    'atualizados', v_total,
    'ano', p_ano,
    'mes', p_mes,
    'arquivo', p_arquivo,
    'itens', v_resultados
  );
end;
$$;
