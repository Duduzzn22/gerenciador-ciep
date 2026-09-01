-- Corrige as chaves estrangeiras que travavam a remoção de itens e de
-- pessoas quando já existia histórico (movimentações/auditoria) ligado a
-- eles. Rode isto no SQL Editor do Supabase (não precisa rodar o
-- schema.sql inteiro de novo).
--
-- O que estava acontecendo: tentar remover um produto que já teve
-- entrada/saída registrada dava o erro "violates foreign key constraint
-- movements_item_id_fkey" — o banco recusava apagar o item porque ainda
-- havia movimentações apontando pra ele. O mesmo aconteceria ao tentar
-- remover uma pessoa que já registrou alguma movimentação ou ação de
-- auditoria.
--
-- A partir de agora: remover um item ou uma pessoa continua permitido
-- mesmo com histórico — o histórico não é apagado, só perde a "ligação"
-- direta (o nome de quem fez a ação e o nome do item continuam salvos
-- como texto na própria movimentação/auditoria, então nada some da tela).

alter table public.movements alter column item_id drop not null;

alter table public.movements drop constraint movements_item_id_fkey;
alter table public.movements add constraint movements_item_id_fkey
  foreign key (item_id) references public.items(id) on delete set null;

alter table public.movements drop constraint movements_who_id_fkey;
alter table public.movements add constraint movements_who_id_fkey
  foreign key (who_id) references public.profiles(id) on delete set null;

alter table public.movements drop constraint movements_estornado_por_fkey;
alter table public.movements add constraint movements_estornado_por_fkey
  foreign key (estornado_por) references public.profiles(id) on delete set null;

alter table public.audit_log drop constraint audit_log_actor_id_fkey;
alter table public.audit_log add constraint audit_log_actor_id_fkey
  foreign key (actor_id) references public.profiles(id) on delete set null;
