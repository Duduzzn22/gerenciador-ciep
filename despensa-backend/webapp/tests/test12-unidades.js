// Teste 12: gerenciamento de Unidades pela tela Cadastro → Unidades
// (adicionar, usar no cadastro de produto, e trava de remoção quando em uso).
const { chromium } = require('playwright');
const { launchOptions, abrirApp, seedPadrao } = require('./helpers');

(async () => {
  const browser = await chromium.launch(launchOptions());
  let falhas = 0;
  function check(desc, cond) {
    console.log((cond ? 'OK  ' : 'FALHOU  ') + desc);
    if (!cond) falhas++;
  }

  const seed = seedPadrao(); // não define seed.units -> mock usa os 6 padrões (kg, L, un, pacote, cx, garrafa)
  const page = await abrirApp(browser, seed);
  await page.waitForSelector('.auth-box');
  await page.fill('[data-field="auth-email"]', 'admin@escola.com');
  await page.fill('[data-field="auth-senha"]', 'senha123');
  await page.locator('[data-action="fazer-login"]').click();
  await page.waitForSelector('.item-card', { timeout: 5000 });

  // --- Aba Unidades existe e lista as unidades padrão ---
  await page.locator('[data-action="set-tab"][data-tab="cadastro"]').click();
  await page.locator('[data-action="set-cadastro-sub"][data-sub="unidades"]').click();
  await page.waitForTimeout(200);
  check('Aba "Unidades" existe no Cadastro', (await page.locator('.section-title', { hasText: 'Unidades' }).count()) === 1);
  let listaTexto = await page.locator('.profile-list').first().textContent();
  check('Lista de unidades mostra as 6 unidades padrão', ['kg', 'L', 'un', 'pacote', 'cx', 'garrafa'].every(function (u) { return listaTexto.indexOf(u) !== -1; }));

  // --- Adicionar uma unidade nova ---
  await page.fill('[data-field="un-nova"]', 'fardo');
  await page.locator('[data-action="adicionar-unidade"]').click();
  await page.waitForTimeout(400);
  listaTexto = await page.locator('.profile-list').first().textContent();
  check('Unidade nova ("fardo") aparece na lista depois de adicionada', listaTexto.indexOf('fardo') !== -1);

  // --- Unidade nova aparece no formulário de cadastrar produto ---
  await page.locator('[data-action="set-cadastro-sub"][data-sub="produtos"]').click();
  await page.locator('[data-action="novo-item"]').click();
  await page.waitForSelector('[data-field="ni-un"]');
  const opcoesUnidade = await page.locator('[data-field="ni-un"] option').allTextContents();
  check('Unidade nova aparece no seletor de "Cadastrar produto"', opcoesUnidade.indexOf('fardo') !== -1);
  await page.locator('button[data-action="close-modal"]').click();

  // --- Não deixa remover unidade em uso (kg é usado pelo Arroz do seed) ---
  await page.locator('[data-action="set-cadastro-sub"][data-sub="unidades"]').click();
  await page.waitForTimeout(200);
  const linhaKg = page.locator('.categoria-row', { hasText: 'kg' }).first();
  const botaoRemoverKg = linhaKg.locator('[data-action="remover-unidade"]');
  check('Botão de remover fica desabilitado para unidade em uso (kg)', await botaoRemoverKg.isDisabled());

  // --- Remove a unidade nova (sem uso) com sucesso ---
  const linhaFardo = page.locator('.categoria-row', { hasText: 'fardo' }).first();
  await linhaFardo.locator('[data-action="remover-unidade"]').click();
  await page.waitForTimeout(400);
  listaTexto = await page.locator('.profile-list').first().textContent();
  check('Unidade sem uso é removida com sucesso', listaTexto.indexOf('fardo') === -1);

  console.log('\n--- RESULTADO test12-unidades ---');
  console.log(falhas === 0 ? 'TODOS OS CHECKS PASSARAM' : (falhas + ' CHECK(S) FALHARAM'));
  await browser.close();
  process.exit(falhas === 0 ? 0 : 1);
})();
