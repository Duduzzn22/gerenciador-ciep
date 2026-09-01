-- Correção do gatilho de proteção do último administrador.
-- Rode isto no SQL Editor do Supabase (não precisa rodar o schema.sql
-- inteiro de novo, só isto).
--
-- O que estava acontecendo: o gatilho bloqueava a exclusão do único admin
-- mesmo quando era você, o dono do projeto, apagando um usuário direto em
-- Authentication > Users — por isso o erro "Database error deleting user".
-- Agora ele só protege quando a ação vem de dentro do app (alguém logado
-- tentando se auto-rebaixar ou se auto-remover pelo próprio sistema).

create or replace function public.proteger_ultimo_admin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  total_admins int;
begin
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
