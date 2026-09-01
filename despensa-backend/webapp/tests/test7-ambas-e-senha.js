// Teste 7: área "Ambas" (Tarefa #22) e recuperação de senha (Tarefa #20).
const { chromium } = require('playwright');
const { launchOptions, abrirApp, seedPadrao, uid } = require('./helpers');

async function selecionarItemPorNome(page, nome) {
  const valor = await page.locator('[data-field="form-item"] option', { hasText: nome }).first().getAttribute('value');
  await page.selectOption('[data-field="form-item"]', valor);
}

(async () => {
  const browser = await chromium.launch(launchOptions());
  let falhas = 0;
  function check(desc, cond) {
    console.log((cond ? 'OK  ' : 'FALHOU  ') + desc);
    if (!cond) falhas++;
  }

  // --- Parte 1: pessoa padrão com área "ambas" vê e mexe nas duas áreas ---
  const seed = seedPadrao();
  const ambasId = uid();
  seed.users.push({ id: ambasId, email: 'ambas@escola.com', password: 'senha123', user_metadata: { name: 'Merendeira Ambas', area: 'cozinha' } });
  seed.profiles.push({ id: ambasId, name: 'Merendeira Ambas', role: 'padrao', area: 'ambas', created_at: new Date().toISOString() });

  const page = await abrirApp(browser, seed);
  await page.waitForSelector('.auth-box');
  await page.fill('[data-field="auth-email"]', 'ambas@escola.com');
  await page.fill('[data-field="auth-senha"]', 'senha123');
  await page.locator('[data-action="fazer-login"]').click();
  await page.waitForSelector('.item-card', { timeout: 5000 });

  const nomes = await page.locator('.item-name').allTextContents();
  check('Pessoa "ambas" vê Arroz (cozinha)', nomes.includes('Arroz'));
  check('Pessoa "ambas" vê Detergente (limpeza)', nomes.includes('Detergente'));
  check('Pessoa "ambas" vê os chips Tudo/Cozinha/Limpeza (não só a etiqueta de área)', await page.locator('[data-action="set-grupo"]').count() === 3);

  // Registra entrada em item de limpeza (não deveria ser bloqueado).
  await page.locator('[data-action="set-tab"][data-tab="entrada"]').click();
  await selecionarItemPorNome(page, 'Detergente');
  await page.fill('[data-field="form-qty"]', '2');
  await page.fill('[data-field="form-fornecedor"]', 'Fornecedor X');
  await page.locator('[data-action="confirmar-mov"]').click();
  await page.waitForTimeout(400);
  await page.locator('[data-action="set-tab"][data-tab="estoque"]').click();
  const detergenteQty = (await page.locator('.item-card', { hasText: 'Detergente' }).locator('.item-qty b').textContent()).trim();
  check('Pessoa "ambas" registra entrada em item de LIMPEZA: 3 + 2 = 5', detergenteQty.replace(',', '.') === '5');

  await browser.close();

  // --- Parte 2: fluxo "Esqueci minha senha" ---
  const browser2 = await chromium.launch(launchOptions());
  const seed2 = seedPadrao();
  const page2 = await abrirApp(browser2, seed2);
  await page2.waitForSelector('.auth-box');

  await page2.locator('[data-action="ir-recuperar"]').click();
  await page2.waitForSelector('[data-action="enviar-recuperacao"]');
  check('Tela "Recuperar senha" abre ao clicar em "Esqueci minha senha"', await page2.locator('[data-action="enviar-recuperacao"]').count() === 1);

  await page2.fill('[data-field="auth-email"]', 'coz@escola.com');
  await page2.locator('[data-action="enviar-recuperacao"]').click();
  await page2.waitForSelector('.auth-info', { timeout: 5000 });
  check('Depois de enviar, volta pra tela de login com aviso', await page2.locator('.auth-info').count() === 1);
  check('Aba "Entrar" fica ativa de novo', (await page2.locator('[data-action="auth-tab"][data-tab="entrar"]').getAttribute('aria-pressed')) === 'true');

  // Simula o clique no link do e-mail: dispara PASSWORD_RECOVERY.
  const cliente = await page2.evaluateHandle(() => window.__DESPENSA_TEST_CLIENT__);
  await page2.evaluate((c) => c.__dispararRecuperacaoSenha('coz@escola.com'), cliente);
  await page2.waitForSelector('[data-action="salvar-nova-senha"]', { timeout: 5000 });
  check('Link de recuperação leva direto pra tela "Criar nova senha"', await page2.locator('[data-action="salvar-nova-senha"]').count() === 1);

  // Senha curta é bloqueada antes de chamar o backend.
  await page2.fill('[data-field="auth-senha-nova"]', '123');
  await page2.fill('[data-field="auth-senha-nova2"]', '123');
  await page2.locator('[data-action="salvar-nova-senha"]').click();
  await page2.waitForSelector('.auth-error', { timeout: 3000 });
  check('Senha curta demais é bloqueada com aviso', (await page2.locator('.auth-error').textContent()).indexOf('6 caracteres') !== -1);

  // Senhas diferentes são bloqueadas.
  await page2.fill('[data-field="auth-senha-nova"]', 'novaSenha123');
  await page2.fill('[data-field="auth-senha-nova2"]', 'outraSenha456');
  await page2.locator('[data-action="salvar-nova-senha"]').click();
  await page2.waitForSelector('.auth-error', { timeout: 3000 });
  check('Senhas diferentes são bloqueadas com aviso', (await page2.locator('.auth-error').textContent()).indexOf('não são iguais') !== -1);

  // Senha válida: salva e entra direto no app.
  await page2.fill('[data-field="auth-senha-nova"]', 'novaSenha123');
  await page2.fill('[data-field="auth-senha-nova2"]', 'novaSenha123');
  await page2.locator('[data-action="salvar-nova-senha"]').click();
  await page2.waitForSelector('.item-card', { timeout: 5000 });
  check('Depois de salvar a nova senha, entra direto no app', await page2.locator('.item-card').count() > 0);

  // Confere que a senha realmente mudou: sai e entra de novo com a senha nova.
  await page2.locator('[data-action="abrir-conta"]').click();
  await page2.locator('[data-action="sair"]').click();
  await page2.waitForSelector('.auth-box');
  await page2.fill('[data-field="auth-email"]', 'coz@escola.com');
  await page2.fill('[data-field="auth-senha"]', 'novaSenha123');
  await page2.locator('[data-action="fazer-login"]').click();
  await page2.waitForSelector('.item-card', { timeout: 5000 });
  check('Login com a senha NOVA funciona de verdade', await page2.locator('.item-card').count() > 0);

  await browser2.close();

  console.log('\n--- RESULTADO test7-ambas-e-senha ---');
  console.log(falhas === 0 ? 'TODOS OS CHECKS PASSARAM' : (falhas + ' CHECK(S) FALHARAM'));
  process.exit(falhas === 0 ? 0 : 1);
})();
