// Teste 14: garante que "Descartável" e "Descartáveis" não aparecem como
// duas categorias separadas no app, sem perder produtos, histórico ou relatórios.
const { chromium } = require('playwright');
const { launchOptions, abrirApp, seedPadrao, uid } = require('./helpers');

function movimento(base) {
  return Object.assign({
    id: uid(),
    type: 'entrada',
    qty: 1,
    unidade: 'un',
    who_name: 'Diretora Admin',
    who_id: null,
    fornecedor: '',
    motivo: '',
    nota: '',
    at: '2026-09-15T12:00:00.000Z',
    estornado: false,
    estornado_por_nome: null,
    estornado_em: null,
  }, base);
}

function seedComDuplicata() {
  const seed = seedPadrao();
  const catPluralId = uid();
  const catSingularId = uid();
  const pratoId = uid();
  const copoId = uid();

  seed.categories.push(
    { id: catPluralId, nome: 'Descartáveis', area: 'limpeza', created_at: '2026-01-01T00:00:00.000Z' },
    { id: catSingularId, nome: 'Descartável', area: 'limpeza', created_at: '2026-01-02T00:00:00.000Z' },
  );
  seed.items.push(
    { id: pratoId, name: 'Prato descartável', category_id: catPluralId, unit: 'pacote', qty: 12, min: 3, criado_por: 'Diretora Admin', criado_em: new Date().toISOString(), ajustado_por: null, ajustado_em: null },
    { id: copoId, name: 'Copo descartável', category_id: catSingularId, unit: 'pacote', qty: 20, min: 5, criado_por: 'Diretora Admin', criado_em: new Date().toISOString(), ajustado_por: null, ajustado_em: null },
  );
  seed.movements.push(
    movimento({ item_id: pratoId, fornecedor: 'Fornecedor Pratos' }),
    movimento({ item_id: copoId, fornecedor: 'Fornecedor Copos' }),
  );
  return seed;
}

async function loginAdmin(page) {
  await page.waitForSelector('.auth-box');
  await page.fill('[data-field="auth-email"]', 'admin@escola.com');
  await page.fill('[data-field="auth-senha"]', 'senha123');
  await page.locator('[data-action="fazer-login"]').click();
  await page.waitForSelector('.item-card', { timeout: 5000 });
}

(async () => {
  const browser = await chromium.launch(launchOptions());
  let falhas = 0;
  function check(desc, cond) {
    console.log((cond ? 'OK  ' : 'FALHOU  ') + desc);
    if (!cond) falhas++;
  }

  const page = await abrirApp(browser, seedComDuplicata());
  await loginAdmin(page);

  const nomesIniciais = await page.locator('.item-name').allTextContents();
  check('Todos os produtos continuam aparecendo', nomesIniciais.includes('Prato descartável') && nomesIniciais.includes('Copo descartável'));

  const chips = await page.locator('[data-action="set-cat"]').evaluateAll((els) => els.map((el) => el.getAttribute('data-cat')));
  check('Existe somente a opção "Descartáveis"', chips.includes('Descartáveis') && !chips.includes('Descartável'));

  await page.locator('[data-action="set-cat"][data-cat="Descartáveis"]').click();
  const nomesFiltrados = await page.locator('.item-name').allTextContents();
  check('Filtro "Descartáveis" mostra produtos das duas categorias antigas', nomesFiltrados.includes('Prato descartável') && nomesFiltrados.includes('Copo descartável'));
  check('Não existe grupo separado "Descartável"', (await page.locator('.cat-header').allTextContents()).every((t) => !/^Descartável\s/.test(t)));

  await page.locator('[data-action="set-tab"][data-tab="cadastro"]').click();
  await page.locator('[data-action="set-cadastro-sub"][data-sub="categorias"]').click();
  const categoriasCadastro = await page.locator('.categoria-row').allTextContents();
  check('Cadastro não mostra categoria duplicada', categoriasCadastro.some((t) => t.includes('Descartáveis')) && categoriasCadastro.every((t) => !t.includes('Descartável (')));

  await page.locator('[data-action="set-tab"][data-tab="historico"]').click();
  const historico = await page.locator('.content').textContent();
  check('Histórico continua mostrando movimentos dos produtos afetados', historico.includes('Prato descartável') && historico.includes('Copo descartável'));

  await page.locator('[data-action="set-tab"][data-tab="relatorios"]').click();
  await page.selectOption('[data-field="rel-area"]', 'limpeza');
  await page.selectOption('[data-field="rel-mes"]', '9');
  await page.selectOption('[data-field="rel-ano"]', '2026');
  const relatorio = await page.locator('.content').textContent();
  check('Relatórios continuam mostrando movimentos dos produtos afetados', relatorio.includes('Prato descartável') && relatorio.includes('Copo descartável') && relatorio.includes('2 movimentações encontradas'));

  await page.close();
  await browser.close();

  console.log('\n--- RESULTADO test14-categorias-duplicadas ---');
  console.log(falhas === 0 ? 'TODOS OS CHECKS PASSARAM' : falhas + ' CHECK(S) FALHARAM');
  process.exit(falhas === 0 ? 0 : 1);
})().catch((e) => { console.error('FALHA NO TESTE:', e); process.exit(1); });
