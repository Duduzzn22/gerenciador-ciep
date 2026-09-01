// Script avulso (não faz parte da suíte de testes) só pra tirar screenshots
// e confirmar visualmente que o layout de desktop (Tarefa #29) não quebrou
// nada no celular e ficou aproveitando bem o espaço em telas largas.
const { chromium } = require('playwright');
const path = require('path');
const { launchOptions, abrirApp, seedPadrao, uid } = require('./helpers');

(async () => {
  const browser = await chromium.launch(launchOptions());

  // Seed com mais itens pra dar pra ver o grid de verdade.
  const seed = seedPadrao();
  const extraCatId = uid();
  seed.categories.push({ id: extraCatId, nome: 'Higiene', area: 'cozinha', created_at: new Date().toISOString() });
  for (let i = 1; i <= 6; i++) {
    seed.items.push({ id: uid(), name: 'Item extra ' + i, category_id: seed.ids.catCozId, unit: 'un', qty: i, min: 3, criado_por: 'Diretora Admin', criado_em: new Date().toISOString(), ajustado_por: null, ajustado_em: null });
  }

  const page = await abrirApp(browser, seed);
  await page.waitForSelector('.auth-box');
  await page.fill('[data-field="auth-email"]', 'admin@escola.com');
  await page.fill('[data-field="auth-senha"]', 'senha123');
  await page.locator('[data-action="fazer-login"]').click();
  await page.waitForSelector('.item-card', { timeout: 5000 });

  // --- MOBILE (390x844, já é o padrão do abrirApp) ---
  await page.screenshot({ path: '/tmp/screenshot-mobile-estoque.png' });
  await page.locator('[data-action="set-tab"][data-tab="entrada"]').click();
  await page.waitForTimeout(150);
  await page.screenshot({ path: '/tmp/screenshot-mobile-entrada.png' });

  // --- DESKTOP (1280x900) ---
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator('[data-action="set-tab"][data-tab="estoque"]').click();
  await page.waitForTimeout(150);
  await page.screenshot({ path: '/tmp/screenshot-desktop-estoque.png' });

  await page.locator('[data-action="set-tab"][data-tab="entrada"]').click();
  await page.waitForTimeout(150);
  await page.screenshot({ path: '/tmp/screenshot-desktop-entrada.png' });

  await page.locator('[data-action="set-tab"][data-tab="cadastro"]').click();
  await page.locator('[data-action="set-cadastro-sub"][data-sub="resumo"]').click();
  await page.waitForTimeout(150);
  await page.screenshot({ path: '/tmp/screenshot-desktop-resumo.png' });

  console.log('erros de página:', page.__errors);
  await browser.close();
})();
