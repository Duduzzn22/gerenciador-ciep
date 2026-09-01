\set ON_ERROR_STOP on

-- Simula cadastro real (via gatilho handle_new_user): primeira pessoa vira
-- admin/ambas automaticamente.
insert into auth.users (id, email, raw_user_meta_data) values
  ('11111111-1111-1111-1111-111111111111', 'admin@teste.com', '{"name":"Admin Teste","area":"cozinha"}'::jsonb);

-- Segunda pessoa se cadastra como padrão, área cozinha (só depois um admin
-- vai mudar pra "ambas" via tela de edição de pessoa, como no app real).
insert into auth.users (id, email, raw_user_meta_data) values
  ('22222222-2222-2222-2222-222222222222', 'ambas@teste.com', '{"name":"Pessoa Ambas","area":"cozinha"}'::jsonb);

-- Admin edita o perfil da pessoa 2 e muda a área para "ambas"
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set request.jwt.claim.role = 'authenticated';
update public.profiles set area = 'ambas' where id = '22222222-2222-2222-2222-222222222222';
reset role;
reset request.jwt.claim.sub;
reset request.jwt.claim.role;

select id as cat_cozinha_id from public.categories where area='cozinha' limit 1 \gset
select id as cat_limpeza_id from public.categories where area='limpeza' limit 1 \gset

-- Admin cria um item em cada área
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set request.jwt.claim.role = 'authenticated';

insert into public.items (name, category_id, unit, qty, min) values
  ('Arroz teste', :'cat_cozinha_id', 'kg', 10, 2);
insert into public.items (name, category_id, unit, qty, min) values
  ('Detergente teste', :'cat_limpeza_id', 'un', 5, 1);

reset role;
reset request.jwt.claim.sub;
reset request.jwt.claim.role;

select id as item_cozinha_id from public.items where name='Arroz teste' \gset
select id as item_limpeza_id from public.items where name='Detergente teste' \gset

-- Agora simula a sessão da pessoa "ambas" (padrão)
set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
set request.jwt.claim.role = 'authenticated';

\echo '--- TESTE 1: SELECT items deve ver AMBOS (cozinha e limpeza) ---'
select name, (select area from public.categories c where c.id=items.category_id) as area from public.items order by name;

\echo '--- TESTE 2: registrar_movimento em item de COZINHA (deve funcionar) ---'
select (registrar_movimento(:'item_cozinha_id', 'entrada', 3, 'kg', '', '', 'teste ambas cozinha')).qty as nova_qtd_cozinha;

\echo '--- TESTE 3: registrar_movimento em item de LIMPEZA (deve funcionar) ---'
select (registrar_movimento(:'item_limpeza_id', 'saida', 1, 'un', '', 'Uso teste', 'teste ambas limpeza')).qty as nova_qtd_limpeza;

\echo '--- TESTE 4: SELECT movements deve ver AMBAS movimentações ---'
select type, qty, nota from public.movements order by at;

\echo '--- TESTE 5: UPDATE direto em item de limpeza (ajuste manual) deve funcionar ---'
update public.items set min = 2 where id = :'item_limpeza_id';
select min from public.items where id = :'item_limpeza_id';

reset role;
reset request.jwt.claim.sub;
reset request.jwt.claim.role;

\echo '--- TESTE 6 (controle): pessoa padrão SÓ cozinha não deve ver item de limpeza ---'
insert into auth.users (id, email, raw_user_meta_data) values
  ('33333333-3333-3333-3333-333333333333', 'cozinha@teste.com', '{"name":"Pessoa Cozinha","area":"cozinha"}'::jsonb);

set role authenticated;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
set request.jwt.claim.role = 'authenticated';

select count(*) as deve_ser_1_so_cozinha from public.items;

\echo '--- TESTE 6b: tentar registrar movimento em item de limpeza deve FALHAR (esperado erro) ---'
select registrar_movimento(:'item_limpeza_id', 'entrada', 1, 'un', '', '', 'nao deveria funcionar');
