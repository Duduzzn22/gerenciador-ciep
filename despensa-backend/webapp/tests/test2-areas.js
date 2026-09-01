// Teste 2: visibilidade por área. Confirma que "padrão" só vê os itens
// da própria área (equivalente ao que a policy items_select_por_area
// faz no Postgres de verdade), e que admin vê tudo.
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

  // Merendeira (cozinha) só vê "Arroz", não vê "Detergente".
  const page1 = await abrirApp(browser, seed);
  await page1.waitForSelector('.auth-box');
  await page1.fill('[data-field="auth-email"]', 'coz@escola.com');
  await page1.fill('[data-field="auth-senha"]', 'senha123');
  await page1.locator('[data-action="fazer-login"]').click();
  await page1.waitForSelector('.item-card', { timeout: 5000 });
  const nomesCoz = await page1.locator('.item-name').allTextContents();
  check('Usuária de cozinha vê "Arroz"', nomesCoz.includes('Arroz'));
  check('Usuária de cozinha NÃO vê "Detergente"', !nomesCoz.includes('Detergente'));
  check('Usuária de cozinha não vê aba Cadastro (não é admin)', await page1.locator('[data-action="set-tab"][data-tab="cadastro"]').count() === 0);
  await page1.close();

  // Zeladora (limpeza) só vê "Detergente".
  const page2 = await abrirApp(browser, seed);
  await page2.waitForSelector('.auth-box');
  await page2.fill('[data-field="auth-email"]', 'limp@escola.com');
  await page2.fill('[data-field="auth-senha"]', 'senha123');
  await page2.locator('[data-action="fazer-login"]').click();
  await page2.waitForSelector('.item-card', { timeout: 5000 });
  const nomesLimp = await page2.locator('.item-name').allTextContents();
  check('Usuária de limpeza vê "Detergente"', nomesLimp.includes('Detergente'));
  check('Usuária de limpeza NÃO vê "Arroz"', !nomesLimp.includes('Arroz'));
  await page2.close();

  // Admin vê os dois.
  const page3 = await abrirApp(browser, seed);
  await page3.waitForSelector('.auth-box');
  await page3.fill('[data-field="auth-email"]', 'admin@escola.com');
  await page3.fill('[data-field="auth-senha"]', 'senha123');
  await page3.locator('[data-action="fazer-login"]').click();
  await page3.waitForSelector('.item-card', { timeout: 5000 });
  const nomesAdmin = await page3.locator('.item-name').allTextContents();
  check('Admin vê "Arroz" e "Detergente"', nomesAdmin.includes('Arroz') && nomesAdmin.includes('Detergente'));
  check('Admin vê aba Cadastro', await page3.locator('[data-action="set-tab"][data-tab="cadastro"]').count() === 1);
  await page3.close();

  await browser.close();

  console.log('\n--- RESULTADO test2-areas ---');
  console.log(falhas === 0 ? 'TODOS OS CHECKS PASSARAM' : falhas + ' CHECK(S) FALHARAM');
  process.exit(falhas === 0 ? 0 : 1);
})().catch((e) => { console.error('FALHA NO TESTE:', e); process.exit(1); });
