// Teste 13: aba Relatórios. Valida filtros por área/mês/ano usando as
// movimentações já carregadas e respeitando as permissões simuladas pelo mock.
const { chromium } = require('playwright');
const { launchOptions, abrirApp, seedPadrao, uid } = require('./helpers');

function movimento(base) {
  return Object.assign({
    id: uid(),
    qty: 1,
    unidade: 'un',
    who_name: 'Diretora Admin',
    who_id: null,
    fornecedor: '',
    motivo: '',
    nota: '',
    estornado: false,
    estornado_por_nome: null,
    estornado_em: null,
  }, base);
}

function seedRelatorios() {
  const seed = seedPadrao();
  seed.movements = [
    movimento({ item_id: seed.ids.itemCozId, type: 'entrada', qty: 5, unidade: 'kg', fornecedor: 'Fornecedor Setembro', at: '2026-09-12T12:00:00.000Z' }),
    movimento({ item_id: seed.ids.itemLimpId, type: 'saida', qty: 2, unidade: 'un', motivo: 'Limpeza setembro', at: '2026-09-10T12:00:00.000Z' }),
    movimento({ item_id: seed.ids.itemCozId, type: 'entrada', qty: 3, unidade: 'kg', fornecedor: 'Fornecedor Agosto', at: '2026-08-05T12:00:00.000Z' }),
  ];
  return seed;
}

async function login(page, email) {
  await page.waitForSelector('.auth-box');
  await page.fill('[data-field="auth-email"]', email);
  await page.fill('[data-field="auth-senha"]', 'senha123');
  await page.locator('[data-action="fazer-login"]').click();
  await page.waitForSelector('.item-card', { timeout: 5000 });
}

async function abrirRelatorios(page) {
  await page.locator('[data-action="set-tab"][data-tab="relatorios"]').click();
  await page.waitForSelector('text=Relatórios de movimentações', { timeout: 5000 });
}

async function textoRelatorio(page) {
  return page.locator('.content').textContent();
}

(async () => {
  const browser = await chromium.launch(launchOptions());
  let falhas = 0;
  function check(desc, cond) {
    console.log((cond ? 'OK  ' : 'FALHOU  ') + desc);
    if (!cond) falhas++;
  }

  const seed = seedRelatorios();

  const admin = await abrirApp(browser, seed);
  await login(admin, 'admin@escola.com');
  check('Aba Relatórios existe', await admin.locator('[data-action="set-tab"][data-tab="relatorios"]').count() === 1);
  await abrirRelatorios(admin);
  const optsAdmin = await admin.locator('[data-field="rel-area"] option').allTextContents();
  check('Admin vê Todas/Cozinha/Limpeza', optsAdmin.includes('Todas') && optsAdmin.includes('Cozinha') && optsAdmin.includes('Limpeza'));

  await admin.selectOption('[data-field="rel-mes"]', '9');
  await admin.selectOption('[data-field="rel-ano"]', '2026');
  await admin.selectOption('[data-field="rel-area"]', 'cozinha');
  let txt = await textoRelatorio(admin);
  check('Filtro por mês mostra Setembro e esconde Agosto', txt.includes('Fornecedor Setembro') && !txt.includes('Fornecedor Agosto'));
  check('Filtro por área Cozinha esconde Limpeza', txt.includes('Arroz') && !txt.includes('Detergente'));
  check('Combinação área + mês retorna 1 movimentação', txt.includes('1 movimentação encontrada'));

  await admin.selectOption('[data-field="rel-area"]', 'limpeza');
  txt = await textoRelatorio(admin);
  check('Trocar para Limpeza muda os resultados', txt.includes('Detergente') && txt.includes('Limpeza setembro') && !txt.includes('Arroz'));

  await admin.selectOption('[data-field="rel-mes"]', '7');
  txt = await textoRelatorio(admin);
  check('Estado vazio aparece sem registros no período', txt.includes('Não há movimentações para os filtros selecionados.'));

  await admin.locator('[data-action="set-tab"][data-tab="historico"]').click();
  await admin.waitForSelector('text=Histórico de movimentações', { timeout: 5000 });
  check('Histórico original continua funcionando', await admin.locator('.hist-row').count() === 3);
  await admin.close();

  const coz = await abrirApp(browser, seed);
  await login(coz, 'coz@escola.com');
  await abrirRelatorios(coz);
  const optsCoz = await coz.locator('[data-field="rel-area"] option').allTextContents();
  await coz.selectOption('[data-field="rel-mes"]', '9');
  await coz.selectOption('[data-field="rel-ano"]', '2026');
  txt = await textoRelatorio(coz);
  check('Usuário Cozinha não consegue consultar Limpeza', optsCoz.includes('Cozinha') && !optsCoz.includes('Limpeza') && txt.includes('Arroz') && !txt.includes('Detergente'));
  await coz.close();

  const limp = await abrirApp(browser, seed);
  await login(limp, 'limp@escola.com');
  await abrirRelatorios(limp);
  const optsLimp = await limp.locator('[data-field="rel-area"] option').allTextContents();
  await limp.selectOption('[data-field="rel-mes"]', '9');
  await limp.selectOption('[data-field="rel-ano"]', '2026');
  txt = await textoRelatorio(limp);
  check('Usuário Limpeza não consegue consultar Cozinha', optsLimp.includes('Limpeza') && !optsLimp.includes('Cozinha') && txt.includes('Detergente') && !txt.includes('Arroz'));
  await limp.close();

  await browser.close();

  console.log('\n--- RESULTADO test13-relatorios ---');
  console.log(falhas === 0 ? 'TODOS OS CHECKS PASSARAM' : falhas + ' CHECK(S) FALHARAM');
  process.exit(falhas === 0 ? 0 : 1);
})().catch((e) => { console.error('FALHA NO TESTE:', e); process.exit(1); });
