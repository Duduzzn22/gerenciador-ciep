-- Padroniza a categoria duplicada "Descartável" para "Descartáveis".
-- Seguro para rodar mais de uma vez.
--
-- O sistema relaciona produtos por items.category_id. Por isso, quando as
-- duas categorias existem, primeiro movemos os produtos da categoria singular
-- para a plural e só depois removemos a categoria duplicada sem produtos.

do $$
declare
  v_plural_id uuid;
  v_singular_id uuid;
  v_afetados integer := 0;
begin
  select id into v_plural_id
  from public.categories
  where nome = 'Descartáveis'
  order by created_at, id
  limit 1;

  select id into v_singular_id
  from public.categories
  where nome = 'Descartável'
  order by created_at, id
  limit 1;

  if v_singular_id is null then
    raise notice 'Categoria "Descartável" não existe. Nada a fazer.';
    return;
  end if;

  if v_plural_id is null then
    select count(*) into v_afetados
    from public.items
    where category_id = v_singular_id;

    update public.categories
      set nome = 'Descartáveis'
      where id = v_singular_id;
    raise notice 'Categoria "Descartável" renomeada para "Descartáveis". Produtos afetados: %.', v_afetados;
    return;
  end if;

  update public.items
    set category_id = v_plural_id
    where category_id = v_singular_id;

  get diagnostics v_afetados = row_count;

  delete from public.categories
    where id = v_singular_id
      and not exists (
        select 1
        from public.items
        where category_id = v_singular_id
      );

  raise notice 'Produtos movidos de "Descartável" para "Descartáveis": %.', v_afetados;
end $$;

select
  count(*) filter (where c.nome = 'Descartável') as categorias_descartavel_restantes,
  count(*) filter (where c.nome = 'Descartáveis') as categorias_descartaveis,
  count(i.*) filter (where c.nome = 'Descartáveis') as produtos_em_descartaveis
from public.categories c
left join public.items i on i.category_id = c.id
where c.nome in ('Descartável', 'Descartáveis');
