-- Nova tabela: fornecedor_produtos.
--
-- Guarda a "memória" de cada produto de cada fornecedor: quando o código do
-- produto (o "CÓD.PROD" que aparece na nota fiscal) de um fornecedor
-- específico já foi visto antes, o sistema sabe automaticamente qual item
-- do estoque ele corresponde e quantas unidades vêm em cada embalagem —
-- sem precisar perguntar de novo. É essa tabela que torna a importação de
-- nota fiscal por foto automática a partir da segunda vez que aquele
-- fornecedor manda aquele produto.
--
-- Rode isto no SQL Editor do Supabase (não precisa rodar o schema.sql
-- inteiro de novo, só isto). Seguro rodar mesmo que already existam
-- algumas dessas linhas — usa "if not exists"/"on conflict" onde precisa.

create table if not exists public.fornecedor_produtos (
  id uuid primary key default gen_random_uuid(),

  -- Identifica o fornecedor pelo CNPJ (não pelo nome — nome pode vir
  -- escrito de formas ligeiramente diferentes em notas diferentes; CNPJ é
  -- estável). Guardamos o nome também só para facilitar leitura humana.
  fornecedor_cnpj text not null,
  fornecedor_nome text,

  -- O código do produto exatamente como aparece na nota fiscal daquele
  -- fornecedor (coluna "CÓD.PROD"). Combinado com o CNPJ, é a chave que
  -- identifica "este produto específico deste fornecedor específico".
  cod_prod_nf text not null,
  descricao_nf text,

  -- Pra qual item do estoque esse produto do fornecedor corresponde.
  -- "on delete set null" segue o mesmo padrão já usado em movements: se o
  -- item for removido do cadastro, o mapeamento não trava nem some — só
  -- perde o vínculo (e "item_nome" abaixo preserva o nome de referência).
  item_id uuid references public.items(id) on delete set null,
  item_nome text,

  -- Quantas unidades do item vêm em cada embalagem da nota (ex.: um
  -- "pacote" de saco de lixo com 100 unidades = unidades_por_embalagem
  -- 100). Quando a nota já vem em unidade individual, fica 1.
  unidade_nf text,
  unidades_por_embalagem numeric not null default 1 check (unidades_por_embalagem > 0),

  criado_por text,
  criado_em timestamptz not null default now(),
  atualizado_por text,
  atualizado_em timestamptz,

  unique (fornecedor_cnpj, cod_prod_nf)
);
comment on table public.fornecedor_produtos is 'Mapeamento "produto do fornecedor" -> item do estoque, usado pela importação automática de nota fiscal.';

alter table public.fornecedor_produtos enable row level security;

-- Só administrador mexe nesta tabela (é dado operacional de apoio à
-- importação, não algo que precisa aparecer pra quem registra
-- entrada/saída no dia a dia).
drop policy if exists "fornecedor_produtos_select_admin" on public.fornecedor_produtos;
create policy "fornecedor_produtos_select_admin" on public.fornecedor_produtos
  for select using (public.is_admin());

drop policy if exists "fornecedor_produtos_insert_admin" on public.fornecedor_produtos;
create policy "fornecedor_produtos_insert_admin" on public.fornecedor_produtos
  for insert with check (public.is_admin());

drop policy if exists "fornecedor_produtos_update_admin" on public.fornecedor_produtos;
create policy "fornecedor_produtos_update_admin" on public.fornecedor_produtos
  for update using (public.is_admin());

drop policy if exists "fornecedor_produtos_delete_admin" on public.fornecedor_produtos;
create policy "fornecedor_produtos_delete_admin" on public.fornecedor_produtos
  for delete using (public.is_admin());
