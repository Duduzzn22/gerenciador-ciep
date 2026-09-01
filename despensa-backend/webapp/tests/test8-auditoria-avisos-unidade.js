// Teste 8: auditoria de produto/ajuste (Tarefas #18/#19), tradução de erros
// (Tarefa #21), aviso de nome duplicado (Tarefa #25) e trava de unidade de
// medida (Tarefa #23).
const { chromium } = require('playwright');
const { launchOptions, abrirApp, seedPadrao } = require('./helpers');

(async () => {
  const browser = await chromium.launch(launchOptions());
  let falhas = 0;
  function check(desc, cond) {
    console.log((cond ? 'OK  ' : 'FALHOU  ') + desc);
    if (!cond) falhas++;
  }

  const seed = seedPadrao();
  const page = await abrirApp(browser, seed);
  await page.waitForSelector('.auth-box');
  await page.fill('[data-field="auth-email"]', 'admin@escola.com');
  await page.fill('[data-field="auth-senha"]', 'senha123');
  await page.locator('[data-action="fazer-login"]').click();
  await page.waitForSelector('.item-card', { timeout: 5000 });

  // --- Cadastrar produto novo: deve gerar entrada de auditoria ---
  await page.locator('[data-action="set-tab"][data-tab="cadastro"]').click();
  await page.locator('[data-action="novo-item"]').click();
  await page.fill('[data-field="ni-nome"]', 'Feijão');
  await page.selectOption('[data-field="ni-cat"]', { label: 'Grãos e Cereais' });
  await page.fill('[data-field="ni-qty"]', '8');
  await page.fill('[data-field="ni-min"]', '2');
  await page.locator('[data-action="salvar-novo-item"]').click();
  await page.waitForTimeout(400);

  await page.locator('[data-action="set-tab"][data-tab="cadastro"]').click();
  await page.locator('[data-action="set-cadastro-sub"][data-sub="auditoria"]').click();
  await page.waitForTimeout(200);
  let logTexts = await page.locator('.profile-list').first().textContent();
  check('Cadastrar produto gera registro de auditoria', logTexts.indexOf('cadastrou o produto "Feijão"') !== -1);

  // --- Ajustar quantidade/mínimo: deve gerar entrada de auditoria ---
  await page.locator('[data-action="set-cadastro-sub"][data-sub="produtos"]').click();
  await page.locator('[data-action="set-tab"][data-tab="estoque"]').click();
  await page.locator('.item-card', { hasText: 'Feijão' }).locator('[data-action="ajustar-item"]').click();
  await page.waitForSelector('[data-action="salvar-ajuste"]');
  await page.fill('[data-field="aj-qty"]', '20');
  await page.locator('[data-action="salvar-ajuste"]').click();
  await page.waitForTimeout(400);

  await page.locator('[data-action="set-tab"][data-tab="cadastro"]').click();
  await page.locator('[data-action="set-cadastro-sub"][data-sub="auditoria"]').click();
  await page.waitForTimeout(200);
  logTexts = await page.locator('.profile-list').first().textContent();
  check('Ajuste manual de quantidade gera registro de auditoria', logTexts.indexOf('corrigiu "Feijão"') !== -1 && logTexts.indexOf('quantidade de 8') !== -1);

  // --- Painel Resumo mostra a atividade (confirma task #27 também está ok) ---
  await page.locator('[data-action="set-cadastro-sub"][data-sub="resumo"]').click();
  await page.waitForTimeout(200);
  check('Painel Resumo existe e mostra "Resumo geral"', (await page.locator('.section-title', { hasText: 'Resumo geral' }).count()) === 1);

  // --- Remover produto: deve gerar auditoria e NÃO travar por causa da
  // constraint antiga de "tipo" (valida que o mock replica o fix do
  // schema.sql) ---
  await page.locator('[data-action="set-cadastro-sub"][data-sub="produtos"]').click();
  await page.locator('[data-action="set-tab"][data-tab="estoque"]').click();
  await page.locator('.item-card', { hasText: 'Feijão' }).locator('[data-action="ajustar-item"]').click();
  await page.waitForSelector('[data-action="remover-item"]');
  await page.locator('[data-action="remover-item"]').click();
  await page.waitForTimeout(400);
  check('Item removido com sucesso (sem erro de constraint)', (await page.locator('.item-card', { hasText: 'Feijão' }).count()) === 0);

  // --- Aviso de nome duplicado ---
  await page.locator('[data-action="set-tab"][data-tab="cadastro"]').click();
  await page.locator('[data-action="novo-item"]').click();
  await page.fill('[data-field="ni-nome"]', 'arroz'); // minúsculo, mesmo item que já existe
  await page.selectOption('[data-field="ni-cat"]', { label: 'Grãos e Cereais' });
  await page.locator('[data-action="salvar-novo-item"]').click();
  await page.waitForSelector('[data-action="confirmar-duplicado-cadastrar"]', { timeout: 3000 });
  check('Nome parecido/duplicado mostra aviso de confirmação', (await page.locator('[data-action="confirmar-duplicado-cadastrar"]').count()) === 1);
  await page.locator('[data-action="confirmar-duplicado-cadastrar"]').click();
  await page.waitForTimeout(400);
  await page.locator('[data-action="set-tab"][data-tab="estoque"]').click();
  const qtdArroz = await page.locator('.item-name', { hasText: /^arroz$/i }).count();
  check('Confirmando mesmo assim, cadastra os dois itens separados', qtdArroz === 2);

  // --- Unidade travada na tela de Entrada (não é mais um <select>) ---
  await page.locator('[data-action="set-tab"][data-tab="entrada"]').click();
  const temSelectUnidade = await page.locator('[data-field="form-unidade"]').count();
  check('Campo de unidade NÃO é mais editável em Entrada/Saída', temSelectUnidade === 0);

  // --- Unidade só editável via Ajustar, e só para admin ---
  await page.locator('[data-action="set-tab"][data-tab="estoque"]').click();
  await page.locator('.item-card', { hasText: 'Arroz' }).first().locator('[data-action="ajustar-item"]').click();
  await page.waitForSelector('[data-action="salvar-ajuste"]');
  check('Admin vê seletor de unidade na tela de Ajustar', (await page.locator('[data-field="aj-un"]').count()) === 1);
  await page.locator('button[data-action="close-modal"]').click();

  console.log('\n--- RESULTADO test8-auditoria-avisos-unidade ---');
  console.log(falhas === 0 ? 'TODOS OS CHECKS PASSARAM' : (falhas + ' CHECK(S) FALHARAM'));
  await browser.close();
  process.exit(falhas === 0 ? 0 : 1);
})();
