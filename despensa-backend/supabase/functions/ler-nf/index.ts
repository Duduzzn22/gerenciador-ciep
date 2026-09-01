// ============================================================================
// LEITURA AUTOMÁTICA DE NOTA FISCAL (FOTO) — Supabase Edge Function
// ============================================================================
// O que esta função faz:
//   Recebe a FOTO de uma nota fiscal (base64), manda pra IA (Google
//   Gemini, plano GRATUITO — veja "COMO CONFIGURAR") com instruções de
//   como uma NF de fornecedor costuma vir escrita, e devolve os dados já
//   estruturados em JSON: cabeçalho da nota (fornecedor, CNPJ, número,
//   data) + cada item (código do produto, descrição, unidade, quantidade,
//   e já com uma SUGESTÃO de nome abreviado pro app e de quantidade total
//   convertida pra unidade individual — do jeito que você já faz
//   manualmente hoje).
//
// ⚠️ Sobre usar o plano gratuito do Gemini: no plano gratuito, o Google
// pode revisar (por pessoas) e usar as fotos enviadas e as respostas da
// IA pra melhorar/treinar os modelos deles — ou seja, a foto da nota
// fiscal não fica 100% privada com o Google. Pra a grande maioria das
// escolas isso não costuma ser um problema real (não são dados sensíveis
// de pessoas, são notas de compra de material de limpeza/cozinha), mas é
// importante você saber disso. Se um dia quiser mais privacidade, dá pra
// trocar por uma conta paga do Gemini (aí o Google não usa os dados pra
// treinar) ou voltar pra IA da Anthropic (paga, poucos centavos por nota)
// — é só trocar a função que chama a IA (o bloco "CHAMA A IA" abaixo),
// o resto do sistema não muda.
//
// O que esta função NÃO faz (de propósito):
//   Não grava nada no banco de dados. Ela só "lê a foto e devolve texto
//   organizado". Quem decide o que fazer com esse resultado — comparar com
//   o que já está cadastrado, criar item novo, lançar entrada — é a tela
//   de conferência (conferencia-nf.html), usando a sessão já logada do
//   administrador (que já respeita todas as regras de permissão do banco).
//   Por isso o único segredo que esta função guarda é a chave da IA — ela
//   nunca vê a chave "de serviço" (service role) que dá acesso total ao
//   banco.
//
// Proteção extra: mesmo só lendo imagem, a função confere que quem está
// chamando é um administrador logado de verdade (usando a própria sessão
// de quem chamou, sem precisar de nenhum segredo extra) — assim ninguém
// consegue gastar sua cota da IA chamando essa função escondido.
//
// IMPORTANTE — leia "COMO CONFIGURAR" no final deste arquivo antes de
// publicar.
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2';

const PROMPT_EXTRACAO = `Você vai ler a foto de uma Nota Fiscal (DANFE) brasileira de compra de
produtos (mercadorias) e devolver SOMENTE um JSON válido (sem markdown, sem
texto antes ou depois), no seguinte formato exato:

{
  "nota": {
    "numero": string ou null,
    "fornecedor_nome": string ou null,
    "fornecedor_cnpj": string ou null (só os dígitos, sem pontuação),
    "data_emissao": string ou null (formato AAAA-MM-DD)
  },
  "itens": [
    {
      "cod_prod": string (o código na coluna "CÓD.PROD" ou equivalente),
      "descricao_nf": string (a descrição exatamente como está escrita na nota),
      "unidade_nf": string (a unidade impressa, ex.: "UN", "PT", "CX", "KG", "LT"),
      "quantidade_nf": number (o número da coluna QTD, exatamente como impresso),
      "unidades_por_embalagem": number,
      "quantidade_total_unidades": number,
      "nome_sugerido_app": string,
      "valor_unitario": number ou null,
      "valor_total": number ou null
    }
  ],
  "avisos": [string]
}

Regras importantes para preencher cada item:

1) "unidades_por_embalagem": quando a descrição do produto indicar quantas
   unidades vêm em cada embalagem/pacote/caixa (padrões comuns: "C 100UN",
   "C/100", "CT 50UN", "PCT C 20", "FD 12X1L" etc.), extraia esse número.
   Quando a unidade já for individual (ex.: unidade "KG", "LT", "UN" sem
   nenhuma indicação de pacote) ou não houver nenhuma indicação de
   embalagem múltipla, use 1.

2) "quantidade_total_unidades" = quantidade_nf × unidades_por_embalagem.
   Exemplo real: nota mostra "SACO LIXO 100L C 100UN", unidade "PT",
   quantidade 4 → unidades_por_embalagem = 100, quantidade_total_unidades =
   400 (isto é: vieram 4 pacotes de 100 unidades cada = 400 unidades no
   total). Esta é exatamente a conta que quem cadastra faz hoje à mão.

3) "nome_sugerido_app": um nome CURTO e direto pro cadastro do estoque,
   removendo marca, código de barras e detalhes redundantes de embalagem,
   mas MANTENDO o que identifica o produto (tipo + característica
   relevante como tamanho/capacidade/perfume/cor quando fizer diferença
   entre produtos parecidos). Exemplos do padrão já usado neste sistema:
   "SACO P/ LIXO 100L REFORÇADO C 100UN PRETO" -> "Saco de Lixo 100L";
   "DETERGENTE NEUTRO LIQUIDO 500ML CONCENTRADO" -> "Detergente Neutro
   500ml"; "ALCOOL ETILICO 70 INPM 1 LITRO" -> "Álcool 70% 1L". Evite
   nomes genéricos demais que percam a diferença entre produtos (ex.: não
   reduza "Detergente Neutro" e "Detergente Coco" ao mesmo nome).

4) Se não conseguir ler algum campo com confiança, ainda assim preencha o
   melhor palpite e acrescente uma frase curta em "avisos" explicando a
   dúvida (ex.: "Quantidade do item 3 pode estar errada, número borrado na
   foto."). Nunca invente um "cod_prod" — se não conseguir ler o código de
   um item, repita a descrição no lugar do código e avise em "avisos".

5) Ignore linhas que não são produtos (frete, informações fiscais soltas,
   totais). Liste só itens de mercadoria de fato.

Devolva only o JSON, nada mais.`;

Deno.serve(async (req) => {
  // CORS: a tela de conferência roda no navegador do administrador, em
  // outra página do mesmo site — precisa poder chamar esta função.
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const jsonResp = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
    const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');
    const GOOGLE_GEMINI_API_KEY = Deno.env.get('GOOGLE_GEMINI_API_KEY');

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      return jsonResp({ erro: 'Faltam as variáveis SUPABASE_URL / SUPABASE_ANON_KEY (deveriam existir automaticamente).' }, 500);
    }
    if (!GOOGLE_GEMINI_API_KEY) {
      return jsonResp({ erro: 'Falta configurar o segredo GOOGLE_GEMINI_API_KEY. Veja "COMO CONFIGURAR" no topo do arquivo index.ts desta função.' }, 500);
    }

    // ---- Confere que quem está chamando é um administrador logado -------
    // Usa a MESMA sessão de quem chamou (o token vem no cabeçalho
    // Authorization, colocado automaticamente pelo supabase-js do
    // navegador) com a chave "anon" — respeita RLS normalmente, não é
    // acesso privilegiado. Só confirma "esta pessoa é admin?".
    const authHeader = req.headers.get('Authorization') || '';
    const clienteDoChamador = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: erroUser } = await clienteDoChamador.auth.getUser();
    if (erroUser || !user) {
      return jsonResp({ erro: 'Não autenticado.' }, 401);
    }
    const { data: perfil, error: erroPerfil } = await clienteDoChamador
      .from('profiles').select('role').eq('id', user.id).single();
    if (erroPerfil || !perfil || perfil.role !== 'admin') {
      return jsonResp({ erro: 'Só um administrador pode importar nota fiscal.' }, 403);
    }

    // ---- Lê a imagem enviada ---------------------------------------------
    const body = await req.json().catch(() => null);
    const imagemBase64 = body?.imagem_base64;
    const mediaType = body?.media_type || 'image/jpeg';
    if (!imagemBase64 || typeof imagemBase64 !== 'string') {
      return jsonResp({ erro: 'Envie "imagem_base64" (a foto da nota, em base64) no corpo da requisição.' }, 400);
    }
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mediaType)) {
      return jsonResp({ erro: 'Formato de imagem não suportado. Use foto em JPEG, PNG ou WEBP.' }, 400);
    }

    // ---- Chama a IA (Google Gemini, plano gratuito) -----------------------
    // Modelo com visão, do plano gratuito do Google AI Studio (não é o
    // Vertex AI do Google Cloud — é a chave simples, sem cartão, gerada em
    // aistudio.google.com). Troque o nome do modelo aqui se um dia o
    // Google descontinuar este (já aconteceu antes com outros modelos
    // "Flash" — veja o aviso no topo do arquivo).
    const MODELO_GEMINI = 'gemini-3.6-flash';
    const iaRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODELO_GEMINI}:generateContent?key=${GOOGLE_GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { inline_data: { mime_type: mediaType, data: imagemBase64 } },
              { text: PROMPT_EXTRACAO },
            ],
          }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 4096,
            responseMimeType: 'application/json',
          },
        }),
      }
    );

    if (!iaRes.ok) {
      const detalhe = await iaRes.text();
      throw new Error('Falha ao chamar a IA: ' + detalhe);
    }

    const iaJson = await iaRes.json();
    const candidato = iaJson.candidates && iaJson.candidates[0];
    const textoResposta = candidato && candidato.content && candidato.content.parts
      ? candidato.content.parts.map((p) => p.text || '').join('').trim()
      : '';

    if (!textoResposta) {
      const motivoBloqueio = (iaJson.promptFeedback && iaJson.promptFeedback.blockReason) || (candidato && candidato.finishReason);
      throw new Error('A IA não devolveu nenhum texto' + (motivoBloqueio ? (' (motivo: ' + motivoBloqueio + ')') : '') + '. Tente tirar a foto de novo.');
    }

    let extraido;
    try {
      // Pedimos responseMimeType "application/json" (o Gemini já devolve
      // JSON puro nesse modo), mas por segurança tiramos markdown se
      // aparecer mesmo assim.
      const limpo = textoResposta.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
      extraido = JSON.parse(limpo);
    } catch {
      return jsonResp({ erro: 'A IA respondeu em um formato que não deu pra entender. Tente tirar a foto de novo, com mais luz e enquadrando a nota inteira.' }, 502);
    }

    if (!extraido || !Array.isArray(extraido.itens)) {
      return jsonResp({ erro: 'A IA não conseguiu identificar nenhum item nessa foto.' }, 502);
    }

    return jsonResp({ ok: true, ...extraido });
  } catch (e) {
    return jsonResp({ ok: false, erro: String(e && e.message ? e.message : e) }, 500);
  }
});

// ============================================================================
// COMO CONFIGURAR (só precisa fazer uma vez)
// ============================================================================
// 1) Pegue uma chave GRATUITA do Google Gemini: acesse
//    https://aistudio.google.com/apikey, entre com uma conta Google
//    (pode ser a mesma do Drive, ou outra — não precisa ser a mesma) e
//    clique em "Create API key" (ou "Criar chave de API"). NÃO pede
//    cartão de crédito. A chave começa com "AIza...".
//
//    Limite do plano gratuito: 1.500 leituras de nota por dia — muito
//    mais do que uma escola usa no dia a dia. Se um dia bater nesse
//    limite (raro), a tela mostra o erro claramente, é só tentar de novo
//    mais tarde ou no dia seguinte.
//
//    ⚠️ Leia o aviso de privacidade no topo deste arquivo antes de
//    configurar — no plano gratuito, o Google pode revisar e usar as
//    fotos das notas pra melhorar os modelos deles.
//
// 2) Publique esta função e configure o segredo dela. Pode ser feito direto
//    pelo painel do Supabase, sem precisar instalar nada:
//      - Edge Functions > Deploy a new function > Via Editor > cole este
//        código > Deploy function.
//      - Edge Functions > Secrets > adicione a chave GOOGLE_GEMINI_API_KEY
//        com o valor da sua chave (AIzaxxx).
//    (SUPABASE_URL e SUPABASE_ANON_KEY já existem automaticamente, não
//    precisa configurar. Também dá pra fazer isso via Supabase CLI, se
//    preferir: supabase functions deploy ler-nf / supabase secrets set.)
//
// 3) Pronto — a tela "Importar de NF" dentro do app já sabe chamar esta
//    função sozinha, usando a sessão de quem estiver logado como
//    administrador.
// ============================================================================
