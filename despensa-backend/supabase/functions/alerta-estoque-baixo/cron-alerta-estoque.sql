-- Agenda o envio automático (todo dia) do e-mail de alerta de estoque
-- baixo. Só funciona DEPOIS que a função "alerta-estoque-baixo" já estiver
-- publicada e configurada (veja "COMO CONFIGURAR" no arquivo index.ts, na
-- mesma pasta deste arquivo).
--
-- COMO USAR:
--   1) Vá em Database > Extensions no painel do Supabase e ative (se ainda
--      não estiverem ativas): "pg_cron" e "pg_net".
--   2) Troque os dois textos marcados como TROQUE-AQUI logo abaixo:
--        - a URL do projeto (Project Settings > API > Project URL)
--        - a "service_role key" (Project Settings > API > Project API keys
--          > service_role — é uma chave secreta, não é a "anon"/pública;
--          não compartilhe essa chave com ninguém)
--   3) Cole o resultado no SQL Editor do Supabase e rode uma vez.
--
-- O horário abaixo (12h UTC = 9h no horário de Brasília) manda o e-mail
-- todo dia nesse horário, só quando existir algum item em falta ou com
-- estoque baixo (se estiver tudo ok, nenhum e-mail é enviado naquele dia).
-- Pra mudar o horário, troque o segundo parâmetro do cron.schedule (formato
-- cron: minuto hora dia mês dia-da-semana, sempre em UTC).

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'alerta-estoque-diario',
  '0 12 * * *',
  $$
  select net.http_post(
    url := 'https://TROQUE-AQUI-project-ref.supabase.co/functions/v1/alerta-estoque-baixo',
    headers := jsonb_build_object(
      'Authorization', 'Bearer TROQUE-AQUI-service-role-key',
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object('agendado', true)
  ) as request_id;
  $$
);

-- Pra CONFERIR se o agendamento foi criado:
--   select * from cron.job where jobname = 'alerta-estoque-diario';
--
-- Pra CANCELAR o envio automático no futuro (se precisar desativar):
--   select cron.unschedule('alerta-estoque-diario');
