// Teste 1: login/cadastro reais via Supabase (mock). Confirma que a
// primeira pessoa a criar conta vira admin automaticamente, e as
// próximas entram como "padrão" — exatamente como está documentado
// na tela de criar conta e no schema.sql (handle_new_user()).
const { chromium } = require('playwright');
const { launchOptions, abrirApp } = require('./helpers');

(async () => {
  const browser = await chromium.launch(launchOptions());
  let falhas = 0;
  function check(desc, cond) {
    console.log((cond ? 'OK  ' : 'FALHOU  ') + desc);
    if (!cond) falhas++;
  }

  const page = await abrirApp(browser, {}); // banco vazio: ninguém cadastrado ainda
  await page.waitForSelector('.auth-box');
  check('Tela de login aparece quando não há sessão', await page.locator('.auth-box').count() === 1);
  check('Aba "Entrar" ativa por padrão', (await page.locator('[data-action="auth-tab"][data-tab="entrar"]').getAttribute('aria-pressed')) === 'true');

  // Vai para "Criar conta" e cadastra a primeira pessoa.
  await page.locator('[data-action="auth-tab"][data-tab="criar"]').click();
  await page.fill('[data-field="auth-nome"]', 'Diretora Admin');
  await page.fill('[data-field="auth-email"]', 'admin@escola.com');
  await page.fill('[data-field="auth-senha"]', 'senha123');
  await page.fill('[data-field="auth-senha2"]', 'senha123');
  await page.locator('[data-action="criar-conta"]').click();
  await page.waitForSelector('.tabbar', { timeout: 5000 });
  check('Primeira pessoa entra direto (sessão criada)', await page.locator('.tabbar').count() === 1);
  check('Primeira pessoa vira admin (vê aba Cadastro)', await page.locator('[data-action="set-tab"][data-tab="cadastro"]').count() === 1);

  // Sai e cadastra uma segunda pessoa.
  await page.locator('[data-action="abrir-conta"]').click();
  await page.locator('[data-action="sair"]').click();
  await page.waitForSelector('.auth-box');
  await page.locator('[data-action="auth-tab"][data-tab="criar"]').click();
  await page.fill('[data-field="auth-nome"]', 'Merendeira Ana');
  await page.fill('[data-field="auth-email"]', 'ana@escola.com');
  await page.fill('[data-field="auth-senha"]', 'senha123');
  await page.fill('[data-field="auth-senha2"]', 'senha123');
  await page.selectOption('[data-field="auth-area"]', 'cozinha');
  await page.locator('[data-action="criar-conta"]').click();
  await page.waitForSelector('.tabbar', { timeout: 5000 });
  check('Segunda pessoa NÃO vira admin (não vê aba Cadastro)', await page.locator('[data-action="set-tab"][data-tab="cadastro"]').count() === 0);

  // Confere senhas divergentes são bloqueadas antes de chamar o backend.
  await page.locator('[data-action="abrir-conta"]').click();
  await page.locator('[data-action="sair"]').click();
  await page.waitForSelector('.auth-box');
  await page.locator('[data-action="auth-tab"][data-tab="criar"]').click();
  await page.fill('[data-field="auth-nome"]', 'Fulano');
  await page.fill('[data-field="auth-email"]', 'fulano@escola.com');
  await page.fill('[data-field="auth-senha"]', 'senha123');
  await page.fill('[data-field="auth-senha2"]', 'outrasenha');
  await page.locator('[data-action="criar-conta"]').click();
  await page.waitForTimeout(150);
  check('Senhas diferentes bloqueiam o cadastro com erro', await page.locator('.auth-error', { hasText: 'senhas não são iguais' }).count() === 1);

  // Login errado.
  await page.locator('[data-action="auth-tab"][data-tab="entrar"]').click();
  await page.fill('[data-field="auth-email"]', 'admin@escola.com');
  await page.fill('[data-field="auth-senha"]', 'senhaerrada');
  await page.locator('[data-action="fazer-login"]').click();
  await page.waitForTimeout(150);
  check('Senha incorreta mostra erro traduzido', await page.locator('.auth-error', { hasText: 'incorretos' }).count() === 1);

  // Login certo do admin funciona de novo (persistência entre sessões).
  await page.fill('[data-field="auth-senha"]', 'senha123');
  await page.locator('[data-action="fazer-login"]').click();
  await page.waitForSelector('.tabbar', { timeout: 5000 });
  check('Admin consegue entrar de novo com a senha certa', await page.locator('[data-action="set-tab"][data-tab="cadastro"]').count() === 1);

  await page.close();
  await browser.close();

  console.log('\n--- RESULTADO test1-auth ---');
  console.log(falhas === 0 ? 'TODOS OS CHECKS PASSARAM' : falhas + ' CHECK(S) FALHARAM');
  process.exit(falhas === 0 ? 0 : 1);
})().catch((e) => { console.error('FALHA NO TESTE:', e); process.exit(1); });
