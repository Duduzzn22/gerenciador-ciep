-- ============================================================================
-- DESPENSA DIGITAL — schema do banco de dados (Supabase / PostgreSQL)
-- ============================================================================
-- Como rodar: Supabase → seu projeto → SQL Editor → New query → cole este
-- arquivo inteiro → Run. Pode rodar de uma vez só, de cima a baixo.
--
-- O que este script cria:
--   1) Tabelas: profiles, categories, items, movements, audit_log, settings
--   2) Funções auxiliares (is_admin, my_area) usadas pelas regras de acesso
--   3) Um gatilho que cria o "perfil" automaticamente quando alguém se
--      cadastra — a PRIMEIRA pessoa a se cadastrar vira administrador
--      automaticamente, do jeito que já funcionava antes; as próximas
--      entram como "padrão" (o admin ajusta depois pela aba Cadastro).
--   4) Row Level Security (RLS): as regras de quem pode ler/alterar cada
--      coisa passam a ser aplicadas pelo PRÓPRIO BANCO DE DADOS — não é
--      mais o navegador quem decide isso, é o servidor do Supabase. Isso
--      é a correção real do problema de segurança do modelo anterior.
--   5) Uma função (registrar_movimento) que registra entrada/saída de
--      forma segura e "atômica" — sem risco de duas pessoas registrando
--      ao mesmo tempo e uma sobrescrever a outra.
--   6) As categorias padrão já cadastradas (mesmas do app atual).
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1) TABELAS
-- ----------------------------------------------------------------------------

create extension if not exists pgcrypto;

-- Uma linha por pessoa que já tem login. O id é o MESMO id do login dela
-- (auth.users) — é assim que ligamos "quem está logado" a "quais são as
-- permissões dela".
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  role text not null default 'padrao' check (role in ('admin','padrao')),
  area text not null default 'cozinha' check (area in ('cozinha','limpeza','ambas')),
  created_at timestamptz not null default now()
);
comment on table public.profiles is 'Uma linha por pessoa cadastrada; papel (admin/padrao) e área (cozinha/limpeza/ambas) decidem o que ela pode fazer.';

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  nome text not null unique,
  area text not null check (area in ('cozinha','limpeza')),
  created_at timestamptz not null default now()
);

create table public.items (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category_id uuid not null references public.categories(id),
  unit text not null default 'un',
  qty numeric not null default 0 check (qty >= 0),
  min numeric not null default 0 check (min >= 0),
  criado_por text,
  criado_em timestamptz not null default now(),
  ajustado_por text,
  ajustado_em timestamptz
);

-- item_id, who_id e estornado_por usam "on delete set null": remover um
-- produto ou uma pessoa NÃO pode travar (nem apagar) o histórico de
-- movimentações — o nome de quem fez a ação já fica salvo em "who_name"/
-- "estornado_por_nome" (texto puro), então a movimentação continua
-- mostrando "quem" mesmo que aquela pessoa seja removida depois. O item
-- em si vira "Item removido" na tela quando isso acontece (o frontend já
-- trata esse caso).
create table public.movements (
  id uuid primary key default gen_random_uuid(),
  item_id uuid references public.items(id) on delete set null,
  type text not null check (type in ('entrada','saida')),
  qty numeric not null check (qty > 0),
  unidade text not null,
  who_id uuid references public.profiles(id) on delete set null,
  who_name text not null,
  fornecedor text default '',
  motivo text default '',
  nota text default '',
  at timestamptz not null default now(),
  estornado boolean not null default false,
  estornado_por uuid references public.profiles(id) on delete set null,
  estornado_por_nome text,
  estornado_em timestamptz,
  -- Fica nulo até a movimentação ser levada com sucesso pro Mapa de
  -- Merenda (planilha); é assim que a tela de sincronização sabe quais
  -- movimentações de itens de Cozinha ainda estão pendentes.
  sincronizado_planilha_em timestamptz
);

create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  tipo text not null check (tipo in ('perfil','categoria','config','arquivamento','produto','ajuste')),
  descricao text not null,
  actor_id uuid references public.profiles(id) on delete set null,
  em timestamptz not null default now()
);

-- Mapeamento "produto do fornecedor" -> item do estoque, usado pela
-- importação automática de nota fiscal (foto da NF -> cadastro). Guarda,
-- por fornecedor (CNPJ) + código do produto na nota, qual item do estoque
-- corresponde e quantas unidades vêm em cada embalagem — assim a segunda
-- vez que aquele fornecedor manda aquele produto, o sistema já sabe.
create table public.fornecedor_produtos (
  id uuid primary key default gen_random_uuid(),
  fornecedor_cnpj text not null,
  fornecedor_nome text,
  cod_prod_nf text not null,
  descricao_nf text,
  item_id uuid references public.items(id) on delete set null,
  item_nome text,
  unidade_nf text,
  unidades_por_embalagem numeric not null default 1 check (unidades_por_embalagem > 0),
  criado_por text,
  criado_em timestamptz not null default now(),
  atualizado_por text,
  atualizado_em timestamptz,
  unique (fornecedor_cnpj, cod_prod_nf)
);
comment on table public.fornecedor_produtos is 'Mapeamento "produto do fornecedor" -> item do estoque, usado pela importação automática de nota fiscal.';

-- Pra cada item de Cozinha, qual linha ("Gênero") do Mapa de Merenda
-- (planilha Excel do Google Drive, prestação de contas mensal) ele
-- corresponde — usado pela sincronização automática de entrada/saída.
create table public.planilha_merenda_mapa (
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

-- Uma linha só, com as configurações gerais (equivalente ao que ficava
-- solto no JSON de estado do app antigo).
create table public.settings (
  id boolean primary key default true check (id),
  school_name text not null default 'Cozinha da escola',
  arquivo_meses int not null default 12 check (arquivo_meses >= 1),
  ultima_exportacao_em timestamptz
);
insert into public.settings (id) values (true);


-- ----------------------------------------------------------------------------
-- 2) FUNÇÕES AUXILIARES — usadas dentro das regras de segurança abaixo
-- ----------------------------------------------------------------------------

create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and role = 'admin'
  );
$$;
comment on function public.is_admin() is 'true se quem está logado agora é administrador.';

create or replace function public.my_area()
returns text
language sql
security definer
stable
set search_path = public
as $$
  select area from public.profiles where id = auth.uid();
$$;
comment on function public.my_area() is 'área (cozinha/limpeza/ambas) de quem está logado agora.';


-- ----------------------------------------------------------------------------
-- 3) CRIAÇÃO AUTOMÁTICA DE PERFIL QUANDO ALGUÉM SE CADASTRA
-- ----------------------------------------------------------------------------
-- Quando uma pessoa cria a própria conta (e-mail + senha) na tela de login
-- do app, o Supabase Auth insere uma linha em auth.users. Este gatilho
-- reage a isso e cria a linha correspondente em public.profiles.
--
-- IMPORTANTE: quem decide se a pessoa vira "admin" ou "padrao" é ESTA
-- FUNÇÃO, rodando no servidor — nunca o que o navegador da pessoa manda.
-- Regra: se ainda não existe ninguém cadastrado, a primeira pessoa vira
-- administradora automaticamente (mesmo comportamento do app anterior).
-- Todas as próximas entram como "padrão" e um admin ajusta depois.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  ja_existe_gente boolean;
  area_escolhida text;
begin
  select exists(select 1 from public.profiles) into ja_existe_gente;

  area_escolhida := coalesce(new.raw_user_meta_data->>'area', 'cozinha');
  if area_escolhida not in ('cozinha','limpeza') then
    area_escolhida := 'cozinha';
  end if;

  insert into public.profiles (id, name, role, area)
  values (
    new.id,
    coalesce(nullif(trim(new.raw_user_meta_data->>'name'), ''), split_part(new.email, '@', 1)),
    case when ja_existe_gente then 'padrao' else 'admin' end,
    case when ja_existe_gente then area_escolhida else 'ambas' end
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ----------------------------------------------------------------------------
-- 3b) PROTEÇÃO DO ÚLTIMO ADMINISTRADOR — agora garantida pelo banco
-- ----------------------------------------------------------------------------
-- No app anterior, "não deixar remover/rebaixar o único admin" era só uma
-- checagem no navegador (podia ser burlada). Agora é o próprio banco que
-- recusa a operação, não importa por onde ela chegue.

create or replace function public.proteger_ultimo_admin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  total_admins int;
begin
  -- Só protege contra ações feitas por uma pessoa logada DE VERDADE
  -- através do app (role 'authenticated' — é o que o PostgREST usa quando
  -- alguém está autenticado com e-mail/senha). Ações feitas diretamente
  -- por você no painel do Supabase (SQL Editor, apagar usuário em
  -- Authentication > Users, etc.) não passam com essa role — são o
  -- próprio dono do projeto cuidando do banco, e não devem ser bloqueadas.
  if coalesce(auth.role(), '') = 'authenticated' then
    if (tg_op = 'DELETE' and old.role = 'admin')
       or (tg_op = 'UPDATE' and old.role = 'admin' and new.role <> 'admin') then
      select count(*) into total_admins from public.profiles where role = 'admin';
      if total_admins <= 1 then
        raise exception 'não é possível remover ou rebaixar o único administrador';
      end if;
    end if;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger proteger_ultimo_admin_trigger
  before update or delete on public.profiles
  for each row execute function public.proteger_ultimo_admin();


-- ----------------------------------------------------------------------------
-- 4) REGISTRAR MOVIMENTAÇÃO DE FORMA SEGURA E ATÔMICA
-- ----------------------------------------------------------------------------
-- Em vez do frontend calcular "quantidade nova = quantidade antiga +/- X"
-- e mandar o número pronto (arriscado se duas pessoas fizerem isso ao
-- mesmo tempo), o frontend chama esta função e é o BANCO quem calcula,
-- trava a linha certa (FOR UPDATE) e garante que não se perde nenhuma
-- movimentação por causa de uma corrida entre duas pessoas.

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

-- Estorno de uma movimentação — também atômico e com o mesmo tipo de
-- checagem de permissão (área) feita no servidor.
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

-- Marca quando cada movimentação foi levada com sucesso pro Mapa de
-- Merenda (planilha). Movimentações não passam por UPDATE direto pra
-- ninguém (nem administrador) — sempre por uma função segura que confere
-- a regra antes de mexer, mesmo padrão de registrar_movimento/
-- estornar_movimento. Só marca a data (nunca mexe em quantidade, tipo
-- etc.) e só aceita movimentações que ainda não tinham sido marcadas.
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

-- Arquivamento: move para fora da tabela "movements" tudo que passou do
-- prazo (o frontend já exportou o CSV de backup antes de chamar isto).
create or replace function public.arquivar_movimentos_antigos()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_meses int;
  v_total int;
  v_nome text;
begin
  if not public.is_admin() then
    raise exception 'só um administrador pode arquivar';
  end if;

  select arquivo_meses into v_meses from public.settings where id = true;
  select name into v_nome from public.profiles where id = auth.uid();

  with apagados as (
    delete from public.movements
    where at < (now() - (v_meses || ' months')::interval)
    returning 1
  )
  select count(*) into v_total from apagados;

  if v_total > 0 then
    insert into public.audit_log (tipo, descricao, actor_id)
    values ('arquivamento', v_nome || ' arquivou ' || v_total || ' movimentação(ões) com mais de ' || v_meses || ' meses.', auth.uid());
  end if;

  return v_total;
end;
$$;


-- ----------------------------------------------------------------------------
-- 5) ROW LEVEL SECURITY — as regras de acesso valem para QUALQUER acesso
--    ao banco, não só pelo app (inclusive se alguém tentar acessar direto
--    pela API REST do Supabase).
-- ----------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.categories enable row level security;
alter table public.items enable row level security;
alter table public.movements enable row level security;
alter table public.audit_log enable row level security;
alter table public.settings enable row level security;
alter table public.fornecedor_produtos enable row level security;
alter table public.planilha_merenda_mapa enable row level security;

-- profiles: todo mundo logado pode VER a lista (precisa pra mostrar nomes
-- nas movimentações); só admin pode alterar o papel/área de alguém; a
-- própria pessoa pode alterar seu nome; só admin apaga (e o gatilho da
-- seção 3b impede apagar o último admin).
create policy "profiles_select_authenticated" on public.profiles
  for select using (auth.role() = 'authenticated');

create policy "profiles_update_admin_ou_proprio_nome" on public.profiles
  for update using (public.is_admin() or id = auth.uid())
  with check (
    public.is_admin()
    or (id = auth.uid() and role = (select role from public.profiles where id = auth.uid())
        and area = (select area from public.profiles where id = auth.uid()))
  );

create policy "profiles_delete_admin" on public.profiles
  for delete using (public.is_admin());

-- categories: todo mundo logado lê; só admin cadastra/edita/remove.
create policy "categories_select_authenticated" on public.categories
  for select using (auth.role() = 'authenticated');
create policy "categories_write_admin" on public.categories
  for insert with check (public.is_admin());
create policy "categories_update_admin" on public.categories
  for update using (public.is_admin());
create policy "categories_delete_admin" on public.categories
  for delete using (public.is_admin());

-- items: só vê quem tem acesso à área da categoria do item (ou admin, que
-- vê tudo); só admin cadastra/remove item; ajustar quantidade/mínimo é
-- permitido a qualquer pessoa da área certa (não precisa ser admin).
create policy "items_select_por_area" on public.items
  for select using (
    public.is_admin()
    or public.my_area() = 'ambas'
    or exists (select 1 from public.categories c where c.id = items.category_id and c.area = public.my_area())
  );
create policy "items_insert_admin" on public.items
  for insert with check (public.is_admin());
create policy "items_update_por_area" on public.items
  for update using (
    public.is_admin()
    or public.my_area() = 'ambas'
    or exists (select 1 from public.categories c where c.id = items.category_id and c.area = public.my_area())
  );
create policy "items_delete_admin" on public.items
  for delete using (public.is_admin());

-- movements: só vê (e insere/estorna, via função) quem tem acesso à área
-- do item relacionado, ou admin. Inserção/estorno diretos por UPDATE/INSERT
-- de linha NÃO são liberados — só através das funções registrar_movimento
-- e estornar_movimento acima, que já conferem a área.
create policy "movements_select_por_area" on public.movements
  for select using (
    public.is_admin()
    or public.my_area() = 'ambas'
    or exists (
      select 1 from public.items i join public.categories c on c.id = i.category_id
      where i.id = movements.item_id and c.area = public.my_area()
    )
  );

-- audit_log: só admin lê (é uma trilha administrativa). Qualquer pessoa
-- logada pode inserir um registro (o app grava um a cada ação
-- administrativa relevante), mas só em nome de si mesma — o "actor_id"
-- tem que ser obrigatoriamente o próprio auth.uid(), então não dá pra
-- inserir um registro fingindo ser outra pessoa. O texto em si
-- ("descricao") continua sendo de boa-fé, como no app anterior — não é
-- uma trilha à prova de adulteração, mas agora pelo menos a AUTORIA de
-- cada linha é garantida de verdade pelo login.
create policy "audit_log_select_admin" on public.audit_log
  for select using (public.is_admin());
create policy "audit_log_insert_self" on public.audit_log
  for insert with check (actor_id = auth.uid());

-- settings: todo mundo logado lê (precisa saber o prazo de arquivamento
-- etc.); só admin altera.
create policy "settings_select_authenticated" on public.settings
  for select using (auth.role() = 'authenticated');
create policy "settings_update_admin" on public.settings
  for update using (public.is_admin());

-- fornecedor_produtos: só administrador mexe (dado operacional de apoio à
-- importação de nota fiscal, não algo que precisa aparecer no dia a dia de
-- quem só registra entrada/saída).
create policy "fornecedor_produtos_select_admin" on public.fornecedor_produtos
  for select using (public.is_admin());
create policy "fornecedor_produtos_insert_admin" on public.fornecedor_produtos
  for insert with check (public.is_admin());
create policy "fornecedor_produtos_update_admin" on public.fornecedor_produtos
  for update using (public.is_admin());
create policy "fornecedor_produtos_delete_admin" on public.fornecedor_produtos
  for delete using (public.is_admin());

-- planilha_merenda_mapa: só administrador mexe (mesma razão de
-- fornecedor_produtos — dado operacional de apoio, não algo do dia a dia).
create policy "planilha_merenda_mapa_select_admin" on public.planilha_merenda_mapa
  for select using (public.is_admin());
create policy "planilha_merenda_mapa_insert_admin" on public.planilha_merenda_mapa
  for insert with check (public.is_admin());
create policy "planilha_merenda_mapa_update_admin" on public.planilha_merenda_mapa
  for update using (public.is_admin());
create policy "planilha_merenda_mapa_delete_admin" on public.planilha_merenda_mapa
  for delete using (public.is_admin());


-- ----------------------------------------------------------------------------
-- 6) CATEGORIAS PADRÃO (as mesmas do app atual)
-- ----------------------------------------------------------------------------

insert into public.categories (nome, area) values
  ('Grãos e Cereais', 'cozinha'),
  ('Óleos e Temperos', 'cozinha'),
  ('Laticínios', 'cozinha'),
  ('Enlatados e Conservas', 'cozinha'),
  ('Hortifrúti', 'cozinha'),
  ('Açougue', 'cozinha'),
  ('Padaria', 'cozinha'),
  ('Limpeza', 'limpeza'),
  ('Descartáveis', 'limpeza')
on conflict (nome) do nothing;

-- ============================================================================
-- FIM. Depois de rodar este script:
--   1) Vá em Authentication → Providers e confirme que "Email" está ativado
--      (vem ativado por padrão).
--   2) Vá em Authentication → URL Configuration e adicione a URL do app
--      publicado em "Redirect URLs" (eu te aviso essa URL quando publicar
--      a nova versão do frontend).
--   3) A primeira pessoa a criar uma conta pelo app vira administradora
--      automaticamente — combine com a escola quem deve ser essa pessoa
--      antes de divulgar o link pra todo mundo.
-- ============================================================================
