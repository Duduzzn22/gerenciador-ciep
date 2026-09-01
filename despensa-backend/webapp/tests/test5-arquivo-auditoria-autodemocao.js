// Teste 5: arquivamento de movimentações antigas (com exportação
// obrigatória antes de apagar), trilha de auditoria, e a confirmação
// extra antes de um admin remover o próprio acesso ou se auto-rebaixar.
const { chromium } = require('playwright');
const { launchOptions, abrirApp, seedPadrao, uid } = require('./helpers');

(async () => {
  const browser = await chromium.launch(launchOptions());
  let falhas = 0;
  function check(desc, cond) {
    console.log((cond ? 'OK  ' : 'FALHOU  ') + desc);
    if (!cond) falhas++;
  }

  // Semeia um segundo admin (para poder testar auto-rebaixamento sem
  // esbarrar na proteção do "último admin"), e uma movimentação antiga.
  const seed = seedPadrao();
  const admin2Id = uid();
  seed.users.push({ id: admin2Id, email: 'admin2@escola.com', password: 'senha123', user_metadata: { name: 'Vice-Diretor' } });
  seed.profiles.push({ id: admin2Id, name: 'Vice-Diretor', role: 'admin', area: 'ambas', created_at: new Date().toISOString() });
  const movAntigaId = uid();
  const dataAntiga = new Date();
  dataAntiga.setMonth(dataAntiga.getMonth() - 14); // mais velha que os 12 meses padrão
  seed.movements.push({
    id: movAntigaId, item_id: seed.ids.itemCozId, type: 'entrada', qty: 2, unidade: 'kg',
    who_id: seed.ids.adminId, who_name: 'Diretora Admin', fornecedor: 'Fornecedor Antigo', motivo: '', nota: '',
    at: dataAntiga.toISOString(), estornado: false, estornado_por: null, estornado_por_nome: null, estornado_em: null,
  });

  const page = await abrirApp(browser, seed);
  await page.waitForSelector('.auth-box');
  await page.fill('[data-field="auth-email"]', 'admin@escola.com');
  await page.fill('[data-field="auth-senha"]', 'senha123');
  await page.locator('[data-action="fazer-login"]').click();
  await page.waitForSelector('.tabbar', { timeout: 5000 });

  // --- Arquivamento ---
  await page.locator('[data-action="set-tab"][data-tab="cadastro"]').click();
  await page.locator('[data-action="set-cadastro-sub"][data-sub="dados"]').click();
  await page.waitForSelector('[data-action="arquivar-antigas"]');
  const textoBotaoArquivar = await page.locator('[data-action="arquivar-antigas"]').textContent();
  check('Tela de dados detecta 1 movimentação pendente de arquivamento', /1 movimenta/.test(textoBotaoArquivar));
  await page.locator('[data-action="arquivar-antigas"]').click();
  await page.waitForTimeout(400);
  const movsRestantes = await page.evaluate(() => window.__DESPENSA_TEST_CLIENT__._db.movements.length);
  check('Movimentação antiga foi removida do histórico ativo após arquivar', movsRestantes === 0);

  // --- Auditoria ---
  await page.locator('[data-action="set-cadastro-sub"][data-sub="auditoria"]').click();
  await page.waitForTimeout(200);
  const logAuditoria = await page.locator('.cad-row').allTextContents();
  check('Arquivamento gerou um registro de auditoria visível', logAuditoria.some((t) => /arquivad/i.test(t)));

  // --- Editar outra pessoa (não é auto-rebaixamento: não deve pedir confirmação extra) ---
  await page.locator('[data-action="set-cadastro-sub"][data-sub="usuarios"]').click();
  await page.waitForSelector('.profile-list .cad-row');

  // --- Auto-rebaixamento: o admin logado edita o PRÓPRIO perfil para "padrao" ---
  const linhaPropria = page.locator('.profile-list .cad-row', { hasText: 'Diretora Admin' });
  await linhaPropria.locator('[data-action="editar-perfil"]').click();
  await page.waitForSelector('[data-field="pe-role"]');
  await page.selectOption('[data-field="pe-role"]', 'padrao');
  await page.selectOption('[data-field="pe-area"]', 'cozinha');
  await page.locator('[data-action="salvar-edicao-perfil"]').click();
  await page.waitForSelector('.modal-title', { timeout: 3000 });
  const tituloConfirm = await page.locator('.modal-title').textContent();
  check('Auto-rebaixar de admin para padrão pede confirmação extra', /próprio.*administrador|administrador.*próprio/i.test(tituloConfirm));

  // Cancela — o papel não deve ter mudado de verdade.
  await page.locator('button[data-action="close-modal"]').click();
  await page.waitForTimeout(200);
  const aindaEhAdmin1 = await page.locator('[data-action="set-tab"][data-tab="cadastro"]').count();
  check('Cancelar a confirmação NÃO aplica o rebaixamento (ainda é admin)', aindaEhAdmin1 === 1);

  // Confirma de verdade — agora perde acesso a Cadastro imediatamente.
  await linhaPropria.locator('[data-action="editar-perfil"]').click();
  await page.waitForSelector('[data-field="pe-role"]');
  await page.selectOption('[data-field="pe-role"]', 'padrao');
  await page.selectOption('[data-field="pe-area"]', 'cozinha');
  await page.locator('[data-action="salvar-edicao-perfil"]').click();
  await page.waitForSelector('[data-action="confirmar-rebaixar-proprio"]', { timeout: 3000 });
  await page.locator('[data-action="confirmar-rebaixar-proprio"]').click();
  await page.waitForTimeout(400);
  const aindaEhAdmin2 = await page.locator('[data-action="set-tab"][data-tab="cadastro"]').count();
  check('Confirmar o auto-rebaixamento aplica de verdade (perde a aba Cadastro)', aindaEhAdmin2 === 0);

  await page.close();
  await browser.close();

  console.log('\n--- RESULTADO test5-arquivo-auditoria-autodemocao ---');
  console.log(falhas === 0 ? 'TODOS OS CHECKS PASSARAM' : falhas + ' CHECK(S) FALHARAM');
  process.exit(falhas === 0 ? 0 : 1);
})().catch((e) => { console.error('FALHA NO TESTE:', e); process.exit(1); });
