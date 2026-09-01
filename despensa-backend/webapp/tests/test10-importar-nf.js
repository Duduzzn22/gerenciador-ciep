// Teste 10: importação automática de NF por foto (Tarefas #32-#36).
// Não testa a IA de verdade (não há internet neste ambiente) — simula a
// resposta da Edge Function "ler-nf" via client.__setFunctionMock, e valida
// a tela de conferência + a gravação final no banco (via o mock, que segue
// as mesmas regras de RLS/RPC do schema.sql).
const { chromium } = require('playwright');
const { launchOptions, abrirConferenciaNF, seedPadrao, uid } = require('./helpers');

// Um PNG 1x1 válido (não importa o conteúdo real da imagem — a IA é mock).
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

(async () => {
  const browser = await chromium.launch(launchOptions());
  let falhas = 0;
  function check(desc, cond) {
    console.log((cond ? 'OK  ' : 'FALHOU  ') + desc);
    if (!cond) falhas++;
  }

  const seed = seedPadrao();
  const CNPJ = '11222333000144';
  // Mapeamento já conhecido: cod_prod "COD-DET" -> item "Detergente"
  // (id itemLimpId), com fator de conversão 6 (cada pacote tem 6 unidades).
  seed.fornecedor_produtos = [
    {
      id: uid(), fornecedor_cnpj: CNPJ, fornecedor_nome: 'Comercial Milano Brasil Ltda',
      cod_prod_nf: 'COD-DET', descricao_nf: 'DETERGENTE NEUTRO C 6UN', item_id: seed.ids.itemLimpId,
      item_nome: 'Detergente', unidade_nf: 'PT', unidades_por_embalagem: 6,
      criado_por: 'Diretora Admin', criado_em: new Date().toISOString(), atualizado_por: null, atualizado_em: null,
    },
  ];

  const respostaIA = {
    data: {
      ok: true,
      nota: { numero: '12345', fornecedor_nome: 'Comercial Milano Brasil Ltda', fornecedor_cnpj: CNPJ, data_emissao: '2026-08-20' },
      avisos: [],
      itens: [
        {
          cod_prod: 'COD-DET', descricao_nf: 'DETERGENTE NEUTRO C 6UN', unidade_nf: 'PT', quantidade_nf: 2,
          unidades_por_embalagem: 6, quantidade_total_unidades: 12, nome_sugerido_app: 'Detergente Neutro',
          valor_unitario: 8.5, valor_total: 17,
        },
        {
          cod_prod: 'COD-SACO', descricao_nf: 'SACO LIXO 100L REFORCADO C 100UN', unidade_nf: 'PT', quantidade_nf: 4,
          unidades_por_embalagem: 100, quantidade_total_unidades: 400, nome_sugerido_app: 'Saco de Lixo 100L',
          valor_unitario: 45, valor_total: 180,
        },
      ],
    },
    error: null,
  };

  /* ---- Cenário 1: sem sessão -> tela pede login ---- */
  {
    const page = await abrirConferenciaNF(browser, seed);
    await page.evaluate(async () => { await window.__iniciarConferenciaNF__(); });
    await page.waitForTimeout(150);
    check('Sem sessão: mostra aviso pra entrar no app', (await page.locator('a[href="index.html"]').count()) >= 1);
    check('Sem sessão: nenhum item de conferência aparece', (await page.locator('.nf-item-row').count()) === 0);
    await page.close();
  }

  /* ---- Cenário 2: sessão de usuário PADRÃO -> bloqueado (só admin) ---- */
  {
    const page = await abrirConferenciaNF(browser, seed);
    await page.evaluate(async () => {
      await window.__DESPENSA_TEST_CLIENT__.auth.signInWithPassword({ email: 'limp@escola.com', password: 'senha123' });
      await window.__iniciarConferenciaNF__();
    });
    await page.waitForTimeout(150);
    check('Usuário padrão: mensagem de "só administradores"', (await page.locator('text=Só administradores').count()) === 1);

    // Ataque via devtools: mesmo sem a tela deixar chegar até aqui, o banco
    // (aqui, o mock que espelha o schema.sql) tem que recusar sozinho.
    const resultado = await page.evaluate(async () => {
      const r = await window.__DESPENSA_TEST_CLIENT__.from('fornecedor_produtos').insert({ fornecedor_cnpj: '00000000000000', cod_prod_nf: 'X', unidades_por_embalagem: 1 });
      return r.error ? r.error.message : null;
    });
    check('RLS: usuário padrão não consegue inserir em fornecedor_produtos', /row-level security/.test(resultado || ''));
    await page.close();
  }

  /* ---- Cenário 3: admin -> fluxo completo de importação ---- */
  {
    const page = await abrirConferenciaNF(browser, seed);
    await page.evaluate(async () => {
      await window.__DESPENSA_TEST_CLIENT__.auth.signInWithPassword({ email: 'admin@escola.com', password: 'senha123' });
      await window.__iniciarConferenciaNF__();
    });
    await page.waitForTimeout(150);
    check('Admin: tela de upload aparece', (await page.locator('#input-foto').count()) === 1);

    await page.setInputFiles('#input-foto', { name: 'nota.png', mimeType: 'image/png', buffer: PNG_1X1 });
    await page.waitForTimeout(200);
    check('Admin: preview da foto aparece depois de escolher', (await page.locator('img.thumb').count()) === 1);

    await page.evaluate((resp) => { window.__DESPENSA_TEST_CLIENT__.__setFunctionMock('ler-nf', resp); }, respostaIA);
    await page.locator('#btn-ler-nota').click();
    await page.waitForSelector('.nf-item-row', { timeout: 5000 });

    const linhas = page.locator('.nf-item-row');
    check('Conferência: mostra os 2 itens da nota', (await linhas.count()) === 2);
    check('Conferência: item já mapeado aparece como "Já cadastrado"', (await page.locator('.badge-existente').count()) === 1);
    check('Conferência: item novo aparece como "Novo"', (await page.locator('.badge-novo').count()) === 1);

    const textoTudo = await page.locator('#conteudo').textContent();
    const qtdInputs = page.locator('input[data-campo="quantidade_total"]');
    const qtdValores = await qtdInputs.evaluateAll((els) => els.map((e) => e.value));
    check('Conferência: quantidade do item existente já veio calculada (2 x 6 = 12)', qtdValores.indexOf('12') !== -1);
    check('Conferência: quantidade do item novo já veio calculada (400)', qtdValores.indexOf('400') !== -1);
    check('Conferência: nome sugerido do item novo aparece', /Saco de Lixo 100L/.test(textoTudo));

    await page.locator('#btn-confirmar-lancamento').click();
    await page.waitForSelector('text=Importação concluída', { timeout: 5000 });

    const db = await page.evaluate(() => window.__DESPENSA_TEST_CLIENT__._db);
    const detergente = db.items.find((i) => i.id === seed.ids.itemLimpId);
    check('Banco: quantidade do Detergente foi de 3 para 15 (3 + 12)', Number(detergente.qty) === 15);

    const sacoLixo = db.items.find((i) => i.name === 'Saco de Lixo 100L');
    check('Banco: item novo "Saco de Lixo 100L" foi criado', !!sacoLixo);
    check('Banco: item novo entrou na categoria de Limpeza', !!sacoLixo && sacoLixo.category_id === seed.ids.catLimpId);
    check('Banco: item novo já entrou com 400 no estoque', !!sacoLixo && Number(sacoLixo.qty) === 400);

    const movsSaco = db.movements.filter((m) => sacoLixo && m.item_id === sacoLixo.id);
    check('Banco: movimentação de entrada do item novo foi registrada', movsSaco.length === 1 && movsSaco[0].type === 'entrada' && Number(movsSaco[0].qty) === 400);

    const auditoriaProduto = db.audit_log.filter((a) => a.tipo === 'produto' && /Saco de Lixo 100L/.test(a.descricao));
    check('Banco: auditoria do cadastro do item novo foi registrada', auditoriaProduto.length === 1);

    const mapaSaco = db.fornecedor_produtos.find((m) => m.cod_prod_nf === 'COD-SACO');
    check('Banco: mapeamento fornecedor->produto foi criado pro item novo', !!mapaSaco && mapaSaco.item_id === (sacoLixo && sacoLixo.id));
    check('Banco: fator de conversão do novo mapeamento ficou correto (400/4=100)', !!mapaSaco && Number(mapaSaco.unidades_por_embalagem) === 100);

    const mapaDet = db.fornecedor_produtos.find((m) => m.cod_prod_nf === 'COD-DET');
    check('Banco: mapeamento já existente continua apontando pro Detergente', !!mapaDet && mapaDet.item_id === seed.ids.itemLimpId);

    await page.close();
  }

  console.log('\n--- RESULTADO test10-importar-nf ---');
  console.log(falhas === 0 ? 'TODOS OS CHECKS PASSARAM' : (falhas + ' CHECK(S) FALHARAM'));
  await browser.close();
  process.exit(falhas === 0 ? 0 : 1);
})();
