-- Libera dois novos tipos de registro na trilha de auditoria: "produto"
-- (cadastro/remoção de item) e "ajuste" (correção manual de quantidade ou
-- mínimo). Rode isto no SQL Editor do Supabase (não precisa rodar o
-- schema.sql inteiro de novo, só isto).
--
-- Sem rodar isto, as novas telas de "cadastrar produto" e "ajustar
-- quantidade/mínimo" vão dar erro ao tentar salvar o registro de auditoria
-- (o banco recusa qualquer "tipo" fora da lista antiga: perfil, categoria,
-- config, arquivamento).

-- (O nome exato dessa regra pode variar de banco pra banco, dependendo de
-- como foi criada — por isso o bloco abaixo primeiro DESCOBRE o nome
-- certo, em vez de supor um nome fixo, e só depois troca a regra.)
do $$
declare
  nome_constraint text;
begin
  select conname into nome_constraint
  from pg_constraint
  where conrelid = 'public.audit_log'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) ilike '%tipo%';

  if nome_constraint is not null then
    execute format('alter table public.audit_log drop constraint %I', nome_constraint);
  end if;
end $$;

alter table public.audit_log add constraint audit_log_tipo_check
  check (tipo in ('perfil','categoria','config','arquivamento','produto','ajuste'));
