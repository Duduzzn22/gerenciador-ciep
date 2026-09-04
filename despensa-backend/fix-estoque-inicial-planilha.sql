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


-- ============================================================================
-- V2: cadastro automático + soma segura ao estoque existente
-- ============================================================================
-- Regras:
--   * item já cadastrado -> soma o valor importado ao estoque atual;
--   * item inexistente -> cria automaticamente na categoria "Merenda";
--   * reimportar o mesmo mês não duplica: aplica somente a diferença
--     entre o valor novo da planilha e o valor já importado anteriormente.
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
  v_nome_admin text;
  v_categoria_merenda uuid;
  v_categoria_area text;
  v_item jsonb;
  v_item_id uuid;
  v_item_nome text;
  v_nome_planilha text;
  v_genero text;
  v_unidade_raw text;
  v_unidade text;
  v_qtd numeric;
  v_importado_anterior numeric;
  v_delta numeric;
  v_qty_antes numeric;
  v_qty_depois numeric;
  v_criado boolean;
  v_criados int := 0;
  v_atualizados int := 0;
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

  select name into v_nome_admin from public.profiles where id = auth.uid();

  -- Categoria padrão para itens novos vindos do Mapa de Merenda.
  insert into public.categories (nome, area)
  values ('Merenda', 'cozinha')
  on conflict (nome) do nothing;

  select id, area into v_categoria_merenda, v_categoria_area
  from public.categories
  where nome = 'Merenda'
  limit 1;

  if v_categoria_merenda is null or v_categoria_area <> 'cozinha' then
    raise exception 'não foi possível preparar a categoria "Merenda" na área Cozinha';
  end if;

  for v_item in select value from jsonb_array_elements(p_itens)
  loop
    v_item_id := null;
    v_criado := false;

    begin
      if nullif(v_item->>'item_id','') is not null then
        v_item_id := (v_item->>'item_id')::uuid;
      end if;
      v_qtd := (v_item->>'estoque_inicial')::numeric;
      v_nome_planilha := nullif(trim(v_item->>'nome_produto'), '');
      v_genero := coalesce(nullif(trim(v_item->>'genero_planilha'), ''), v_nome_planilha);
      v_unidade_raw := coalesce(nullif(trim(v_item->>'unidade_planilha'), ''), 'Unid.');
    exception when others then
      raise exception 'item da importação possui formato inválido';
    end;

    if v_qtd is null or v_qtd <= 0 or v_nome_planilha is null then
      continue;
    end if;

    -- Mantém nomes de unidade simples e compatíveis com o app.
    case lower(v_unidade_raw)
      when 'kg' then v_unidade := 'Kg';
      when 'quilo' then v_unidade := 'Kg';
      when 'quilos' then v_unidade := 'Kg';
      when 'unid' then v_unidade := 'Unid.';
      when 'unid.' then v_unidade := 'Unid.';
      when 'und' then v_unidade := 'Unid.';
      when 'un' then v_unidade := 'Unid.';
      when 'pct' then v_unidade := 'PCT';
      when 'pct.' then v_unidade := 'PCT';
      when 'pacote' then v_unidade := 'PCT';
      when 'l' then v_unidade := 'L';
      when 'lt' then v_unidade := 'L';
      when 'litro' then v_unidade := 'L';
      else v_unidade := v_unidade_raw;
    end case;

    -- 1) Se veio um item_id do frontend, confirma que é item de Cozinha.
    if v_item_id is not null then
      select i.name, i.qty into v_item_nome, v_qty_antes
      from public.items i
      join public.categories c on c.id = i.category_id
      where i.id = v_item_id and c.area = 'cozinha'
      for update of i;

      if not found then
        v_item_id := null;
      end if;
    end if;

    -- 2) Se não veio item_id, tenta achar pelo nome (case-insensitive).
    if v_item_id is null then
      select i.id, i.name, i.qty
      into v_item_id, v_item_nome, v_qty_antes
      from public.items i
      join public.categories c on c.id = i.category_id
      where c.area = 'cozinha'
        and lower(trim(i.name)) = lower(trim(v_nome_planilha))
      order by i.criado_em nulls last, i.id
      limit 1
      for update of i;
    end if;

    -- 3) Ainda não existe: cadastra automaticamente.
    if v_item_id is null then
      insert into public.items
        (name, category_id, unit, qty, min, criado_por, criado_em, ajustado_por, ajustado_em)
      values
        (v_nome_planilha, v_categoria_merenda, v_unidade, 0, 0, coalesce(v_nome_admin,'Admin'), now(), coalesce(v_nome_admin,'Admin'), now())
      returning id, name, qty into v_item_id, v_item_nome, v_qty_antes;

      v_criado := true;
      v_criados := v_criados + 1;
    else
      v_atualizados := v_atualizados + 1;
    end if;

    -- Quanto deste saldo já foi importado neste mês?
    select quantidade into v_importado_anterior
    from public.estoque_inicial_planilha
    where item_id = v_item_id and ano = p_ano and mes = p_mes;

    v_importado_anterior := coalesce(v_importado_anterior, 0);
    v_delta := v_qtd - v_importado_anterior;

    -- Soma somente a diferença. Assim repetir a mesma importação não duplica.
    update public.items
      set qty = greatest(0, qty + v_delta),
          unit = case when v_criado then v_unidade else unit end,
          ajustado_por = coalesce(v_nome_admin,'Admin'),
          ajustado_em = now()
      where id = v_item_id
      returning qty into v_qty_depois;

    insert into public.estoque_inicial_planilha
      (item_id, ano, mes, quantidade, genero_planilha, arquivo_origem, importado_por, importado_em, atualizado_em)
    values
      (v_item_id, p_ano, p_mes, v_qtd, v_genero, coalesce(p_arquivo,''), coalesce(v_nome_admin,'Admin'), now(), now())
    on conflict (item_id, ano, mes) do update
      set quantidade = excluded.quantidade,
          genero_planilha = excluded.genero_planilha,
          arquivo_origem = excluded.arquivo_origem,
          importado_por = excluded.importado_por,
          atualizado_em = now();

    -- Já deixa o produto mapeado para as sincronizações futuras.
    if v_genero is not null then
      insert into public.planilha_merenda_mapa
        (item_id, genero_planilha, unidade_planilha, criado_por, criado_em, atualizado_por, atualizado_em)
      values
        (v_item_id, v_genero, v_unidade_raw, coalesce(v_nome_admin,'Admin'), now(), coalesce(v_nome_admin,'Admin'), now())
      on conflict (item_id) do update
        set genero_planilha = excluded.genero_planilha,
            unidade_planilha = excluded.unidade_planilha,
            atualizado_por = excluded.atualizado_por,
            atualizado_em = now();
    end if;

    v_resultados := v_resultados || jsonb_build_array(jsonb_build_object(
      'item_id', v_item_id,
      'item_nome', v_item_nome,
      'criado', v_criado,
      'estoque_planilha', v_qtd,
      'ja_importado_antes', v_importado_anterior,
      'delta_aplicado', v_delta,
      'estoque_antes', v_qty_antes,
      'estoque_depois', v_qty_depois
    ));
  end loop;

  insert into public.audit_log (tipo, descricao, actor_id, em)
  values (
    'ajuste',
    coalesce(v_nome_admin,'Admin') || ' importou estoque do Mapa de Merenda de ' ||
      lpad(p_mes::text,2,'0') || '/' || p_ano || ' a partir de "' ||
      coalesce(p_arquivo,'planilha') || '" — ' || v_atualizados ||
      ' produto(s) existente(s) atualizado(s) e ' || v_criados ||
      ' produto(s) novo(s) criado(s).',
    auth.uid(),
    now()
  );

  return jsonb_build_object(
    'ok', true,
    'atualizados', v_atualizados,
    'criados', v_criados,
    'ano', p_ano,
    'mes', p_mes,
    'arquivo', p_arquivo,
    'itens', v_resultados
  );
end;
$$;
