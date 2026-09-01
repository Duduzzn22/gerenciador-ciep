# Despensa Digital

Sistema de controle de estoque (Cozinha e Limpeza) com backend em
[Supabase](https://supabase.com) e frontend estático publicado no
[Netlify](https://netlify.com).

Para o histórico completo de decisões, funcionalidades e pendências, veja
[`estado-do-projeto.md`](./estado-do-projeto.md) — é o documento de
continuidade do projeto, mantido atualizado a cada rodada de mudanças.

## Estrutura do repositório

- **`webapp/`** — código-fonte do site (versão de desenvolvimento, com
  `mock-supabase.js` e a suíte de testes automatizados em `tests/`).
- **`site-deploy/`** — versão publicada no Netlify (mesmos arquivos do
  `webapp/`, sem os arquivos de teste).
- **`supabase/functions/`** — Edge Functions do Supabase:
  - `ler-nf/` — leitura automática de nota fiscal por foto (IA do Google
    Gemini).
  - `sync-planilha/` — sincronização das movimentações de estoque de
    Cozinha com a planilha "Mapa de Merenda" no Google Drive.
  - `alerta-estoque-baixo/` — alerta por e-mail quando um item fica em
    falta ou com estoque baixo.
- **`schema.sql`** — schema completo e atualizado do banco de dados.
- **`fix-*.sql`** — scripts incrementais de migração, todos seguros de
  rodar mais de uma vez (idempotentes).

## Segredos e configuração

Nenhuma chave de API, senha ou credencial fica gravada neste repositório.
Todas as chaves (Google Gemini, conta de serviço do Google, etc.) ficam
guardadas exclusivamente nos **Secrets** de Edge Functions do painel do
Supabase. Cada função em `supabase/functions/*/index.ts` tem uma seção
"COMO CONFIGURAR" no final do arquivo, com o passo a passo completo.
