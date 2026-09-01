// Teste 11: sincronização com o Mapa de Merenda / Google Drive (Tarefas
// #37-#41). Não testa o Google real (não há internet neste ambiente) —
// simula a resposta da Edge Function "sync-planilha" via
// client.__setFunctionMock, e valida: o campo de mapeamento no app
// principal, a tela de sincronização (pendências, alerta de planilha não
// encontrada, sucesso), e a gravação final no banco.
const { chromium } = require('playwright');
const { launchOptions, abrirApp, abrirSyncPlanilha, seedPadrao, uid } = require('./helpers');

(async () => {
  const browser = await chromium.launch(launchOptions());
  let falhas = 0;
  function check(desc, cond) {
    console.log((cond ? 'OK  ' : 'FALHOU  ') + desc);
    if (!cond) falhas++;
  }

  /* ---- Cenário 1: campo "Linha no Mapa de Merenda" no app principal ---- */
  {
    const seed = seedPadrao(); // itemCozId = "Arroz", categoria Cozinha
    const page = await abrirApp(browser, seed);
    await page.waitForSelector('.auth-box');
    await page.fill('[data-field="auth-email"]', 'admin@escola.com');
    await page.fill('[data-field="auth-senha"]', 'senha123');
    await page.locator('[data-action="fazer-login"]').click();
    await page.waitForSelector('.item-card', { timeout: 5000 });

    await page.locator('[data-action="ajustar-item"][data-id="' + seed.ids.itemCozId + '"]').click();
    await page.waitForSelector('.modal');
    check('Campo de mapeamento aparece pra item de Cozinha (admin)', (await page.locator('[data-field="aj-genero-planilha"]').count()) === 1);

    await page.fill('[data-field="aj-genero-planilha"]', 'ARROZ TIPO 1');
    await page.locator('[data-action="salvar-ajuste"]').click();
    await page.waitForTimeout(300);

    const db1 = await page.evaluate(() => window.__DESPENSA_TEST_CLIENT__._db);
    const mapaArroz = db1.planilha_merenda_mapa.find((m) => m.item_id === seed.ids.itemCozId);
    check('Mapeamento foi salvo (upsert) no banco', !!mapaArroz && mapaArroz.genero_planilha === 'ARROZ TIPO 1');

    // Item de Limpeza não deve ter esse campo (a planilha é só de Cozinha).
    await page.locator('[data-action="close-modal"]').click().catch(() => {});
    await page.locator('[data-action="ajustar-item"][data-id="' + seed.ids.itemLimpId + '"]').click();
    await page.waitForSelector('.modal');
    check('Campo de mapeamento NÃO aparece pra item de Limpeza', (await page.locator('[data-field="aj-genero-planilha"]').count()) === 0);

    await page.close();
  }

  /* ---- Prepara o seed compartilhado pelos cenários da tela de sync ---- */
  function montarSeedSync() {
    const seed = seedPadrao();
    const movJaSincronizadaId = uid();
    const movArrozPendenteId = uid();
    const movFeijaoId = uid();
    const itemFeijaoId = uid();

    seed.categories.push({ id: uid(), nome: 'Grãos', area: 'cozinha', created_at: new Date().toISOString() });
    const catGraosId = seed.categories[seed.categories.length - 1].id;
    seed.items.push({ id: itemFeijaoId, name: 'Feijão', category_id: catGraosId, unit: 'kg', qty: 5, min: 3, criado_por: 'Diretora Admin', criado_em: new Date().toISOString(), ajustado_por: null, ajustado_em: null });

    seed.planilha_merenda_mapa = [
      { id: uid(), item_id: seed.ids.itemCozId, genero_planilha: 'ARROZ TIPO 1', criado_por: 'Diretora Admin', criado_em: new Date().toISOString(), atualizado_por: null, atualizado_em: null },
    ];

    seed.movements = [
      // Já sincronizada antes (não deve aparecer como pendente).
      { id: movJaSincronizadaId, item_id: seed.ids.itemCozId, type: 'entrada', qty: 8, unidade: 'kg', who_id: seed.ids.adminId, who_name: 'Diretora Admin', fornecedor: 'Fornecedor Antigo', motivo: '', nota: '', at: new Date(Date.now() - 100000).toISOString(), estornado: false, estornado_por: null, estornado_por_nome: null, estornado_em: null, sincronizado_planilha_em: new Date(Date.now() - 50000).toISOString() },
      // Pendente, item mapeado (Arroz).
      { id: movArrozPendenteId, item_id: seed.ids.itemCozId, type: 'entrada', qty: 20, unidade: 'kg', who_id: seed.ids.adminId, who_name: 'Diretora Admin', fornecedor: 'Fornecedor X', motivo: '', nota: '', at: new Date().toISOString(), estornado: false, estornado_por: null, estornado_por_nome: null, estornado_em: null, sincronizado_planilha_em: null },
      // Pendente, item SEM mapeamento (Feijão) — deve virar aviso, não pendência sincronizável.
      { id: movFeijaoId, item_id: itemFeijaoId, type: 'entrada', qty: 5, unidade: 'kg', who_id: seed.ids.adminId, who_name: 'Diretora Admin', fornecedor: 'Fornecedor Y', motivo: '', nota: '', at: new Date().toISOString(), estornado: false, estornado_por: null, estornado_por_nome: null, estornado_em: null, sincronizado_planilha_em: null },
    ];
    return { seed, movArrozPendenteId, movFeijaoId };
  }

  /* ---- Cenário 2: sem sessão / usuário padrão bloqueados ---- */
  {
    const { seed } = montarSeedSync();
    const page = await abrirSyncPlanilha(browser, seed);
    await page.evaluate(async () => { await window.__iniciarSyncPlanilha__(); });
    await page.waitForTimeout(150);
    check('Sem sessão: pede pra entrar no app', (await page.locator('a[href="index.html"]').count()) >= 1);
    await page.close();
  }
  {
    const { seed } = montarSeedSync();
    const page = await abrirSyncPlanilha(browser, seed);
    await page.evaluate(async () => {
      await window.__DESPENSA_TEST_CLIENT__.auth.signInWithPassword({ email: 'limp@escola.com', password: 'senha123' });
      await window.__iniciarSyncPlanilha__();
    });
    await page.waitForTimeout(150);
    check('Usuário padrão: mensagem de "só administradores"', (await page.locator('text=Só administradores').count()) === 1);

    const erroRls = await page.evaluate(async () => {
      const r = await window.__DESPENSA_TEST_CLIENT__.rpc('marcar_movimentos_sincronizados', { p_ids: [] });
      return r.error ? r.error.message : null;
    });
    check('RLS: usuário padrão não consegue chamar marcar_movimentos_sincronizados', /administrador/.test(erroRls || ''));
    await page.close();
  }

  /* ---- Cenário 3: admin — pendências, alerta e sucesso ---- */
  {
    const { seed, movArrozPendenteId, movFeijaoId } = montarSeedSync();
    const page = await abrirSyncPlanilha(browser, seed);
    await page.evaluate(async () => {
      await window.__DESPENSA_TEST_CLIENT__.auth.signInWithPassword({ email: 'admin@escola.com', password: 'senha123' });
      await window.__iniciarSyncPlanilha__();
    });
    await page.waitForTimeout(200);

    check('Mostra o item mapeado como pendente (Arroz)', (await page.locator('.item-pendente:has-text("Arroz")').count()) === 1);
    check('Mostra a quantidade pendente certa (20, não conta a já sincronizada)', /\+20/.test(await page.locator('.item-pendente:has-text("Arroz")').textContent()));
    check('Avisa sobre item de Cozinha sem mapeamento (Feijão)', /Feijão/.test(await page.locator('.warn-box').textContent()));
    check('Mostra a última sincronização (não "nunca")', !(/nunca/i.test(await page.locator('#conteudo').textContent())));

    // Primeira tentativa: planilha do mês ainda não existe.
    await page.evaluate(() => {
      window.__DESPENSA_TEST_CLIENT__.__setFunctionMock('sync-planilha', function () {
        return { data: { ok: false, naoEncontrado: true, procurou: { pastaRaiz: 'Mapa de Merenda', pastaAno: '2026', pastaMes: '08- Agosto', arquivo: '08 - Agosto_2026.xlsx' }, erro: 'A pasta do mês ainda não foi criada.' }, error: null };
      });
    });
    await page.locator('#btn-sincronizar').click();
    await page.waitForSelector('text=Planilha do mês ainda não encontrada', { timeout: 5000 });
    check('Alerta mostra onde procurou', /08 - Agosto_2026\.xlsx/.test(await page.locator('#conteudo').textContent()));
    check('Alerta garante que nada foi perdido', /nada foi perdido|continuam guardadas/i.test(await page.locator('#conteudo').textContent()));

    // Segunda tentativa (o usuário já criou a pasta este mês): sucesso.
    await page.evaluate(() => {
      window.__DESPENSA_TEST_CLIENT__.__setFunctionMock('sync-planilha', function () {
        return { data: { ok: true, arquivo: { nome: '08 - Agosto_2026.xlsx', aba: 'MENSAL' }, linhasAtualizadas: [{ genero_planilha: 'ARROZ TIPO 1', entrada_somada: 20, saida_somada: 0, entrada_na_celula: 20, saida_na_celula: 0 }], semCorrespondencia: [] }, error: null };
      });
    });
    await page.locator('#btn-verificar-novamente').click();
    await page.waitForTimeout(400);
    check('Depois do sucesso, volta pra tela normal', (await page.locator('text=Planilha do mês ainda não encontrada').count()) === 0);
    check('Depois do sucesso, não sobra pendência do Arroz', (await page.locator('.item-pendente:has-text("Arroz")').count()) === 0);

    const db = await page.evaluate(() => window.__DESPENSA_TEST_CLIENT__._db);
    const movArroz = db.movements.find((m) => m.id === movArrozPendenteId);
    const movFeijao = db.movements.find((m) => m.id === movFeijaoId);
    check('Banco: movimentação do Arroz foi marcada como sincronizada', !!movArroz.sincronizado_planilha_em);
    check('Banco: movimentação do Feijão (sem mapa) continua pendente', !movFeijao.sincronizado_planilha_em);

    await page.close();
  }

  console.log('\n--- RESULTADO test11-sync-planilha ---');
  console.log(falhas === 0 ? 'TODOS OS CHECKS PASSARAM' : (falhas + ' CHECK(S) FALHARAM'));
  await browser.close();
  process.exit(falhas === 0 ? 0 : 1);
})();
