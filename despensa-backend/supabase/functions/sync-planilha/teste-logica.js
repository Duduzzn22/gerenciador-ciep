// Teste da lógica "pura" de sync-planilha.html (resolução de nome de
// pasta/arquivo do mês + edição da planilha) — SEM depender do Google
// real (não testa autenticação nem a chamada de rede em si, só a lógica
// de nome de arquivo e de edição do .xlsx, que é a parte arriscada de
// dar errado silenciosamente).
//
// Como rodar (precisa do Node instalado):
//   cd supabase/functions/sync-planilha
//   npm install xlsx@0.18.5
//   node teste-logica.js
//
// Funciona lendo o PRÓPRIO index.ts desta pasta e "recortando" só as
// funções (tudo antes de "Deno.serve(...)") — ou seja, testa exatamente
// o código que vai ser publicado, não uma cópia que pode ficar
// desatualizada.
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const src = fs.readFileSync(path.join(__dirname, 'index.ts'), 'utf8');
const semHandler = src.split('Deno.serve(async (req) => {')[0].replace(/^import .*$/gm, '');
const modulo = { exports: {} };
new Function('module', 'exports', 'require', 'var XLSX = require("xlsx");\n' + semHandler + '\nmodule.exports = { normalizar, nomesEsperados, pareceCorreto, acharCabecalhoMensal, editarPlanilha };')(modulo, modulo.exports, require);
const logica = modulo.exports;

let falhas = 0;
function check(desc, cond) {
  console.log((cond ? 'OK  ' : 'FALHOU  ') + desc);
  if (!cond) falhas++;
}

/* ---- resolução de nome de pasta/arquivo do mês ---- */
const esp = logica.nomesEsperados(2026, 8);
check('nomesEsperados: pasta do mês ("08- Agosto")', esp.pastaMes === '08- Agosto');
check('nomesEsperados: arquivo do mês ("08 - Agosto_2026.xlsx")', esp.arquivo === '08 - Agosto_2026.xlsx');
check('pareceCorreto: nome exato bate', logica.pareceCorreto('08- Agosto', esp.nn, esp.nomeMes));
check('pareceCorreto: variação de espaçamento/pontuação bate', logica.pareceCorreto('08 -Agosto ', esp.nn, esp.nomeMes));
check('pareceCorreto: mês errado não bate', !logica.pareceCorreto('09- Setembro', esp.nn, esp.nomeMes));

/* ---- monta uma planilha "real" (com fórmulas e valor em cache, como o
   Excel/Planilhas Google sempre salvam) pra testar a edição ---- */
const dados = [
  ['MAPA DE MERENDA - AGOSTO/2026'],
  [],
  ['Gênero', 'Unidade de Medida', 'Estoque Anterior', 'Entrada', 'Total', 'Saída', 'Estoque Final'],
  ['ARROZ TIPO 1', 'kg', 20, 0, null, 0, null],
  ['FEIJÃO CARIOCA', 'kg', 10, 5, null, 2, null],
  ['ÓLEO DE SOJA', 'L', 8, 0, null, 0, null],
];
const ws = XLSX.utils.aoa_to_sheet(dados);
[3, 4, 5].forEach((r) => {
  const estAnterior = dados[r][2], entrada = dados[r][3], saida = dados[r][5];
  const total = estAnterior + entrada;
  ws['E' + (r + 1)] = { t: 'n', f: 'C' + (r + 1) + '+D' + (r + 1), v: total };
  ws['G' + (r + 1)] = { t: 'n', f: 'E' + (r + 1) + '-F' + (r + 1), v: total - saida };
});
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, 'MENSAL');
const bytesOriginais = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));

const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
const cab = logica.acharCabecalhoMensal(aoa);
check('acharCabecalhoMensal: achou a linha do cabeçalho', cab && cab.linhaCabecalho === 2);
check('acharCabecalhoMensal: coluna Gênero certa', cab && cab.genero === 0);
check('acharCabecalhoMensal: coluna Entrada certa', cab && cab.entrada === 3);
check('acharCabecalhoMensal: coluna Saída certa', cab && cab.saida === 5);

const resultado = logica.editarPlanilha(bytesOriginais, [
  { genero_planilha: 'Feijão Carioca', entrada_total: 12, saida_total: 3 }, // maiúscula/acento de propósito diferente
  { genero_planilha: 'ÓLEO DE SOJA', entrada_total: 6, saida_total: 0 },
  { genero_planilha: 'PRODUTO QUE NÃO EXISTE NA PLANILHA', entrada_total: 1, saida_total: 0 },
]);
check('editarPlanilha: 2 linhas atualizadas', resultado.linhasAtualizadas.length === 2);
check('editarPlanilha: 1 item sem correspondência, sem travar os outros', resultado.semCorrespondencia.length === 1);

const feijao = resultado.linhasAtualizadas.find((l) => /feij/i.test(l.genero_planilha));
check('Feijão: soma entrada 5(já tinha) + 12 = 17 (não sobrescreve)', feijao && feijao.entrada_na_celula === 17);
check('Feijão: soma saída 2(já tinha) + 3 = 5 (não sobrescreve)', feijao && feijao.saida_na_celula === 5);

const wb2 = XLSX.read(resultado.bytes, { type: 'array' });
const ws2 = wb2.Sheets['MENSAL'];
check('Fórmula de Total do Feijão continua intacta depois de salvar', ws2['E5'] && ws2['E5'].f === 'C5+D5');
check('Fórmula de Estoque Final do Óleo continua intacta depois de salvar', ws2['G6'] && ws2['G6'].f === 'E6-F6');
check('Arroz (sem movimentação nesta sync) fica intocado', ws2['D4'] && ws2['D4'].v === 0);

console.log('\n--- RESULTADO teste-logica sync-planilha ---');
console.log(falhas === 0 ? 'TODOS OS CHECKS PASSARAM' : (falhas + ' CHECK(S) FALHARAM'));
process.exit(falhas === 0 ? 0 : 1);
