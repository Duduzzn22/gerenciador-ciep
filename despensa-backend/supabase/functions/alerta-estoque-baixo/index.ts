// ============================================================================
// ALERTA DE ESTOQUE BAIXO POR E-MAIL — Supabase Edge Function
// ============================================================================
// O que esta função faz, toda vez que é chamada:
//   1) Olha a tabela "items" e separa quem está "em falta" (qty = 0) e quem
//      está "com estoque baixo" (qty > 0 mas <= mínimo).
//   2) Se não tiver nenhum item nessas condições, não manda e-mail nenhum
//      (pra não incomodar todo dia à toa).
//   3) Se tiver, monta um e-mail em HTML com a lista e manda para o(s)
//      e-mail(s) de quem é administrador(a) no sistema.
//
// Ela É CHAMADA automaticamente todo dia por um agendamento (veja o arquivo
// "cron-alerta-estoque.sql", que fica na mesma pasta deste arquivo) — não
// precisa de ninguém clicar em nada.
//
// IMPORTANTE — leia "COMO CONFIGURAR" no final deste arquivo antes de
// publicar. Sem os 3 passos de lá (conta de e-mail + segredos + agendamento)
// esta função existe mas nunca vai rodar sozinha.
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2';

Deno.serve(async (_req) => {
  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
    const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
    const EMAIL_REMETENTE = Deno.env.get('ALERTA_EMAIL_FROM') || 'Despensa Digital <onboarding@resend.dev>';

    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return new Response(JSON.stringify({ erro: 'Faltam as variáveis SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (deveriam existir automaticamente).' }), { status: 500 });
    }
    if (!RESEND_API_KEY) {
      return new Response(JSON.stringify({ erro: 'Falta configurar o segredo RESEND_API_KEY. Veja "COMO CONFIGURAR" no topo do arquivo index.ts desta função.' }), { status: 500 });
    }

    // Cliente com a chave de serviço: enxerga tudo, ignora RLS (é código
    // rodando no servidor, não é o navegador de ninguém).
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // 1) Busca os itens e as categorias pra saber nome + área de cada um.
    const { data: items, error: erroItems } = await admin
      .from('items')
      .select('name, qty, min, unit, category_id, categories(nome, area)');
    if (erroItems) throw erroItems;

    const emFalta = (items || []).filter((it) => Number(it.qty) <= 0);
    const baixos = (items || []).filter((it) => Number(it.qty) > 0 && Number(it.qty) <= Number(it.min));

    if (emFalta.length === 0 && baixos.length === 0) {
      return new Response(JSON.stringify({ ok: true, enviado: false, motivo: 'nenhum item em falta ou baixo hoje' }), { status: 200 });
    }

    // 2) Busca quem é administrador(a) — o e-mail mora em auth.users, o
    // papel (admin/padrao) mora em profiles, então cruza os dois.
    const { data: admins, error: erroAdmins } = await admin
      .from('profiles')
      .select('id, name')
      .eq('role', 'admin');
    if (erroAdmins) throw erroAdmins;
    if (!admins || admins.length === 0) {
      return new Response(JSON.stringify({ ok: true, enviado: false, motivo: 'nenhum administrador cadastrado' }), { status: 200 });
    }

    const { data: usersRes, error: erroUsers } = await admin.auth.admin.listUsers({ perPage: 1000 });
    if (erroUsers) throw erroUsers;
    const emailPorId = {};
    (usersRes?.users || []).forEach((u) => { emailPorId[u.id] = u.email; });
    const destinatarios = admins.map((a) => emailPorId[a.id]).filter(Boolean);

    if (destinatarios.length === 0) {
      return new Response(JSON.stringify({ ok: true, enviado: false, motivo: 'nenhum e-mail de administrador encontrado' }), { status: 200 });
    }

    // 3) Monta o e-mail.
    function linhaItem(it) {
      const area = it.categories?.area === 'limpeza' ? 'Limpeza' : 'Cozinha';
      const cat = it.categories?.nome || '';
      return `<li><b>${escapeHtml(it.name)}</b> (${escapeHtml(cat)} · ${area}) — ${it.qty} ${escapeHtml(it.unit)} em estoque, mínimo ${it.min}</li>`;
    }
    function escapeHtml(s) {
      return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    const html = `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
        <h2>Alerta de estoque — Despensa Digital</h2>
        ${emFalta.length ? `<h3 style="color:#c0392b">Itens em falta (${emFalta.length})</h3><ul>${emFalta.map(linhaItem).join('')}</ul>` : ''}
        ${baixos.length ? `<h3 style="color:#d68910">Itens com estoque baixo (${baixos.length})</h3><ul>${baixos.map(linhaItem).join('')}</ul>` : ''}
        <p style="color:#666;font-size:13px">Este e-mail é enviado automaticamente todos os dias quando há itens em falta ou com estoque baixo. Entre no sistema para ver os detalhes e registrar reposições.</p>
      </div>
    `;

    // 4) Envia via Resend (troque este bloco se preferir outro provedor de
    // e-mail — veja "COMO CONFIGURAR" no topo do arquivo).
    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: EMAIL_REMETENTE,
        to: destinatarios,
        subject: `Despensa Digital: ${emFalta.length} item(ns) em falta, ${baixos.length} com estoque baixo`,
        html,
      }),
    });

    if (!resendRes.ok) {
      const detalhe = await resendRes.text();
      throw new Error('Falha ao enviar e-mail pelo Resend: ' + detalhe);
    }

    return new Response(JSON.stringify({ ok: true, enviado: true, destinatarios, emFalta: emFalta.length, baixos: baixos.length }), { status: 200 });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, erro: String(e && e.message ? e.message : e) }), { status: 500 });
  }
});

// ============================================================================
// COMO CONFIGURAR (só precisa fazer uma vez)
// ============================================================================
// 1) Crie uma conta gratuita em https://resend.com (serviço de envio de
//    e-mail). Pegue sua "API Key" (começa com "re_"). Se quiser mandar de um
//    endereço com o domínio da escola, siga o passo de "verificar domínio"
//    lá no Resend; senão, pode deixar o remetente padrão de teste deles.
//
// 2) Publique esta função e configure os segredos dela. Com o Supabase CLI
//    instalado no seu computador (npm install -g supabase), na pasta do
//    projeto rode:
//      supabase login
//      supabase link --project-ref SEU_PROJECT_REF   (o ref aparece na URL
//        do seu projeto no painel do Supabase)
//      supabase functions deploy alerta-estoque-baixo
//      supabase secrets set RESEND_API_KEY=re_xxx ALERTA_EMAIL_FROM="Despensa Digital <alertas@seudominio.com>"
//    (SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY já existem automaticamente,
//    não precisa configurar.)
//
// 3) Agende a execução diária: abra o arquivo "cron-alerta-estoque.sql" (na
//    mesma pasta) e siga as instruções escritas nele — é só colar um
//    trecho de SQL no SQL Editor do Supabase.
// ============================================================================
