// Teste 4 — O MAIS IMPORTANTE DESTA MIGRAÇÃO: tenta burlar as permissões
// direto pelo "DevTools", chamando o cliente Supabase (mock, mas com as
// MESMAS regras do schema.sql/RLS real) diretamente pelo console do
// navegador, ignorando a interface. Isso é exatamente o ataque que a
// versão antiga (Artifact, sem backend) não conseguia impedir, porque lá
// tudo — inclusive as checagens de permissão — rodava no navegador do
// próprio usuário. Aqui, cada tentativa deve ser rejeitada pelo "servidor"
// (o mock reproduz as policies/triggers), mesmo que o botão da interface
// para aquela ação nem apareça na tela.
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
  const page = await abrirApp(browser, seed);
  await page.waitForSelector('.auth-box');
  await page.fill('[data-field="auth-email"]', 'coz@escola.com');
  await page.fill('[data-field="auth-senha"]', 'senha123');
  await page.locator('[data-action="fazer-login"]').click();
  await page.waitForSelector('.item-card', { timeout: 5000 });

  // 1) Usuária "padrão" tenta se auto-promover a admin chamando o backend direto.
  const r1 = await page.evaluate(async (ids) => {
    const res = await window.__DESPENSA_TEST_CLIENT__.from('profiles').update({ role: 'admin' }).eq('id', ids.cozId);
    return res;
  }, seed.ids);
  check('Auto-promoção a admin via chamada direta é REJEITADA', !!r1.error);

  // 2) Usuária "padrão" da cozinha tenta registrar movimento em item da LIMPEZA.
  const r2 = await page.evaluate(async (ids) => {
    const res = await window.__DESPENSA_TEST_CLIENT__.rpc('registrar_movimento', {
      p_item_id: ids.itemLimpId, p_tipo: 'saida', p_qty: 1, p_unidade: 'un', p_fornecedor: '', p_motivo: 'teste', p_nota: '',
    });
    return res;
  }, seed.ids);
  check('Registrar movimento fora da própria área é REJEITADO', !!r2.error);

  // 3) Usuária "padrão" tenta inserir um item novo direto (só admin pode).
  const r3 = await page.evaluate(async (ids) => {
    const res = await window.__DESPENSA_TEST_CLIENT__.from('items').insert({ name: 'Item Hackeado', category_id: ids.catCozId, unit: 'un', qty: 100, min: 0 });
    return res;
  }, seed.ids);
  check('Inserir item direto (sem ser admin) é REJEITADO', !!r3.error);

  // 4) Usuária "padrão" tenta apagar um item alheio direto (só admin pode).
  const r4 = await page.evaluate(async (ids) => {
    const res = await window.__DESPENSA_TEST_CLIENT__.from('items').delete().eq('id', ids.itemCozId);
    return res;
  }, seed.ids);
  check('Remover item direto (sem ser admin) é REJEITADO', !!r4.error);

  // 5) Usuária "padrão" tenta inserir um registro de auditoria se passando por outra pessoa.
  const r5 = await page.evaluate(async (ids) => {
    const res = await window.__DESPENSA_TEST_CLIENT__.from('audit_log').insert({ tipo: 'perfil', descricao: 'forjado', actor_id: ids.adminId });
    return res;
  }, seed.ids);
  check('Inserir auditoria se passando por outra pessoa é REJEITADO', !!r5.error);

  // 6) Mesma usuária consegue registrar um movimento normal NA SUA área (controle: garantir que o mock não está bloqueando tudo).
  const r6 = await page.evaluate(async (ids) => {
    const res = await window.__DESPENSA_TEST_CLIENT__.rpc('registrar_movimento', {
      p_item_id: ids.itemCozId, p_tipo: 'saida', p_qty: 1, p_unidade: 'kg', p_fornecedor: '', p_motivo: 'teste', p_nota: '',
    });
    return res;
  }, seed.ids);
  check('(controle) Registrar movimento NA própria área funciona normalmente', !r6.error);

  // 7) Tenta rebaixar/remover o ÚLTIMO administrador direto pelo backend.
  const r7 = await page.evaluate(async (ids) => {
    const res = await window.__DESPENSA_TEST_CLIENT__.from('profiles').update({ role: 'padrao', area: 'cozinha' }).eq('id', ids.adminId);
    return res;
  }, seed.ids);
  check('Rebaixar o único administrador direto pelo backend é REJEITADO', !!r7.error);

  await page.close();
  await browser.close();

  console.log('\n--- RESULTADO test4-seguranca-bypass ---');
  console.log(falhas === 0 ? 'TODOS OS CHECKS PASSARAM' : falhas + ' CHECK(S) FALHARAM');
  process.exit(falhas === 0 ? 0 : 1);
})().catch((e) => { console.error('FALHA NO TESTE:', e); process.exit(1); });
