// Teste 6: um admin remove o PRÓPRIO cadastro (com confirmação extra) e
// deve ser desconectado automaticamente e devolvido à tela de login —
// cobre o ajuste feito em carregarTudo() para ressincronizar auth.profile
// (e detectar quando o próprio perfil deixou de existir).
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
  const admin2Id = uid();
  seed.users.push({ id: admin2Id, email: 'admin2@escola.com', password: 'senha123', user_metadata: { name: 'Vice-Diretor' } });
  seed.profiles.push({ id: admin2Id, name: 'Vice-Diretor', role: 'admin', area: 'ambas', created_at: new Date().toISOString() });

  const page = await abrirApp(browser, seed);
  await page.waitForSelector('.auth-box');
  await page.fill('[data-field="auth-email"]', 'admin2@escola.com');
  await page.fill('[data-field="auth-senha"]', 'senha123');
  await page.locator('[data-action="fazer-login"]').click();
  await page.waitForSelector('.tabbar', { timeout: 5000 });

  await page.locator('[data-action="set-tab"][data-tab="cadastro"]').click();
  await page.locator('[data-action="set-cadastro-sub"][data-sub="usuarios"]').click();
  await page.waitForSelector('.profile-list .cad-row');
  const linhaPropria = page.locator('.profile-list .cad-row', { hasText: 'Vice-Diretor' });
  await linhaPropria.locator('[data-action="remover-perfil"]').click();
  await page.waitForSelector('[data-action="confirmar-remover-proprio"]', { timeout: 3000 });
  await page.locator('[data-action="confirmar-remover-proprio"]').click();
  await page.waitForSelector('.auth-box', { timeout: 5000 });
  check('Após remover a própria conta, a pessoa é desconectada e volta ao login', await page.locator('.auth-box').count() === 1);
  const restam = await page.evaluate(() => window.__DESPENSA_TEST_CLIENT__._db.profiles.length);
  check('O perfil realmente foi removido do banco', restam === 3);

  await page.close();
  await browser.close();

  console.log('\n--- RESULTADO test6-autoremocao ---');
  console.log(falhas === 0 ? 'TODOS OS CHECKS PASSARAM' : falhas + ' CHECK(S) FALHARAM');
  process.exit(falhas === 0 ? 0 : 1);
})().catch((e) => { console.error('FALHA NO TESTE:', e); process.exit(1); });
