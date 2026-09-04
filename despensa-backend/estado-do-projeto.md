# Despensa Digital — estado do projeto

_Atualizado em 24/08/2026. Este arquivo é um resumo de continuidade: se a
conversa for retomada depois, comece lendo isso._

## Onde estamos

O site já está **no ar** (Netlify) e **conectado ao Supabase de verdade**.
Depois de uma rodada de melhorias de usabilidade/controle (já entregue e em
uso), as duas rodadas mais recentes entregam duas automações que você
pediu:

1. **Importar automaticamente os produtos de uma nota fiscal
   fotografada**, sem precisar digitar cada item manualmente — veja
   "Importação de Nota Fiscal por foto" mais abaixo.
2. **Sincronizar as entradas/saídas de Cozinha automaticamente com o Mapa
   de Merenda** (a planilha Excel de prestação de contas no Google Drive)
   — veja "Sincronização com o Mapa de Merenda" mais abaixo.

**As duas têm configuração extra obrigatória** (uma chave de IA pra
importação de NF, e uma conta de serviço do Google pra sincronização com
a planilha) — sem essa configuração, as telas novas não funcionam.

## ⚠️ Ação pendente: rodar 2 arquivos SQL novos

- **`fix-fornecedor-produtos.sql`** (cria a tabela que guarda "qual
  produto de qual fornecedor vira qual item do seu estoque" — importação
  de NF).
- **`fix-planilha-merenda.sql`** (cria a tabela que guarda "qual item de
  Cozinha vira qual linha da planilha", e a coluna que controla o que já
  foi sincronizado — sincronização com o Mapa de Merenda).

Abra o SQL Editor do seu projeto no Supabase e rode o conteúdo dos dois.
Seguro rodar mesmo que já tenha rodado antes.

Se ainda não tiver certeza se já rodou os arquivos `fix-*.sql` de rodadas
anteriores (`fix-auditoria-tipo.sql`, `fix-area-ambas.sql`,
`fix-fk-historico.sql`, `fix-protecao-admin.sql`), pode rodar todos de novo
sem medo — são todos seguros de rodar mais de uma vez.


## Importação do estoque inicial pelo mês anterior

Nova opção em **Cadastro > Produtos > "Importar estoque inicial da planilha"**. O app usa a mesma integração do Google Drive já existente, abre automaticamente a planilha do **mês anterior**, lê a aba **MENSAL** e importa somente os produtos cujo **Estoque Final > 0**. O valor passa a ser a base do estoque do mês atual.

A importação é segura para repetição: ela não cria uma movimentação de "Entrada" fictícia. Se já houver entradas/saídas registradas no mês atual, o banco recalcula estoque atual = estoque inicial importado + entradas - saídas, preservando as movimentações reais. A correspondência usa primeiro o mapeamento planilha_merenda_mapa e, como alternativa, nome exatamente equivalente após normalização. Linhas sem correspondência aparecem na conferência e não são aplicadas.

**Configuração necessária:** rodar `fix-estoque-inicial-planilha.sql` no SQL Editor e republicar a Edge Function `sync-planilha`. Não há segredo novo do Google: reutiliza a mesma conta de serviço da sincronização já existente.


### Ajuste posterior — auto-cadastro na importação do estoque inicial

A tela de importação agora não bloqueia linhas sem correspondência. Produtos já existentes recebem a quantidade importada por soma; produtos inexistentes são criados automaticamente na categoria **Merenda** com a unidade informada na planilha. A função mantém controle por mês para que repetir a mesma importação não duplique o saldo, e cria/atualiza automaticamente o mapeamento `planilha_merenda_mapa`.

## Importação de Nota Fiscal por foto (novidade desta rodada)

Agora existe uma tela nova, **Cadastro > Produtos > "Importar de nota
fiscal (foto)"**, só para administradores. O fluxo:

1. Você tira (ou escolhe da galeria) uma foto da nota fiscal do
   fornecedor.
2. Uma IA (Google Gemini, plano **gratuito**) lê a foto e identifica cada produto: código
   do fornecedor, descrição, quantidade, e já SUGERE um nome curto no
   padrão que você já usa no cadastro (ex.: "SACO LIXO 100L C 100UN" vira
   "Saco de Lixo 100L") e já faz a conta de pacote pra unidade (ex.: 4
   pacotes de 100 = 400 unidades) — a mesma conta que você fazia à mão.
3. Aparece uma tela de conferência: itens que já foram importados desse
   fornecedor antes aparecem marcados **"Já cadastrado"**, com a
   quantidade já calculada certa (o sistema aprende, da primeira vez que
   você confirma, "esse código do fornecedor X é esse produto, com esse
   fator de conversão" — nas próximas notas do mesmo fornecedor não precisa
   nem revisar). Itens que a IA não reconhece aparecem como **"Novo"**, com
   nome/categoria/quantidade/mínimo editáveis antes de confirmar (dá
   também pra "linkar" um item novo a um produto que já existe no estoque,
   em vez de criar duplicado).
4. Um botão só, "Confirmar e lançar N itens", grava tudo de uma vez:
   cadastra os produtos novos, lança a entrada de estoque de cada item
   (aparece no Histórico normalmente, com o nome do fornecedor e o número
   da nota), e atualiza a "memória" de fornecedor/produto pra próxima vez.

### ⚠️ Configuração obrigatória (só uma vez) — sem isso a tela não funciona

A leitura da foto usa uma Edge Function nova (`ler-nf`) que chama a IA do
**Google Gemini, no plano gratuito** (sem cartão de crédito, 1.500
leituras de nota por dia — muito mais do que a escola usa). Passo a passo
completo já está escrito dentro do arquivo `supabase/functions/ler-nf/
index.ts`, na seção "COMO CONFIGURAR" no final dele. Resumo:

1. Rode o `fix-fornecedor-produtos.sql` no SQL Editor (veja "Ação
   pendente" no topo deste arquivo).
2. Crie uma chave gratuita em https://aistudio.google.com/apikey (entra
   com uma conta Google, clica em "Create API key" — não pede cartão).
3. Com o Supabase CLI (`npm install -g supabase`), rode:
   `supabase functions deploy ler-nf` e depois
   `supabase secrets set GOOGLE_GEMINI_API_KEY=AIzaxxx`.
4. Suba o `index.html` novo (tem o botão "Importar de nota fiscal") e o
   `conferencia-nf.html` novo pro Netlify junto — os dois precisam estar
   publicados no mesmo site.

**⚠️ Sobre privacidade, vale saber**: no plano GRATUITO do Gemini, o
Google pode revisar (por pessoas) e usar as fotos das notas e as
respostas da IA pra melhorar/treinar os modelos deles — ou seja, a foto
não fica 100% privada com o Google nesse plano. Pra a grande maioria das
escolas isso não é um problema real (são notas de compra de material de
limpeza/cozinha, não dados sensíveis de pessoas), mas é bom você estar
ciente. Se um dia preferir mais privacidade, dá pra trocar por uma conta
paga do Gemini ou pela IA da Anthropic (paga, poucos centavos por nota,
não usa os dados pra treinar) — o código já está preparado pra essa troca
ser simples (é só um bloco isolado dentro do `index.ts`).

## Sincronização com o Mapa de Merenda (novidade desta rodada)

Nova tela, **Cadastro > Produtos > "Sincronizar com a planilha
(Merenda)"**, só para administradores. Ela leva pra planilha Excel do
Google Drive (Mapa de Merenda) as entradas/saídas de itens de **Cozinha**
que ainda não foram levadas — a sincronização é sob demanda (você clica
"Sincronizar agora" quando quiser, não acontece sozinha a cada
movimentação, pra não escrever no arquivo no meio de você editando algo
lá).

1. Primeiro, defina para cada item de Cozinha qual é a linha
   correspondente na planilha: abra o item no Estoque (ícone de
   engrenagem) e preencha "Linha no Mapa de Merenda (Gênero)" com o texto
   exatamente como aparece na coluna "Gênero" da planilha (ex.: "ARROZ
   TIPO 1"). Itens sem essa linha preenchida ficam de fora da
   sincronização (aparecem como aviso na tela, não travam os outros).
2. Na tela de sincronização, você vê as movimentações pendentes agrupadas
   por item, com o total de entrada/saída de cada um. Ao confirmar, o
   sistema descobre sozinho o caminho da planilha do MÊS ATUAL (pela
   data), soma os totais às células que já estão lá (não sobrescreve nada
   que você já tenha lançado à mão, e não mexe nas fórmulas de "Total" e
   "Estoque Final" — só escreve em "Entrada" e "Saída").
3. Se a planilha do mês ainda não existir (comum nos primeiros dias do
   mês, já que a criação é manual, copiando a do mês anterior), a tela
   mostra um aviso claro dizendo exatamente onde procurou — nada se
   perde, as movimentações continuam esperando, é só criar a pasta/
   planilha e clicar em "Verificar novamente".

### ⚠️ Configuração obrigatória (só uma vez) — sem isso a tela não funciona

Diferente da importação de NF, aqui você NÃO precisa fazer login com sua
conta Google — configura uma "conta de serviço" uma vez e funciona
sozinho pra sempre. Passo a passo completo dentro do arquivo
`supabase/functions/sync-planilha/index.ts`, seção "COMO CONFIGURAR" no
final. Resumo:

1. Rode o `fix-planilha-merenda.sql` no SQL Editor (veja "Ação pendente"
   no topo deste arquivo).
2. No Google Cloud Console (https://console.cloud.google.com): ative a
   "Google Drive API", crie uma "Conta de serviço", e gere uma chave JSON
   dela. Guarde esse arquivo .json com cuidado.
3. No Google Drive, compartilhe a pasta **"Mapa de Merenda"** (só ela, não
   precisa a árvore inteira de pastas acima) com o e-mail da conta de
   serviço (o campo "client_email" do .json), dando permissão de Editor.
4. Publique a função e configure os segredos:
   `supabase functions deploy sync-planilha`, depois
   `supabase secrets set GOOGLE_SERVICE_ACCOUNT_EMAIL="..."` e
   `supabase secrets set GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY="..."` (os
   valores "client_email" e "private_key" do arquivo .json).
5. Suba o `index.html` novo e o `sync-planilha.html` novo pro Netlify
   junto — os dois precisam estar publicados no mesmo site.

**Detalhe técnico que vale saber**: como o arquivo é um .xlsx de verdade
(não uma Planilha Google nativa), a sincronização baixa o arquivo, edita
com uma biblioteca de planilha e reenvia — isso preserva 100% as fórmulas
existentes, mas o NÚMERO em cache de "Total"/"Estoque Final" só atualiza
visualmente quando o arquivo for reaberto no Excel/Planilhas Google (o
recálculo automático já é o padrão dessas ferramentas, então normalmente
você nem percebe isso). Também vale saber: se uma movimentação for
estornada DEPOIS de já ter sido sincronizada, a planilha não é corrigida
sozinha — precisaria de um ajuste manual nesse caso raro.

## O que mudou na rodada anterior (por prioridade)

**Prioridade alta**
- Toda vez que alguém cadastra, remove ou ajusta manualmente um produto,
  fica registrado na aba Cadastro > Auditoria (quem fez, o quê, quando) —
  antes só ficava registrado quando um admin editava uma pessoa.
- Tela de "Esqueci minha senha" — antes, quem esquecia a senha ficava sem
  saída nenhuma dentro do site.
- Mensagens de erro do banco (em inglês, técnicas) agora aparecem
  traduzidas em português simples pra quem não é da área de TI.

**Prioridade média**
- Corrigida a opção de área "Cozinha e Limpeza" (Ambas) pra pessoas
  "padrão" — agora funciona de verdade (dá acesso às duas áreas sem
  precisar ser administrador).
- A unidade de medida do produto (kg, un, litro...) não é mais editável na
  hora de registrar entrada/saída — evita trocar sem querer. Só um
  administrador consegue corrigir a unidade, e só pela tela de "Ajustar".
- Se a internet cair ou o Supabase demorar demais pra responder na hora de
  abrir o site, agora aparece uma tela de "Tentar novamente" em vez de
  ficar travado pra sempre em "Carregando...".
- Ao cadastrar um produto com nome igual ou parecido com um que já existe,
  o sistema avisa antes de criar duplicado.
- Busca por nome na lista de pessoas em Cadastro > Usuários (aparece
  quando há mais de 5 pessoas cadastradas).
- Painel "Resumo" novo em Cadastro (primeira aba) — visão geral pra você
  como gestora: itens em falta, itens com estoque baixo, total de
  produtos/pessoas, atividade recente e quem mais está registrando
  entrada/saída. Não precisa mais entrar em cada aba pra ter esse
  panorama.

**Prioridade baixa**
- Alerta automático por e-mail quando algum item ficar em falta ou com
  estoque baixo — **este item precisa de uma configuração extra sua**
  (conta de e-mail + publicar uma função), porque este ambiente não
  consegue publicar nada no seu projeto Supabase real sozinho. Todo o
  código e o passo a passo estão prontos na pasta
  `supabase/functions/alerta-estoque-baixo/` — comece pelo arquivo
  `index.ts` (tem as instruções "COMO CONFIGURAR" no final dele).
- Layout adaptado pra telas de computador — no celular continua
  exatamente igual; em telas largas, os itens do estoque aparecem em
  grade (em vez de uma coluna só esticada) e os formulários ficam com uma
  largura confortável de leitura.
- Dicas de texto adicionais: explicação do que é "estoque mínimo" nas
  telas de cadastrar/ajustar produto, e um aviso no Histórico dizendo que
  o botão "Desfazer" só aparece em "Últimas registradas" (Entrada/Saída),
  não no Histórico geral.

## Como isso foi testado

Como este ambiente não alcança seu projeto Supabase real, uso duas
frentes de teste antes de entregar qualquer coisa:

- **Mudanças de banco de dados** (RLS, funções): testadas num Postgres
  local que simula o Supabase, incluindo replay exato de bugs reais que
  você reportou (ex.: erro "Database error deleting user").
- **Mudanças de tela**: 11 baterias de teste automatizado (Playwright),
  usando um "Supabase falso" em memória que segue as mesmas regras do banco
  real — todas passando.
  - `test10` cobre a importação de NF: tela bloqueada pra quem não é
    admin, RLS da nova tabela recusando usuário padrão mesmo tentando por
    fora da tela, item já mapeado calculando a quantidade certa
    automaticamente, item novo sendo cadastrado + entrada lançada +
    auditoria + mapeamento salvo pra próxima vez.
  - `test11` cobre a sincronização com a planilha: campo de mapeamento
    aparecendo só pra itens de Cozinha, lista de pendências agrupada
    certa (sem contar o que já foi sincronizado antes), aviso de item sem
    mapeamento, tela de "planilha não encontrada" com o caminho procurado,
    e sucesso marcando só as movimentações certas como sincronizadas.
  - A lógica de EDIÇÃO da planilha em si (achar a linha certa, somar sem
    sobrescrever, preservar fórmulas de "Total"/"Estoque Final") tem um
    teste separado, `teste-logica.js` (dentro de
    `supabase/functions/sync-planilha/`), que roda essa lógica de verdade
    contra um arquivo .xlsx de teste com fórmulas de verdade — 16
    verificações, todas passando.
  - **Importante sobre estes testes**: como este ambiente não tem acesso à
    internet real, não foi possível testar a IA lendo uma foto de nota
    fiscal real, nem a conexão de verdade com o Google Drive — as
    respostas dessas duas partes externas foram simuladas (os testes
    validam a TELA, o BANCO e a lógica de edição da planilha, não a
    conexão externa em si). Vale você testar os dois com dados reais
    assim que configurar as chaves e me avisar como foi.

## Arquivos entregues (pasta `codigo-fonte-backend-supabase` no OneDrive)

- `index.html` — o site atualizado (substitua o que está no Netlify por
  este; o deploy no Netlify aceita arrastar e soltar o arquivo novo).
- `conferencia-nf.html` — a tela de importação de nota fiscal.
- `sync-planilha.html` — **novo**: a tela de sincronização com o Mapa de
  Merenda. Os dois (`conferencia-nf.html` e `sync-planilha.html`) precisam
  subir pro Netlify JUNTO com o `index.html` (mesma pasta/site).
- `schema.sql` — SQL completo atualizado (referência; **não precisa
  rodar de novo**, já tem tudo que os arquivos `fix-*.sql` fazem).
- `fix-fornecedor-produtos.sql` e `fix-planilha-merenda.sql` — **rode os
  dois no SQL Editor do Supabase** (veja "Ação pendente" acima). Os
  `fix-*.sql` de rodadas anteriores (`fix-area-ambas.sql`,
  `fix-auditoria-tipo.sql`, `fix-fk-historico.sql`,
  `fix-protecao-admin.sql`) continuam aqui também, caso precise conferir
  se já rodou algum.
- `mock-supabase.js` + pasta `tests/` — suíte de testes automatizados
  atualizada (não precisa subir no Netlify).
- `supabase/functions/alerta-estoque-baixo/` — código e instruções do
  alerta por e-mail (funcionalidade opcional, já entregue antes).
- `supabase/functions/ler-nf/` — código da Edge Function que lê a foto da
  nota fiscal com IA. Veja "COMO CONFIGURAR" no final do `index.ts`.
- `supabase/functions/sync-planilha/` — **novo**: código da Edge Function
  que sincroniza com o Google Drive (mais o `teste-logica.js` usado pra
  testar a edição do .xlsx). Veja "COMO CONFIGURAR" no final do
  `index.ts` — configuração obrigatória pra sincronização funcionar.

## Aposentado

A versão antiga (Artifact, sem backend) não deve mais ser usada — os
dados de lá não se conectam com o sistema novo.
