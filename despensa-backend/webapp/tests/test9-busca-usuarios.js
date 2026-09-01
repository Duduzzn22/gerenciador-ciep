// Teste 9: busca em Cadastro > Usuários (Tarefa #26).
const { chromium } = require('playwright');
const { launchOptions, abrirApp, seedPadrao, uid } = require('./helpers');

(async () => {
  const browser = await chromium.launch(launchOptions());
  let falhas = 0;
  function check(desc, cond) {
    console.log((cond ? 'OK  ' : 'FALHOU  ') + desc);
    if (!cond) falhas++;
  }

  const seed = seedPadrao();
  // Adiciona mais gente pra passar do limiar de 5 que faz a busca aparecer.
  for (let i = 1; i <= 4; i++) {
    seed.users.push({ id: uid(), email: 'extra' + i + '@escola.com', password: 'senha123', user_metadata: { name: 'Pessoa Extra ' + i } });
    seed.profiles.push({ id: seed.users[seed.users.length - 1].id, name: 'Pessoa Extra ' + i, role: 'padrao', area: 'cozinha', created_at: new Date().toISOString() });
  }

  const page = await abrirApp(browser, seed);
  await page.waitForSelector('.auth-box');
  await page.fill('[data-field="auth-email"]', 'admin@escola.com');
  await page.fill('[data-field="auth-senha"]', 'senha123');
  await page.locator('[data-action="fazer-login"]').click();
  await page.waitForSelector('.item-card', { timeout: 5000 });

  await page.locator('[data-action="set-tab"][data-tab="cadastro"]').click();
  await page.locator('[data-action="set-cadastro-sub"][data-sub="usuarios"]').click();
  await page.waitForTimeout(200);

  check('Campo de busca aparece quando há mais de 5 pessoas', (await page.locator('[data-field="user-search"]').count()) === 1);
  const totalAntes = await page.locator('.profile-list .cad-row').count();
  check('Lista mostra todas as 7 pessoas sem filtro', totalAntes === 7);

  await page.fill('[data-field="user-search"]', 'extra 2');
  await page.waitForTimeout(250);
  const totalDepois = await page.locator('.profile-list .cad-row').count();
  check('Busca "extra 2" filtra pra 1 pessoa só', totalDepois === 1);
  check('A pessoa filtrada é a certa', (await page.locator('.profile-list').textContent()).indexOf('Pessoa Extra 2') !== -1);

  await page.fill('[data-field="user-search"]', 'ninguemcomessenome');
  await page.waitForTimeout(250);
  check('Busca sem resultado mostra aviso', (await page.locator('.empty-note').count()) === 1);

  console.log('\n--- RESULTADO test9-busca-usuarios ---');
  console.log(falhas === 0 ? 'TODOS OS CHECKS PASSARAM' : (falhas + ' CHECK(S) FALHARAM'));
  await browser.close();
  process.exit(falhas === 0 ? 0 : 1);
})();
