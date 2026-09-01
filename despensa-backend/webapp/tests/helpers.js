const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

function launchOptions() {
  const paths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/opt/pw-browsers/chromium',
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) return { executablePath: p };
  }
  return {};
}

const APP_PATH = path.join(__dirname, '..', 'index.html');
const CONFERENCIA_PATH = path.join(__dirname, '..', 'conferencia-nf.html');
const SYNC_PLANILHA_PATH = path.join(__dirname, '..', 'sync-planilha.html');
const MOCK_PATH = path.join(__dirname, '..', 'mock-supabase.js');

// Abre uma página com o app + o cliente mock já injetado como
// window.__DESPENSA_TEST_CLIENT__, semeado com o `seed` dado.
// Passa __DESPENSA_SKIP_AUTOMOUNT__ opcionalmente para controlar o mount manualmente.
async function abrirApp(browser, seed, opts) {
  opts = opts || {};
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', (e) => { errors.push(e.message); console.log('PAGEERROR:', e.message); });
  page.on('console', (msg) => { if (msg.type() === 'error') { errors.push(msg.text()); console.log('CONSOLE ERROR:', msg.text()); } });

  await page.addInitScript({ path: MOCK_PATH });
  await page.addInitScript((args) => {
    window.__DESPENSA_TEST_CLIENT__ = window.__criarMockSupabase__(args.seed);
    if (args.skipAutomount) window.__DESPENSA_SKIP_AUTOMOUNT__ = true;
  }, { seed: seed || {}, skipAutomount: !!opts.skipAutomount });

  await page.goto('file://' + APP_PATH);
  page.__errors = errors;
  return page;
}

// Abre a tela de importação de NF (conferencia-nf.html) com o mock
// injetado, mas SEM logar automaticamente e SEM rodar iniciar() sozinho —
// o teste decide quando "logar" (via client.auth.signInWithPassword) e
// só depois chama window.__iniciarConferenciaNF__() pra carregar a tela
// já autenticada (simula a sessão que, no site de verdade, já viria
// salva no navegador de quem logou no app principal).
async function abrirConferenciaNF(browser, seed) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', (e) => { errors.push(e.message); console.log('PAGEERROR:', e.message); });
  page.on('console', (msg) => { if (msg.type() === 'error') { errors.push(msg.text()); console.log('CONSOLE ERROR:', msg.text()); } });

  await page.addInitScript({ path: MOCK_PATH });
  await page.addInitScript((seed) => {
    window.__DESPENSA_TEST_CLIENT__ = window.__criarMockSupabase__(seed);
    window.__DESPENSA_SKIP_AUTOMOUNT__ = true;
  }, seed || {});

  await page.goto('file://' + CONFERENCIA_PATH);
  page.__errors = errors;
  return page;
}

// Mesma ideia de abrirConferenciaNF, mas para sync-planilha.html.
async function abrirSyncPlanilha(browser, seed) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', (e) => { errors.push(e.message); console.log('PAGEERROR:', e.message); });
  page.on('console', (msg) => { if (msg.type() === 'error') { errors.push(msg.text()); console.log('CONSOLE ERROR:', msg.text()); } });

  await page.addInitScript({ path: MOCK_PATH });
  await page.addInitScript((seed) => {
    window.__DESPENSA_TEST_CLIENT__ = window.__criarMockSupabase__(seed);
    window.__DESPENSA_SKIP_AUTOMOUNT__ = true;
  }, seed || {});

  await page.goto('file://' + SYNC_PLANILHA_PATH);
  page.__errors = errors;
  return page;
}

// Retorna o cliente mock (para inspecionar/chamar direto, tipo um ataque "devtools").
async function pegarClienteMock(page) {
  return page.evaluateHandle(() => window.__DESPENSA_TEST_CLIENT__);
}

function uid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// Monta um seed padrão: 1 admin + 1 padrão-cozinha + 1 padrão-limpeza,
// categorias/itens nas duas áreas.
function seedPadrao() {
  const adminId = uid();
  const cozId = uid();
  const limpId = uid();
  const catCozId = uid();
  const catLimpId = uid();
  const itemCozId = uid();
  const itemLimpId = uid();
  return {
    ids: { adminId, cozId, limpId, catCozId, catLimpId, itemCozId, itemLimpId },
    users: [
      { id: adminId, email: 'admin@escola.com', password: 'senha123', user_metadata: { name: 'Diretora Admin' } },
      { id: cozId, email: 'coz@escola.com', password: 'senha123', user_metadata: { name: 'Merendeira Ana' } },
      { id: limpId, email: 'limp@escola.com', password: 'senha123', user_metadata: { name: 'Zeladora Beth' } },
    ],
    profiles: [
      { id: adminId, name: 'Diretora Admin', role: 'admin', area: 'ambas', created_at: new Date(Date.now() - 30000).toISOString() },
      { id: cozId, name: 'Merendeira Ana', role: 'padrao', area: 'cozinha', created_at: new Date(Date.now() - 20000).toISOString() },
      { id: limpId, name: 'Zeladora Beth', role: 'padrao', area: 'limpeza', created_at: new Date(Date.now() - 10000).toISOString() },
    ],
    categories: [
      { id: catCozId, nome: 'Grãos e Cereais', area: 'cozinha', created_at: new Date().toISOString() },
      { id: catLimpId, nome: 'Limpeza', area: 'limpeza', created_at: new Date().toISOString() },
    ],
    items: [
      { id: itemCozId, name: 'Arroz', category_id: catCozId, unit: 'kg', qty: 10, min: 5, criado_por: 'Diretora Admin', criado_em: new Date().toISOString(), ajustado_por: null, ajustado_em: null },
      { id: itemLimpId, name: 'Detergente', category_id: catLimpId, unit: 'un', qty: 3, min: 2, criado_por: 'Diretora Admin', criado_em: new Date().toISOString(), ajustado_por: null, ajustado_em: null },
    ],
    movements: [],
    audit_log: [],
    settings: { id: true, school_name: 'Escola Teste', arquivo_meses: 12, ultima_exportacao_em: null },
  };
}

module.exports = { launchOptions, abrirApp, abrirConferenciaNF, abrirSyncPlanilha, pegarClienteMock, seedPadrao, uid };
