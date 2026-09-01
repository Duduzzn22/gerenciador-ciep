// ============================================================================
// SINCRONIZAÇÃO COM O MAPA DE MERENDA (planilha Excel no Google Drive)
// ============================================================================
// O que esta função faz:
//   Recebe do app uma lista de itens de Cozinha com o total de
//   entrada/saída pendente de cada um (o app já calculou isso consultando
//   o próprio banco, respeitando as permissões normais — esta função NÃO
//   tem acesso ao Supabase/banco de dados). A função então:
//     1) Descobre o caminho da planilha do MÊS ATUAL dentro da pasta
//        "Mapa de Merenda" no Google Drive (ano -> mês -> arquivo).
//     2) Se a planilha desse mês ainda não existir (comum nos primeiros
//        dias do mês, já que a criação é manual), devolve uma resposta
//        clara dizendo onde procurou — não inventa nada nem falha calado.
//     3) Se existir, baixa o arquivo .xlsx de verdade, SOMA os totais
//        recebidos às células que já estão na planilha (preserva qualquer
//        valor já lançado à mão, e não mexe nas fórmulas de "Total" e
//        "Estoque Final" — só escreve em "Entrada" e "Saída"), e salva de
//        volta no mesmo arquivo, no mesmo lugar.
//     4) Devolve quais linhas foram atualizadas, e quais itens enviados
//        não bateram com nenhuma linha da planilha desse mês (aviso, pra
//        você corrigir o mapeamento — não trava a sincronização dos que
//        deram certo).
//
// Autenticação com o Google: usa uma CONTA DE SERVIÇO (não é login de
// ninguém) — você compartilha a pasta "Mapa de Merenda" com o e-mail da
// conta de serviço uma única vez, e a partir daí funciona sozinha, sem
// ninguém precisar fazer login no Google. A chave fica guardada como
// segredo aqui, nunca chega ao navegador.
//
// IMPORTANTE — leia "COMO CONFIGURAR" no final deste arquivo antes de
// publicar.
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2';
import * as XLSX from 'npm:xlsx@0.18.5';

var NOMES_MES = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

function normalizar(s) {
  return String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

/* ---------------------------------------------------------------------
   AUTENTICAÇÃO COM O GOOGLE (conta de serviço) — assina um JWT com a
   chave privada (Web Crypto, sem depender de biblioteca externa) e troca
   por um token de acesso.
--------------------------------------------------------------------- */
function base64url(input) {
  var bytes = (input instanceof Uint8Array) ? input : new TextEncoder().encode(input);
  var bin = '';
  for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function importarChavePrivada(pem) {
  // Remove cabeçalho/rodapé do PEM, aspas que sobraram de uma colagem
  // acidental do JSON (ex.: '"-----BEGIN...') e qualquer espaço/quebra de
  // linha, deixando só o base64 puro.
  var corpo = String(pem)
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/["'`]/g, '')
    .replace(/\s+/g, '');
  var bin;
  try {
    bin = atob(corpo);
  } catch (e) {
    throw new Error('A chave privada do Google (GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY) não é um base64 válido depois de limpa. Reabra o arquivo .json baixado do Google Cloud, copie só o valor do campo "private_key" (sem as aspas do JSON) e cole de novo no segredo, substituindo o valor atual.');
  }
  var raw = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);
  return await crypto.subtle.importKey('pkcs8', raw.buffer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}
async function obterTokenAcessoGoogle(email, chavePrivadaPem, escopo) {
  var agora = Math.floor(Date.now() / 1000);
  var header = { alg: 'RS256', typ: 'JWT' };
  var claims = { iss: email, scope: escopo, aud: 'https://oauth2.googleapis.com/token', iat: agora, exp: agora + 3600 };
  var entrada = base64url(JSON.stringify(header)) + '.' + base64url(JSON.stringify(claims));
  var chave = await importarChavePrivada(chavePrivadaPem);
  var assinatura = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', chave, new TextEncoder().encode(entrada));
  var jwt = entrada + '.' + base64url(new Uint8Array(assinatura));

  var res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + jwt,
  });
  var json = await res.json();
  if (!res.ok) throw new Error('Falha ao autenticar com a conta de serviço do Google: ' + (json.error_description || json.error || JSON.stringify(json)));
  return json.access_token;
}

/* ---------------------------------------------------------------------
   GOOGLE DRIVE — busca de pastas/arquivos e leitura/escrita do conteúdo.
--------------------------------------------------------------------- */
async function driveBuscarPorNomeExato(token, nome, opts) {
  var filtroTipo = (opts && opts.somentePastas) ? " and mimeType='application/vnd.google-apps.folder'" : '';
  var filtroPai = (opts && opts.dentroDe) ? (" and '" + opts.dentroDe + "' in parents") : '';
  var q = "name='" + nome.replace(/'/g, "\\'") + "' and trashed=false" + filtroTipo + filtroPai;
  var url = 'https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent(q) + '&fields=files(id,name,mimeType)&pageSize=10&supportsAllDrives=true&includeItemsFromAllDrives=true';
  var res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  var json = await res.json();
  if (!res.ok) throw new Error('Falha ao buscar no Google Drive: ' + (json.error && json.error.message || JSON.stringify(json)));
  return json.files || [];
}
async function driveListarFilhos(token, pastaId) {
  var q = "'" + pastaId + "' in parents and trashed=false";
  var url = 'https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent(q) + '&fields=files(id,name,mimeType)&pageSize=200&supportsAllDrives=true&includeItemsFromAllDrives=true';
  var res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  var json = await res.json();
  if (!res.ok) throw new Error('Falha ao listar o conteúdo da pasta no Google Drive: ' + (json.error && json.error.message || JSON.stringify(json)));
  return json.files || [];
}
async function driveBaixarConteudo(token, fileId) {
  var res = await fetch('https://www.googleapis.com/drive/v3/files/' + fileId + '?alt=media&supportsAllDrives=true', { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok) throw new Error('Falha ao baixar a planilha do Google Drive: ' + await res.text());
  return new Uint8Array(await res.arrayBuffer());
}
async function driveSalvarConteudo(token, fileId, bytes, mimeType) {
  var res = await fetch('https://www.googleapis.com/upload/drive/v3/files/' + fileId + '?uploadType=media&supportsAllDrives=true', {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': mimeType },
    body: bytes,
  });
  if (!res.ok) throw new Error('Falha ao salvar a planilha atualizada no Google Drive: ' + await res.text());
  return await res.json();
}

/* ---------------------------------------------------------------------
   RESOLUÇÃO DO CAMINHO DO MÊS — a nomenclatura é digitada à mão todo mês
   (a pasta segue um padrão levemente diferente do arquivo — ex.: pasta
   "08- Agosto", arquivo "08 - Agosto_2026.xlsx"), então além do nome
   "esperado" a busca aceita qualquer nome que contenha o número do mês
   (com 2 dígitos) E o nome do mês, não importa a pontuação exata.
--------------------------------------------------------------------- */
function nomesEsperados(ano, mesIndex1a12) {
  var nn = String(mesIndex1a12).padStart(2, '0');
  var nomeMes = NOMES_MES[mesIndex1a12 - 1];
  return {
    nn: nn,
    nomeMes: nomeMes,
    pastaMes: nn + '- ' + nomeMes,
    arquivo: nn + ' - ' + nomeMes + '_' + ano + '.xlsx',
  };
}
function pareceCorreto(nomeReal, nn, nomeMes) {
  var n = normalizar(nomeReal);
  return n.indexOf(nn) !== -1 && n.indexOf(normalizar(nomeMes)) !== -1;
}
async function acharPastaOuArquivoDoMes(token, filhos, esperado, tipo) {
  // 1ª tentativa: nome exatamente igual ao padrão esperado.
  var exato = filhos.filter(function (f) { return f.name === (tipo === 'pasta' ? esperado.pastaMes : esperado.arquivo); })[0];
  if (exato) return exato;
  // 2ª tentativa: qualquer nome que contenha o número do mês + o nome do mês
  // (cobre variação de espaçamento/pontuação de quem cria a pasta à mão).
  var candidatos = filhos.filter(function (f) { return pareceCorreto(f.name, esperado.nn, esperado.nomeMes); });
  if (tipo === 'arquivo') candidatos = candidatos.filter(function (f) { return /\.xlsx$/i.test(f.name); });
  else candidatos = candidatos.filter(function (f) { return f.mimeType === 'application/vnd.google-apps.folder'; });
  return candidatos[0] || null;
}

async function localizarPlanilhaDoMes(token, ano, mes) {
  var NOME_PASTA_RAIZ = Deno.env.get('GOOGLE_PASTA_MAPA_MERENDA') || 'Mapa de Merenda';
  var esperado = nomesEsperados(ano, mes);
  var procurou = { pastaRaiz: NOME_PASTA_RAIZ, pastaAno: String(ano), pastaMes: esperado.pastaMes, arquivo: esperado.arquivo };

  var raizCandidatas = await driveBuscarPorNomeExato(token, NOME_PASTA_RAIZ, { somentePastas: true });
  if (!raizCandidatas.length) {
    return { encontrada: false, procurou: procurou, motivo: 'pasta_raiz', mensagem: 'Não encontrei a pasta "' + NOME_PASTA_RAIZ + '" no Google Drive. Confirme se ela foi compartilhada com o e-mail da conta de serviço (veja "COMO CONFIGURAR").' };
  }
  var raiz = raizCandidatas[0];

  var filhosAno = await driveListarFilhos(token, raiz.id);
  var pastaAno = filhosAno.filter(function (f) { return f.mimeType === 'application/vnd.google-apps.folder' && f.name === String(ano); })[0];
  if (!pastaAno) {
    return { encontrada: false, procurou: procurou, motivo: 'pasta_ano', mensagem: 'Não encontrei a pasta do ano "' + ano + '" dentro de "' + NOME_PASTA_RAIZ + '".' };
  }

  var filhosMes = await driveListarFilhos(token, pastaAno.id);
  var pastaMes = await acharPastaOuArquivoDoMes(token, filhosMes, esperado, 'pasta');
  if (!pastaMes) {
    return { encontrada: false, procurou: procurou, motivo: 'pasta_mes', mensagem: 'A pasta do mês ("' + esperado.pastaMes + '") ainda não foi criada. Isso é normal nos primeiros dias do mês — assim que você criar a pasta (copiando a do mês anterior), é só sincronizar de novo.' };
  }

  var filhosArquivo = await driveListarFilhos(token, pastaMes.id);
  var arquivo = await acharPastaOuArquivoDoMes(token, filhosArquivo, esperado, 'arquivo');
  if (!arquivo) {
    return { encontrada: false, procurou: procurou, motivo: 'arquivo', mensagem: 'A pasta do mês existe, mas ainda não achei a planilha ("' + esperado.arquivo + '") dentro dela.' };
  }

  return { encontrada: true, procurou: procurou, arquivo: arquivo };
}

/* ---------------------------------------------------------------------
   EDIÇÃO DA PLANILHA — soma os totais recebidos às células que já
   existem, sem tocar nas fórmulas de Total/Estoque Final.
--------------------------------------------------------------------- */
function acharCabecalhoMensal(aoa) {
  for (var r = 0; r < Math.min(aoa.length, 15); r++) {
    var linha = aoa[r] || [];
    var idx = {};
    linha.forEach(function (celula, c) {
      var n = normalizar(celula);
      if (/genero/.test(n)) idx.genero = c;
      else if (n === 'entrada') idx.entrada = c;
      else if (n === 'saida') idx.saida = c;
    });
    if (idx.genero != null && idx.entrada != null && idx.saida != null) {
      idx.linhaCabecalho = r;
      return idx;
    }
  }
  return null;
}
function editarPlanilha(bytesOriginais, itens) {
  var wb = XLSX.read(bytesOriginais, { type: 'array', cellStyles: true });
  var nomeAba = wb.SheetNames.filter(function (n) { return normalizar(n) === 'mensal'; })[0] || wb.SheetNames[0];
  var ws = wb.Sheets[nomeAba];
  var aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  var cab = acharCabecalhoMensal(aoa);
  if (!cab) {
    throw new Error('Não consegui identificar as colunas "Gênero", "Entrada" e "Saída" na aba "' + nomeAba + '". Confirme se o cabeçalho da planilha não mudou.');
  }

  var linhasAtualizadas = [];
  var semCorrespondencia = [];

  itens.forEach(function (it) {
    var alvoLinha = -1;
    for (var r = cab.linhaCabecalho + 1; r < aoa.length; r++) {
      var textoGenero = (aoa[r] || [])[cab.genero];
      if (normalizar(textoGenero) === normalizar(it.genero_planilha)) { alvoLinha = r; break; }
    }
    if (alvoLinha === -1) {
      semCorrespondencia.push(it.genero_planilha);
      return;
    }
    var enderecoEntrada = XLSX.utils.encode_cell({ r: alvoLinha, c: cab.entrada });
    var enderecoSaida = XLSX.utils.encode_cell({ r: alvoLinha, c: cab.saida });

    var entradaAtual = (ws[enderecoEntrada] && typeof ws[enderecoEntrada].v === 'number') ? ws[enderecoEntrada].v : 0;
    var saidaAtual = (ws[enderecoSaida] && typeof ws[enderecoSaida].v === 'number') ? ws[enderecoSaida].v : 0;
    var novaEntrada = entradaAtual + (Number(it.entrada_total) || 0);
    var novaSaida = saidaAtual + (Number(it.saida_total) || 0);

    if (!ws[enderecoEntrada]) ws[enderecoEntrada] = { t: 'n', v: novaEntrada };
    else { ws[enderecoEntrada].t = 'n'; ws[enderecoEntrada].v = novaEntrada; delete ws[enderecoEntrada].f; }
    if (!ws[enderecoSaida]) ws[enderecoSaida] = { t: 'n', v: novaSaida };
    else { ws[enderecoSaida].t = 'n'; ws[enderecoSaida].v = novaSaida; delete ws[enderecoSaida].f; }

    linhasAtualizadas.push({ genero_planilha: it.genero_planilha, entrada_somada: Number(it.entrada_total) || 0, saida_somada: Number(it.saida_total) || 0, entrada_na_celula: novaEntrada, saida_na_celula: novaSaida });
  });

  // Observação: as células "Total" e "Estoque Final" continuam com a
  // FÓRMULA intacta, mas o VALOR exibido em cache (o número que aparece
  // antes de recalcular) pode ficar momentaneamente desatualizado até o
  // Excel/Planilhas Google reabrir o arquivo e recalcular — o que
  // acontece sozinho, automaticamente, na config padrão do Excel (é só
  // uma questão de "não é instantâneo pra quem está com o arquivo já
  // aberto"; quem abrir depois já vê o número certo).
  var novosBytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx', cellStyles: true });
  return { bytes: new Uint8Array(novosBytes), aba: nomeAba, linhasAtualizadas: linhasAtualizadas, semCorrespondencia: semCorrespondencia };
}

/* ---------------------------------------------------------------------
   HANDLER
--------------------------------------------------------------------- */
Deno.serve(async (req) => {
  var corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  var jsonResp = (body, status) => new Response(JSON.stringify(body), { status: status || 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  try {
    var SUPABASE_URL = Deno.env.get('SUPABASE_URL');
    var SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');
    var GOOGLE_EMAIL = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_EMAIL');
    var GOOGLE_CHAVE = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY');

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return jsonResp({ erro: 'Faltam SUPABASE_URL / SUPABASE_ANON_KEY (deveriam existir automaticamente).' }, 500);
    if (!GOOGLE_EMAIL || !GOOGLE_CHAVE) return jsonResp({ erro: 'Faltam os segredos GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY. Veja "COMO CONFIGURAR" no topo do arquivo index.ts desta função.' }, 500);

    // ---- Confere que quem chamou é administrador logado -----------------
    var authHeader = req.headers.get('Authorization') || '';
    var clienteDoChamador = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    var { data: { user }, error: erroUser } = await clienteDoChamador.auth.getUser();
    if (erroUser || !user) return jsonResp({ erro: 'Não autenticado.' }, 401);
    var { data: perfil, error: erroPerfil } = await clienteDoChamador.from('profiles').select('role').eq('id', user.id).single();
    if (erroPerfil || !perfil || perfil.role !== 'admin') return jsonResp({ erro: 'Só um administrador pode sincronizar com a planilha.' }, 403);

    // ---- Lê o corpo da requisição ----------------------------------------
    var body = await req.json().catch(() => null);
    var itens = (body && Array.isArray(body.itens)) ? body.itens : [];
    var agora = new Date();
    var ano = (body && body.ano) || agora.getFullYear();
    var mes = (body && body.mes) || (agora.getMonth() + 1);

    if (!itens.length) return jsonResp({ ok: true, semItensPendentes: true });

    // ---- Autentica com o Google e localiza a planilha do mês -------------
    var token = await obterTokenAcessoGoogle(GOOGLE_EMAIL, GOOGLE_CHAVE.replace(/\\n/g, '\n'), 'https://www.googleapis.com/auth/drive');
    var achado = await localizarPlanilhaDoMes(token, ano, mes);
    if (!achado.encontrada) {
      return jsonResp({ ok: false, naoEncontrado: true, procurou: achado.procurou, erro: achado.mensagem });
    }

    // ---- Baixa, edita e reenvia -------------------------------------------
    var bytesOriginais = await driveBaixarConteudo(token, achado.arquivo.id);
    var resultado = editarPlanilha(bytesOriginais, itens);
    await driveSalvarConteudo(token, achado.arquivo.id, resultado.bytes, achado.arquivo.mimeType || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

    return jsonResp({
      ok: true,
      arquivo: { nome: achado.arquivo.name, aba: resultado.aba },
      linhasAtualizadas: resultado.linhasAtualizadas,
      semCorrespondencia: resultado.semCorrespondencia,
    });
  } catch (e) {
    return jsonResp({ ok: false, erro: String(e && e.message ? e.message : e) }, 500);
  }
});

// ============================================================================
// COMO CONFIGURAR (só precisa fazer uma vez)
// ============================================================================
// 1) Crie uma CONTA DE SERVIÇO no Google Cloud Console:
//    a) Acesse https://console.cloud.google.com, crie um projeto (ou use um
//       já existente) e, no menu, vá em "APIs e serviços" → "Biblioteca" →
//       ative a "Google Drive API".
//    b) Vá em "APIs e serviços" → "Credenciais" → "Criar credenciais" →
//       "Conta de serviço". Dê um nome (ex.: "despensa-digital-sync") e
//       conclua.
//    c) Abra a conta de serviço criada → aba "Chaves" → "Adicionar chave"
//       → "Criar nova chave" → tipo JSON. Isso baixa um arquivo .json —
//       GUARDE-O COM CUIDADO, é uma senha. Dentro dele tem os campos
//       "client_email" e "private_key" que você vai usar no passo 3.
//
// 2) Compartilhe a pasta "Mapa de Merenda" (só ELA, não precisa
//    compartilhar pastas acima) com o e-mail da conta de serviço
//    (o "client_email" do arquivo .json, algo como
//    "despensa-digital-sync@SEU-PROJETO.iam.gserviceaccount.com"):
//    no Google Drive, clique com o botão direito na pasta "Mapa de
//    Merenda" → Compartilhar → cole esse e-mail → dê permissão de
//    "Editor". Isso é TUDO que a conta de serviço vai conseguir enxergar
//    no seu Drive — nada além dessa pasta.
//
// 3) Publique esta função e configure os segredos dela. Pode ser feito
//    direto pelo painel do Supabase, sem precisar instalar nada:
//      - Edge Functions > Deploy a new function > Via Editor > cole este
//        código > Deploy function.
//      - Edge Functions > Secrets > adicione GOOGLE_SERVICE_ACCOUNT_EMAIL
//        (o "client_email" do .json) e GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
//        (o "private_key" do .json, colado exatamente como está — já vem
//        com "\n" dentro do texto, o próprio código desta função trata
//        isso).
//    (SUPABASE_URL e SUPABASE_ANON_KEY já existem automaticamente, não
//    precisa configurar. Também dá pra fazer isso via Supabase CLI, se
//    preferir: supabase functions deploy sync-planilha / supabase secrets
//    set.)
//
// 4) Pronto — a tela "Sincronizar com a planilha" dentro do app já sabe
//    chamar esta função sozinha.
// ============================================================================
