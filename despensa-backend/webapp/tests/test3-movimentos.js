// Teste 3: registrar entrada/saída (via RPC registrar_movimento) e
// estornar uma movimentação (via RPC estornar_movimento). Confirma que
// a quantidade do item muda corretamente e que o histórico é atualizado.
const { chromium } = require('playwright');
const { launchOptions, abrirApp, seedPadrao } = require('./helpers');

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

  const seed = seedPadrao(); // Arroz: qty=10, min=5 (cozinha)
  const page = await abrirApp(browser, seed);
  await page.waitForSelector('.auth-box');
  await page.fill('[data-field="auth-email"]', 'coz@escola.com');
  await page.fill('[data-field="auth-senha"]', 'senha123');
  await page.locator('[data-action="fazer-login"]').click();
  await page.waitForSelector('.item-card', { timeout: 5000 });

  // Registrar ENTRADA de 5kg de Arroz.
  await page.locator('[data-action="set-tab"][data-tab="entrada"]').click();
  await selecionarItemPorNome(page, 'Arroz');
  await page.fill('[data-field="form-qty"]', '5');
  await page.fill('[data-field="form-fornecedor"]', 'Distribuidora ABC');
  await page.locator('[data-action="confirmar-mov"]').click();
  await page.waitForTimeout(400);
  await page.locator('[data-action="set-tab"][data-tab="estoque"]').click();
  const qtyDepoisEntrada = (await page.locator('.item-qty b').first().textContent()).trim();
  check('Entrada de 5kg soma: 10 + 5 = 15', qtyDepoisEntrada.replace(',', '.') === '15');

  // Registrar SAÍDA de 3kg de Arroz.
  await page.locator('[data-action="set-tab"][data-tab="saida"]').click();
  await selecionarItemPorNome(page, 'Arroz');
  await page.fill('[data-field="form-qty"]', '3');
  await page.locator('[data-action="confirmar-mov"]').click();
  await page.waitForTimeout(400);
  await page.locator('[data-action="set-tab"][data-tab="estoque"]').click();
  const qtyDepoisSaida = (await page.locator('.item-qty b').first().textContent()).trim();
  check('Saída de 3kg subtrai: 15 - 3 = 12', qtyDepoisSaida.replace(',', '.') === '12');

  // Histórico mostra as duas movimentações.
  await page.locator('[data-action="set-tab"][data-tab="historico"]').click();
  await page.waitForSelector('.hist-row', { timeout: 5000 });
  const linhasHist = await page.locator('.hist-row').count();
  check('Histórico tem 2 movimentações registradas', linhasHist === 2);

  // Estornar a saída (deve devolver os 3kg). O botão "Desfazer" só aparece
  // na lista de "Últimas registradas" da própria aba Saída, não no Histórico geral.
  await page.locator('[data-action="set-tab"][data-tab="saida"]').click();
  await page.waitForSelector('[data-action="estornar-mov"]', { timeout: 5000 });
  await page.locator('[data-action="estornar-mov"]').first().click();
  await page.waitForTimeout(400);
  await page.locator('[data-action="set-tab"][data-tab="estoque"]').click();
  const qtyDepoisEstorno = (await page.locator('.item-qty b').first().textContent()).trim();
  check('Estorno da saída devolve: 12 + 3 = 15', qtyDepoisEstorno.replace(',', '.') === '15');

  // Quantidade não fica negativa: tenta uma saída maior que o estoque atual.
  await page.locator('[data-action="set-tab"][data-tab="saida"]').click();
  await selecionarItemPorNome(page, 'Arroz');
  await page.fill('[data-field="form-qty"]', '999');
  await page.locator('[data-action="confirmar-mov"]').click();
  await page.waitForTimeout(400);
  await page.locator('[data-action="set-tab"][data-tab="estoque"]').click();
  const qtyDepoisSaidaGrande = (await page.locator('.item-qty b').first().textContent()).trim();
  check('Saída maior que o estoque nunca deixa a quantidade negativa (chão em 0)', qtyDepoisSaidaGrande.replace(',', '.') === '0');

  await page.close();
  await browser.close();

  console.log('\n--- RESULTADO test3-movimentos ---');
  console.log(falhas === 0 ? 'TODOS OS CHECKS PASSARAM' : falhas + ' CHECK(S) FALHARAM');
  process.exit(falhas === 0 ? 0 : 1);
})().catch((e) => { console.error('FALHA NO TESTE:', e); process.exit(1); });
