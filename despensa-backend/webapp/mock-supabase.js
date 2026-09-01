/* ============================================================================
   mock-supabase.js — cliente Supabase falso para testes com Playwright.

   Reproduz, em memória, o suficiente da API do @supabase/supabase-js v2
   (auth.*, from().*, rpc(), channel().on().subscribe()) para que o
   index.html rode de ponta a ponta SEM rede real — e, mais importante,
   reproduz as MESMAS regras de permissão que o schema.sql aplica no
   Postgres de verdade (RLS + funções SECURITY DEFINER), para que os
   testes consigam validar que um usuário "padrão" não consegue burlar
   permissões nem pelo DevTools (chamando sb.from(...)/sb.rpc(...) direto).

   Uso (no teste Playwright):
     await page.addInitScript({ path: require.resolve('./mock-supabase.js') });
     await page.addInitScript((seed) => {
       window.__DESPENSA_TEST_CLIENT__ = window.__criarMockSupabase__(seed);
     }, seedData);
============================================================================ */
(function () {
  function uid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }
  function nowIso() { return new Date().toISOString(); }
  function clone(v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }
  function err(message) { return { message: message }; }

  function criarMockSupabase(seed) {
    seed = seed || {};
    var db = {
      users: clone(seed.users) || [],       // {id,email,password,user_metadata}
      profiles: clone(seed.profiles) || [], // {id,name,role,area,created_at}
      categories: clone(seed.categories) || [],
      units: seed.units !== undefined ? clone(seed.units) : ['kg', 'L', 'un', 'pacote', 'cx', 'garrafa'].map(function (nome) { return { id: uid(), nome: nome, created_at: nowIso() }; }),
      items: clone(seed.items) || [],
      movements: clone(seed.movements) || [],
      audit_log: clone(seed.audit_log) || [],
      settings: clone(seed.settings) || { id: true, school_name: 'Cozinha da escola', arquivo_meses: 12, ultima_exportacao_em: null },
      fornecedor_produtos: clone(seed.fornecedor_produtos) || [],
      planilha_merenda_mapa: clone(seed.planilha_merenda_mapa) || [],
    };
    var session = null;
    var authListeners = [];
    var channels = [];
    // Respostas simuladas de Edge Functions (ex.: "ler-nf") — não são dados
    // do banco, por isso NÃO passam por clone() (podem ser funções JS).
    var functionMocks = seed.functionMocks || {};

    function fireAuthChange(event) {
      authListeners.forEach(function (cb) { try { cb(event, session ? clone(session) : null); } catch (e) {} });
    }
    function fireRealtime(table) {
      channels.forEach(function (ch) {
        (ch.callbacks[table] || []).forEach(function (cb) {
          try { cb({ table: table }); } catch (e) {}
        });
      });
    }
    function myProfile() {
      if (!session) return null;
      var p = db.profiles.filter(function (p) { return p.id === session.user.id; })[0];
      return p || null;
    }
    function isAdmin() { var p = myProfile(); return !!p && p.role === 'admin'; }
    function myArea() { var p = myProfile(); return p ? p.area : null; }
    function categoriaArea(categoryId) {
      var c = db.categories.filter(function (c) { return c.id === categoryId; })[0];
      return c ? c.area : null;
    }
    function itemArea(itemId) {
      var it = db.items.filter(function (i) { return i.id === itemId; })[0];
      if (!it) return null;
      return categoriaArea(it.category_id);
    }
    function movimentoArea(mov) {
      return itemArea(mov.item_id);
    }
    function podeVerArea(area) {
      return isAdmin() || area === 'ambas' || myArea() === 'ambas' || myArea() === area;
    }
    function contarAdmins() {
      return db.profiles.filter(function (p) { return p.role === 'admin'; }).length;
    }

    // ---- provisionamento de novo usuário (equivalente ao trigger handle_new_user) ----
    function provisionarPerfil(user) {
      var jaExisteGente = db.profiles.length > 0;
      var areaEscolhida = (user.user_metadata && user.user_metadata.area) || 'cozinha';
      if (areaEscolhida !== 'cozinha' && areaEscolhida !== 'limpeza') areaEscolhida = 'cozinha';
      var perfil = {
        id: user.id,
        name: (user.user_metadata && (user.user_metadata.name || '').trim()) || user.email.split('@')[0],
        role: jaExisteGente ? 'padrao' : 'admin',
        area: jaExisteGente ? areaEscolhida : 'ambas',
        created_at: nowIso(),
      };
      db.profiles.push(perfil);
      return perfil;
    }

    // ---- query builder (equivalente ao PostgREST + RLS) ----
    function QueryBuilder(table) {
      this.table = table;
      this.op = 'select';
      this.payload = null;
      this.filters = [];
      this.orderCol = null;
      this.orderDesc = false;
      this.limitN = null;
      this.singleMode = false;
    }
    QueryBuilder.prototype.select = function () { return this; };
    QueryBuilder.prototype.insert = function (obj) { this.op = 'insert'; this.payload = obj; return this; };
    QueryBuilder.prototype.upsert = function (obj, opts) { this.op = 'upsert'; this.payload = obj; this.upsertOpts = opts; return this; };
    QueryBuilder.prototype.update = function (obj) { this.op = 'update'; this.payload = obj; return this; };
    QueryBuilder.prototype.delete = function () { this.op = 'delete'; return this; };
    QueryBuilder.prototype.eq = function (col, val) { this.filters.push([col, val]); return this; };
    QueryBuilder.prototype.order = function (col, opts) { this.orderCol = col; this.orderDesc = !!(opts && opts.ascending === false); return this; };
    QueryBuilder.prototype.limit = function (n) { this.limitN = n; return this; };
    QueryBuilder.prototype.single = function () { this.singleMode = true; return this; };
    QueryBuilder.prototype.then = function (resolve) {
      var out;
      try { out = executarQuery(this); }
      catch (e) { out = { data: null, error: err(e.message) }; }
      resolve(out);
    };

    function linhasBase(table) {
      return db[table] ? db[table].slice() : [];
    }
    function aplicaFiltros(rows, filters) {
      filters.forEach(function (f) { rows = rows.filter(function (r) { return r[f[0]] === f[1]; }); });
      return rows;
    }
    function checarSelectRLS(table, rows) {
      if (!session) return [];
      if (table === 'profiles' || table === 'categories' || table === 'units' || table === 'settings') return rows;
      if (table === 'items') return rows.filter(function (i) { return podeVerArea(categoriaArea(i.category_id)); });
      if (table === 'movements') return rows.filter(function (m) { return podeVerArea(itemArea(m.item_id)); });
      if (table === 'audit_log') return isAdmin() ? rows : [];
      if (table === 'fornecedor_produtos') return isAdmin() ? rows : [];
      if (table === 'planilha_merenda_mapa') return isAdmin() ? rows : [];
      return rows;
    }

    function executarQuery(qb) {
      if (!session) return { data: null, error: err('JWT ausente ou inválido (não autenticado)') };
      var table = qb.table;

      if (qb.op === 'select') {
        var rows = checarSelectRLS(table, linhasBase(table));
        rows = aplicaFiltros(rows, qb.filters);
        if (qb.orderCol) {
          rows.sort(function (a, b) {
            if (a[qb.orderCol] < b[qb.orderCol]) return qb.orderDesc ? 1 : -1;
            if (a[qb.orderCol] > b[qb.orderCol]) return qb.orderDesc ? -1 : 1;
            return 0;
          });
        }
        if (qb.limitN) rows = rows.slice(0, qb.limitN);
        if (qb.singleMode) {
          if (!rows.length) return { data: null, error: err('nenhuma linha encontrada') };
          return { data: clone(rows[0]), error: null };
        }
        return { data: clone(rows), error: null };
      }

      if (qb.op === 'insert') {
        if (table === 'items') {
          if (!isAdmin()) return { data: null, error: err('new row violates row-level security policy for table items') };
          var novoItem = Object.assign({ id: uid(), criado_em: nowIso(), ajustado_por: null, ajustado_em: null }, qb.payload);
          db.items.push(novoItem);
          fireRealtime('items');
          return { data: clone(novoItem), error: null };
        }
        if (table === 'categories') {
          if (!isAdmin()) return { data: null, error: err('new row violates row-level security policy for table categories') };
          var jaExisteCat = db.categories.some(function (c) { return c.nome === qb.payload.nome; });
          if (jaExisteCat) return { data: null, error: err('duplicate key value violates unique constraint "categories_nome_key"') };
          var novaCat = Object.assign({ id: uid(), created_at: nowIso() }, qb.payload);
          db.categories.push(novaCat);
          fireRealtime('categories');
          return { data: clone(novaCat), error: null };
        }
        if (table === 'units') {
          if (!isAdmin()) return { data: null, error: err('new row violates row-level security policy for table units') };
          var jaExisteUn = db.units.some(function (u) { return u.nome === qb.payload.nome; });
          if (jaExisteUn) return { data: null, error: err('duplicate key value violates unique constraint "units_nome_key"') };
          var novaUn = Object.assign({ id: uid(), created_at: nowIso() }, qb.payload);
          db.units.push(novaUn);
          fireRealtime('units');
          return { data: clone(novaUn), error: null };
        }
        if (table === 'audit_log') {
          if (qb.payload.actor_id !== session.user.id) return { data: null, error: err('new row violates row-level security policy for table audit_log') };
          var validTipos = ['perfil', 'categoria', 'unidade', 'config', 'arquivamento', 'produto', 'ajuste'];
          if (validTipos.indexOf(qb.payload.tipo) === -1) return { data: null, error: err('new row violates check constraint "audit_log_tipo_check"') };
          var novoLog = Object.assign({ id: uid(), em: nowIso() }, qb.payload);
          db.audit_log.push(novoLog);
          return { data: clone(novoLog), error: null };
        }
        if (table === 'fornecedor_produtos') {
          if (!isAdmin()) return { data: null, error: err('new row violates row-level security policy for table fornecedor_produtos') };
          var jaExisteMapa = db.fornecedor_produtos.some(function (m) { return m.fornecedor_cnpj === qb.payload.fornecedor_cnpj && m.cod_prod_nf === qb.payload.cod_prod_nf; });
          if (jaExisteMapa) return { data: null, error: err('duplicate key value violates unique constraint "fornecedor_produtos_fornecedor_cnpj_cod_prod_nf_key"') };
          var novoMapa = Object.assign({ id: uid(), criado_em: nowIso(), atualizado_por: null, atualizado_em: null }, qb.payload);
          db.fornecedor_produtos.push(novoMapa);
          return { data: clone(novoMapa), error: null };
        }
        if (table === 'planilha_merenda_mapa') {
          if (!isAdmin()) return { data: null, error: err('new row violates row-level security policy for table planilha_merenda_mapa') };
          var jaExisteMapaPl = db.planilha_merenda_mapa.some(function (m) { return m.item_id === qb.payload.item_id; });
          if (jaExisteMapaPl) return { data: null, error: err('duplicate key value violates unique constraint "planilha_merenda_mapa_item_id_key"') };
          var novoMapaPl = Object.assign({ id: uid(), criado_em: nowIso(), atualizado_por: null, atualizado_em: null }, qb.payload);
          db.planilha_merenda_mapa.push(novoMapaPl);
          return { data: clone(novoMapaPl), error: null };
        }
        return { data: null, error: err('insert não suportado neste mock para ' + table) };
      }

      if (qb.op === 'upsert') {
        if (table === 'fornecedor_produtos') {
          if (!isAdmin()) return { data: null, error: err('new row violates row-level security policy for table fornecedor_produtos') };
          var existenteMapa = db.fornecedor_produtos.filter(function (m) { return m.fornecedor_cnpj === qb.payload.fornecedor_cnpj && m.cod_prod_nf === qb.payload.cod_prod_nf; })[0];
          if (existenteMapa) {
            Object.assign(existenteMapa, qb.payload);
            return { data: clone(existenteMapa), error: null };
          }
          var novoMapaUp = Object.assign({ id: uid(), criado_em: nowIso() }, qb.payload);
          db.fornecedor_produtos.push(novoMapaUp);
          return { data: clone(novoMapaUp), error: null };
        }
        if (table === 'planilha_merenda_mapa') {
          if (!isAdmin()) return { data: null, error: err('new row violates row-level security policy for table planilha_merenda_mapa') };
          var existenteMapaPl = db.planilha_merenda_mapa.filter(function (m) { return m.item_id === qb.payload.item_id; })[0];
          if (existenteMapaPl) {
            Object.assign(existenteMapaPl, qb.payload);
            return { data: clone(existenteMapaPl), error: null };
          }
          var novoMapaPlUp = Object.assign({ id: uid(), criado_em: nowIso() }, qb.payload);
          db.planilha_merenda_mapa.push(novoMapaPlUp);
          return { data: clone(novoMapaPlUp), error: null };
        }
        return { data: null, error: err('upsert não suportado neste mock para ' + table) };
      }

      if (qb.op === 'update') {
        if (table === 'items') {
          var alvoItens = aplicaFiltros(linhasBase('items'), qb.filters);
          if (!alvoItens.length) return { data: null, error: null };
          var podeAtualizarItem = alvoItens.every(function (i) { return podeVerArea(categoriaArea(i.category_id)); });
          if (!podeAtualizarItem) return { data: null, error: err('new row violates row-level security policy for table items') };
          alvoItens.forEach(function (i) {
            var real = db.items.filter(function (x) { return x.id === i.id; })[0];
            Object.assign(real, qb.payload);
          });
          fireRealtime('items');
          return { data: null, error: null };
        }
        if (table === 'categories') {
          if (!isAdmin()) return { data: null, error: err('new row violates row-level security policy for table categories') };
          var alvoCats = aplicaFiltros(linhasBase('categories'), qb.filters);
          alvoCats.forEach(function (c) {
            var real = db.categories.filter(function (x) { return x.id === c.id; })[0];
            Object.assign(real, qb.payload);
          });
          fireRealtime('categories');
          return { data: null, error: null };
        }
        if (table === 'settings') {
          if (!isAdmin()) return { data: null, error: err('new row violates row-level security policy for table settings') };
          Object.assign(db.settings, qb.payload);
          fireRealtime('settings');
          return { data: null, error: null };
        }
        if (table === 'profiles') {
          var alvoPerfis = aplicaFiltros(linhasBase('profiles'), qb.filters);
          if (!alvoPerfis.length) return { data: null, error: null };
          for (var pi = 0; pi < alvoPerfis.length; pi++) {
            var alvo = alvoPerfis[pi];
            var souEu = alvo.id === session.user.id;
            var mudaRoleOuArea = ('role' in qb.payload && qb.payload.role !== alvo.role) || ('area' in qb.payload && qb.payload.area !== alvo.area);
            if (!isAdmin() && !(souEu && !mudaRoleOuArea)) {
              return { data: null, error: err('new row violates row-level security policy for table profiles') };
            }
            // Proteção do último admin (equivalente ao trigger proteger_ultimo_admin).
            var viraNaoAdmin = alvo.role === 'admin' && 'role' in qb.payload && qb.payload.role !== 'admin';
            if (viraNaoAdmin && contarAdmins() <= 1) {
              return { data: null, error: err('não é possível remover ou rebaixar o único administrador') };
            }
          }
          alvoPerfis.forEach(function (p) {
            var real = db.profiles.filter(function (x) { return x.id === p.id; })[0];
            Object.assign(real, qb.payload);
          });
          fireRealtime('profiles');
          return { data: null, error: null };
        }
        return { data: null, error: err('update não suportado neste mock para ' + table) };
      }

      if (qb.op === 'delete') {
        if (table === 'items') {
          if (!isAdmin()) return { data: null, error: err('new row violates row-level security policy for table items') };
          var idsRemItens = aplicaFiltros(linhasBase('items'), qb.filters).map(function (i) { return i.id; });
          db.items = db.items.filter(function (i) { return idsRemItens.indexOf(i.id) === -1; });
          fireRealtime('items');
          return { data: null, error: null };
        }
        if (table === 'categories') {
          if (!isAdmin()) return { data: null, error: err('new row violates row-level security policy for table categories') };
          var idsRemCats = aplicaFiltros(linhasBase('categories'), qb.filters).map(function (c) { return c.id; });
          db.categories = db.categories.filter(function (c) { return idsRemCats.indexOf(c.id) === -1; });
          fireRealtime('categories');
          return { data: null, error: null };
        }
        if (table === 'units') {
          if (!isAdmin()) return { data: null, error: err('new row violates row-level security policy for table units') };
          var idsRemUns = aplicaFiltros(linhasBase('units'), qb.filters).map(function (u) { return u.id; });
          db.units = db.units.filter(function (u) { return idsRemUns.indexOf(u.id) === -1; });
          fireRealtime('units');
          return { data: null, error: null };
        }
        if (table === 'profiles') {
          var idsRemPerfis = aplicaFiltros(linhasBase('profiles'), qb.filters).map(function (p) { return p.id; });
          if (!isAdmin()) return { data: null, error: err('new row violates row-level security policy for table profiles') };
          var restamAdmins = db.profiles.filter(function (p) { return idsRemPerfis.indexOf(p.id) === -1 && p.role === 'admin'; }).length;
          var tinhaAdminEntreRemovidos = db.profiles.some(function (p) { return idsRemPerfis.indexOf(p.id) !== -1 && p.role === 'admin'; });
          if (tinhaAdminEntreRemovidos && restamAdmins < 1) {
            return { data: null, error: err('não é possível remover ou rebaixar o único administrador') };
          }
          db.profiles = db.profiles.filter(function (p) { return idsRemPerfis.indexOf(p.id) === -1; });
          fireRealtime('profiles');
          return { data: null, error: null };
        }
        if (table === 'planilha_merenda_mapa') {
          if (!isAdmin()) return { data: null, error: err('new row violates row-level security policy for table planilha_merenda_mapa') };
          var idsRemMapaPl = aplicaFiltros(linhasBase('planilha_merenda_mapa'), qb.filters).map(function (m) { return m.id; });
          db.planilha_merenda_mapa = db.planilha_merenda_mapa.filter(function (m) { return idsRemMapaPl.indexOf(m.id) === -1; });
          return { data: null, error: null };
        }
        return { data: null, error: err('delete não suportado neste mock para ' + table) };
      }

      return { data: null, error: err('operação desconhecida') };
    }

    // ---- RPCs (equivalentes às funções SECURITY DEFINER do schema.sql) ----
    function rpcRegistrarMovimento(args) {
      if (!session) return { data: null, error: err('não autenticado') };
      if (args.p_tipo !== 'entrada' && args.p_tipo !== 'saida') return { data: null, error: err('tipo de movimento inválido') };
      if (!(args.p_qty > 0)) return { data: null, error: err('quantidade deve ser maior que zero') };
      var item = db.items.filter(function (i) { return i.id === args.p_item_id; })[0];
      if (!item) return { data: null, error: err('item não encontrado') };
      var area = categoriaArea(item.category_id);
      if (!podeVerArea(area)) return { data: null, error: err('sem permissão para esta área') };
      var perfil = myProfile();
      var delta = args.p_tipo === 'entrada' ? args.p_qty : -args.p_qty;
      var novaQty = Math.max(0, Number(item.qty) + delta);
      item.qty = novaQty;
      item.unit = args.p_unidade || item.unit;
      item.ajustado_por = perfil ? perfil.name : null;
      item.ajustado_em = nowIso();
      var mov = {
        id: uid(), item_id: item.id, type: args.p_tipo, qty: args.p_qty, unidade: args.p_unidade,
        who_id: session.user.id, who_name: perfil ? perfil.name : '', fornecedor: args.p_fornecedor || '',
        motivo: args.p_motivo || '', nota: args.p_nota || '', at: nowIso(), estornado: false,
        estornado_por: null, estornado_por_nome: null, estornado_em: null,
      };
      db.movements.push(mov);
      fireRealtime('items'); fireRealtime('movements');
      return { data: clone(mov), error: null };
    }
    function rpcEstornarMovimento(args) {
      if (!session) return { data: null, error: err('não autenticado') };
      var mov = db.movements.filter(function (m) { return m.id === args.p_mov_id; })[0];
      if (!mov) return { data: null, error: err('movimentação não encontrada') };
      if (mov.estornado) return { data: null, error: err('movimentação já foi estornada') };
      var area = movimentoArea(mov);
      if (!podeVerArea(area)) return { data: null, error: err('sem permissão para esta área') };
      var item = db.items.filter(function (i) { return i.id === mov.item_id; })[0];
      if (item) {
        var deltaInverso = mov.type === 'entrada' ? -mov.qty : mov.qty;
        item.qty = Math.max(0, Number(item.qty) + deltaInverso);
      }
      var perfil = myProfile();
      mov.estornado = true;
      mov.estornado_por = session.user.id;
      mov.estornado_por_nome = perfil ? perfil.name : '';
      mov.estornado_em = nowIso();
      fireRealtime('items'); fireRealtime('movements');
      return { data: clone(mov), error: null };
    }
    function rpcMarcarMovimentosSincronizados(args) {
      if (!session) return { data: null, error: err('não autenticado') };
      if (!isAdmin()) return { data: null, error: err('só um administrador pode confirmar a sincronização com a planilha') };
      var ids = args.p_ids || [];
      var total = 0;
      db.movements.forEach(function (m) {
        if (ids.indexOf(m.id) !== -1 && !m.sincronizado_planilha_em) {
          m.sincronizado_planilha_em = nowIso();
          total++;
        }
      });
      return { data: total, error: null };
    }
    function rpcArquivarMovimentosAntigos() {
      if (!session) return { data: null, error: err('não autenticado') };
      if (!isAdmin()) return { data: null, error: err('apenas administradores podem arquivar movimentações') };
      var meses = db.settings.arquivo_meses || 12;
      var limite = new Date();
      limite.setMonth(limite.getMonth() - meses);
      var antes = db.movements.length;
      db.movements = db.movements.filter(function (m) { return new Date(m.at) >= limite; });
      var total = antes - db.movements.length;
      if (total > 0) {
        db.audit_log.push({
          id: uid(), tipo: 'arquivamento',
          descricao: total + ' movimentação(ões) com mais de ' + meses + ' meses foram arquivadas.',
          actor_id: session.user.id, em: nowIso(),
        });
      }
      fireRealtime('movements');
      return { data: total, error: null };
    }

    // ---- objeto cliente exposto como window.__DESPENSA_TEST_CLIENT__ ----
    var client = {
      _db: db, // exposto só para inspeção nos testes
      from: function (table) { return new QueryBuilder(table); },
      rpc: function (name, args) {
        args = args || {};
        var res;
        if (name === 'registrar_movimento') res = rpcRegistrarMovimento(args);
        else if (name === 'estornar_movimento') res = rpcEstornarMovimento(args);
        else if (name === 'arquivar_movimentos_antigos') res = rpcArquivarMovimentosAntigos();
        else if (name === 'marcar_movimentos_sincronizados') res = rpcMarcarMovimentosSincronizados(args);
        else res = { data: null, error: err('função rpc desconhecida: ' + name) };
        return { then: function (resolve) { resolve(res); } };
      },
      channel: function (name) {
        var ch = { name: name, callbacks: {} };
        var api = {
          on: function (event, filter, cb) {
            var table = filter && filter.table;
            ch.callbacks[table] = ch.callbacks[table] || [];
            ch.callbacks[table].push(cb);
            return api;
          },
          subscribe: function () { channels.push(ch); return api; },
        };
        return api;
      },
      removeChannel: function (ch) {
        channels = channels.filter(function (c) { return c !== ch; });
      },
      functions: {
        // Simula sb.functions.invoke('nome-da-funcao', { body }). Configure
        // a resposta via seed.functionMocks = { 'ler-nf': {data:{...}} } ou
        // client.__setFunctionMock('ler-nf', function(body){ return {...}; }).
        invoke: function (name, opts) {
          if (!session) return Promise.resolve({ data: null, error: err('não autenticado') });
          var handler = functionMocks[name];
          if (handler === undefined) {
            return Promise.resolve({ data: null, error: err('função "' + name + '" não tem resposta simulada configurada neste teste (seed.functionMocks)') });
          }
          var body = opts && opts.body;
          var resultado = (typeof handler === 'function') ? handler(body) : handler;
          return Promise.resolve(resultado);
        },
      },
      auth: {
        signInWithPassword: function (creds) {
          var user = db.users.filter(function (u) { return u.email === creds.email; })[0];
          if (!user || user.password !== creds.password) {
            return Promise.resolve({ data: { session: null, user: null }, error: err('Invalid login credentials') });
          }
          session = { access_token: 'mock-token-' + user.id, user: { id: user.id, email: user.email, user_metadata: user.user_metadata } };
          fireAuthChange('SIGNED_IN');
          return Promise.resolve({ data: { session: clone(session), user: clone(session.user) }, error: null });
        },
        signUp: function (opts) {
          var jaExiste = db.users.some(function (u) { return u.email === opts.email; });
          if (jaExiste) return Promise.resolve({ data: { session: null, user: null }, error: err('User already registered') });
          if (!opts.password || opts.password.length < 6) {
            return Promise.resolve({ data: { session: null, user: null }, error: err('Password should be at least 6 characters') });
          }
          var novoUser = { id: uid(), email: opts.email, password: opts.password, user_metadata: (opts.options && opts.options.data) || {} };
          db.users.push(novoUser);
          provisionarPerfil(novoUser);
          session = { access_token: 'mock-token-' + novoUser.id, user: { id: novoUser.id, email: novoUser.email, user_metadata: novoUser.user_metadata } };
          fireAuthChange('SIGNED_IN');
          return Promise.resolve({ data: { session: clone(session), user: clone(session.user) }, error: null });
        },
        signOut: function () {
          session = null;
          fireAuthChange('SIGNED_OUT');
          return Promise.resolve({ error: null });
        },
        getSession: function () {
          return Promise.resolve({ data: { session: session ? clone(session) : null }, error: null });
        },
        onAuthStateChange: function (cb) {
          authListeners.push(cb);
          return { data: { subscription: { unsubscribe: function () { authListeners = authListeners.filter(function (l) { return l !== cb; }); } } } };
        },
        resetPasswordForEmail: function (email, opts) {
          // Igual ao Supabase de verdade: não revela se o e-mail existe ou
          // não (a tela sempre mostra a mesma mensagem genérica).
          return Promise.resolve({ data: {}, error: null });
        },
        updateUser: function (attrs) {
          if (!session) return Promise.resolve({ data: null, error: err('Auth session missing!') });
          var user = db.users.filter(function (u) { return u.id === session.user.id; })[0];
          if (!user) return Promise.resolve({ data: null, error: err('Auth session missing!') });
          if (attrs && 'password' in attrs) {
            if (!attrs.password || attrs.password.length < 6) {
              return Promise.resolve({ data: null, error: err('Password should be at least 6 characters') });
            }
            user.password = attrs.password;
          }
          return Promise.resolve({ data: { user: clone(session.user), session: clone(session) }, error: null });
        },
      },
    };
    // Gatilho só de teste (não existe no supabase-js de verdade): simula o
    // que acontece quando a pessoa clica no link de recuperação de senha do
    // e-mail — ela chega de volta no app já autenticada temporariamente, e
    // o evento PASSWORD_RECOVERY dispara (é isso que index.html escuta pra
    // mostrar a tela de "criar nova senha").
    client.__setFunctionMock = function (name, handler) { functionMocks[name] = handler; };
    client.__dispararRecuperacaoSenha = function (email) {
      var user = db.users.filter(function (u) { return u.email === email; })[0];
      if (!user) return false;
      session = { access_token: 'mock-recovery-token-' + user.id, user: { id: user.id, email: user.email, user_metadata: user.user_metadata } };
      fireAuthChange('PASSWORD_RECOVERY');
      return true;
    };
    return client;
  }

  window.__criarMockSupabase__ = criarMockSupabase;
})();
