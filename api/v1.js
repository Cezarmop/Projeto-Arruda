/*
 * API REST do Compras (Vercel Function, Node, sem dependências).
 * Rotas que o Estoque e o Financeiro usam para integrar com o Compras (lista em GET /api/v1).
 *
 * Banco: Redis da Upstash pela API REST. Variáveis de ambiente (criadas pela integração da Vercel):
 *   KV_REST_API_URL + KV_REST_API_TOKEN   ou   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
 *
 * Autenticação: Authorization: Bearer <chave>. Cada chave pertence a um setor (estoque, financeiro, ...).
 * O "painel" é a chave de administrador da tela do Compras: criada uma única vez em POST /v1/admin/setup.
 * As chaves são guardadas só como hash SHA-256; a chave em si aparece uma vez, na criação.
 *
 * Todas as rotas chegam aqui pelo rewrite do vercel.json: /api/v1/<caminho> -> /api/v1?caminho=<caminho>
 */
'use strict';
const { MAX_LISTA, SETORES_VALIDOS, redis, pipeline, ErroApi, sha, agora, novaChave, cors, json, xmlResp, exigirJson, exigirXml,
  tipoConteudo, raizXml, refXml, ENTRADA, ROTA_ENTRADA, PUBLICACAO, ROTA_PUB, cacheAuth, autenticar,
  listarPublicacoes, lerPublicacao, gravarEntrada, registrarAcesso } = require('./_nucleo');

// --------------------------------------------------------------------------- rotas
const ROTAS = [
  ['GET', 'v1', rIndice, 'Lista as rotas', 'livre'],
  ['GET', 'v1/saude', rSaude, 'Estado da API e do banco', 'livre'],
  ['POST', 'v1/admin/setup', rSetup, 'Cria a chave de administrador (só uma vez)', 'livre'],
  ['GET', 'v1/chaves', rListarChaves, 'Lista as chaves dos setores (sem a chave)', 'painel'],
  ['POST', 'v1/chaves', rCriarChave, 'Cria a chave de um setor; a chave aparece só nesta resposta', 'painel'],
  ['DELETE', 'v1/chaves/{id}', rRevogarChave, 'Revoga uma chave', 'painel'],
  ['GET', 'v1/acessos', rAcessos, 'Últimos acessos com chave', 'painel'],
  ['GET', 'v1/config', rLerConfig, 'Configuração do painel (chaves das APIs externas, empresa)', 'painel'],
  ['POST', 'v1/config', rGravarConfig, 'Grava a configuração do painel', 'painel'],
  ['GET', 'v1/dados', rLerDados, 'Dados do sistema (pedidos, fornecedores, movimentações...) com a versão', 'painel'],
  ['PUT', 'v1/dados', rGravarDados, 'Grava os dados; recusa com 409 se a versão base não for a atual', 'painel'],
  ['POST', 'v1/publicacoes', rPublicar, 'Publica recebimento, previsão ou consulta para o Estoque', 'painel'],
  ['GET', 'v1/caixa-entrada', rCaixaEntrada, 'Mensagens recebidas dos setores (?desde=seq)', 'painel'],
  ['POST', 'v1/mensagens', rReceber, 'Recebe qualquer XML suportado (tipo pela raiz/namespace)', 'estoque, financeiro'],
  ['POST', 'v1/confirmacoes-recebimento', rReceber, 'confirmacao-recebimento-v1', 'estoque'],
  ['POST', 'v1/respostas-disponibilidade', rReceber, 'respostaDisponibilidade', 'estoque'],
  ['POST', 'v1/saldos-estoque', rReceber, 'Saldo no XML v2 do Estoque', 'estoque'],
  ['POST', 'v1/avisos-pagamento', rReceber, 'avisoPagamento, XML ou JSON do Finanweb', 'financeiro'],
  ['POST', 'v1/respostas-pendencias', rReceber, 'respostaPendencias', 'financeiro'],
  ['GET', 'v1/recebimentos', rListarPub, 'recebimento-v1 publicados (?desde=seq)', 'estoque'],
  ['GET', 'v1/recebimentos/{seq}', rLerPub, 'Um recebimento-v1 em XML', 'estoque'],
  ['GET', 'v1/previsoes-entrega', rListarPub, 'previsao-entrega-v1 publicadas (?desde=seq)', 'estoque'],
  ['GET', 'v1/previsoes-entrega/{seq}', rLerPub, 'Uma previsao-entrega-v1 em XML', 'estoque'],
  ['GET', 'v1/consultas-disponibilidade', rListarPub, 'consultaDisponibilidade publicadas (?desde=seq)', 'estoque'],
  ['GET', 'v1/consultas-disponibilidade/{seq}', rLerPub, 'Uma consultaDisponibilidade em XML', 'estoque'],
];

async function rIndice(req, res){
  json(res, 200, { api: 'Compras', versao: '1', autenticacao: 'Authorization: Bearer <chave do setor>',
    rotas: ROTAS.map(r => ({ metodo: r[0], caminho: '/api/' + r[1], descricao: r[3], quem: r[4] })) });
}
async function rSaude(req, res){
  let banco = 'ok', admin = false, setores = [];
  try {
    const [a, todas] = await pipeline([['GET', 'admin'], ['HVALS', 'chaves']]);
    admin = !!a; setores = [...new Set((todas || []).map(v => JSON.parse(v).setor))];
  } catch (e) { banco = e.message; }
  json(res, 200, { ok: banco === 'ok', banco, adminConfigurado: admin, setoresComChave: setores, em: agora() });
}
async function rSetup(req, res){
  const chave = novaChave();
  const ok = await redis('SET', 'admin', sha(chave), 'NX');
  if (ok !== 'OK') throw new ErroApi(409, 'A chave de administrador já foi criada.');
  json(res, 201, { ok: true, chave, aviso: 'Guarde esta chave: ela não aparece de novo.' });
}
async function rListarChaves(req, res){
  await autenticar(req, []);
  const [todas, usosL] = await pipeline([['HVALS', 'chaves'], ['HGETALL', 'usos']]);
  const usos = {}; for (let i = 0; i < (usosL || []).length; i += 2) usos[usosL[i]] = usosL[i + 1];
  const lista = (todas || []).map(v => JSON.parse(v)).sort((a, b) => a.criadaEm.localeCompare(b.criadaEm))
    .map(c => ({ id: c.id, setor: c.setor, nome: c.nome, prefixo: c.prefixo, criadaEm: c.criadaEm, ultimoUso: usos[c.id] || c.ultimoUso || null }));
  json(res, 200, { chaves: lista });
}
async function rCriarChave(req, res){
  await autenticar(req, []);
  const d = await exigirJson(req);
  const setor = String(d.setor || '').trim().toLowerCase();
  if (!SETORES_VALIDOS.test(setor) || setor === 'painel') throw new ErroApi(422, 'setor inválido: use letras minúsculas, dígitos e hífen (ex.: estoque).');
  const nome = String(d.nome || setor).trim().slice(0, 80);
  const chave = novaChave(), h = sha(chave);
  const reg = { id: h.slice(0, 12), setor, nome, prefixo: chave.slice(0, 6), criadaEm: agora() };
  await redis('HSET', 'chaves', h, JSON.stringify(reg));
  json(res, 201, { ok: true, ...reg, chave, aviso: 'Entregue esta chave ao setor por canal privado. Ela não aparece de novo.' });
}
async function rRevogarChave(req, res, p){
  await autenticar(req, []);
  const todas = await redis('HGETALL', 'chaves') || [];
  for (let i = 0; i < todas.length; i += 2) {
    const c = JSON.parse(todas[i + 1]);
    if (c.id === p.id) { await redis('HDEL', 'chaves', todas[i]); cacheAuth.clear(); return json(res, 200, { ok: true, revogada: c.id, setor: c.setor }); }
  }
  throw new ErroApi(404, 'Chave não encontrada.');
}
async function rAcessos(req, res){
  await autenticar(req, []);
  const l = await redis('LRANGE', 'acessos', 0, 199) || [];
  json(res, 200, { acessos: l.map(x => JSON.parse(x)) });
}

// configuração do painel: só a chave de administrador lê e grava (ex.: chave do Finanweb, chave do Estoque, dados da empresa)
const CONFIG_PERMITIDA = { fin: ['url', 'chave', 'auto', 'autoEnvio'], estoque: ['apiUrl', 'apiKey', 'autoSaldo', 'autoSaldoMin'], config: ['empresa', 'cnpj', 'usuario'] };
async function rLerConfig(req, res){
  await autenticar(req, []);
  const v = await redis('GET', 'painel:config');
  json(res, 200, { config: v ? JSON.parse(v) : {} });
}
async function rGravarConfig(req, res){
  await autenticar(req, []);
  const d = await exigirJson(req);
  const atual = JSON.parse(await redis('GET', 'painel:config') || '{}');
  for (const [grupo, campos] of Object.entries(CONFIG_PERMITIDA)) {
    if (!d[grupo] || typeof d[grupo] !== 'object') continue;
    atual[grupo] = atual[grupo] || {};
    for (const c of campos) if (c in d[grupo]) atual[grupo][c] = typeof d[grupo][c] === 'string' ? d[grupo][c].slice(0, 300) : d[grupo][c];
  }
  atual.atualizadoEm = agora();
  await redis('SET', 'painel:config', JSON.stringify(atual));
  json(res, 200, { ok: true, atualizadoEm: atual.atualizadoEm });
}

// dados do sistema compartilhados entre computadores: um documento JSON com versão (controle otimista)
const GRAVA_DADOS = `local v = tonumber(redis.call('GET', KEYS[1]) or '0')
if v ~= tonumber(ARGV[1]) then return {0, v} end
redis.call('SET', KEYS[2], ARGV[2]); redis.call('SET', KEYS[3], ARGV[3]); redis.call('SET', KEYS[1], v + 1)
return {1, v + 1}`;
async function rLerDados(req, res){
  await autenticar(req, []);
  // ?desde=N: se a versão ainda for N, responde só a versão (1 comando no banco em vez de 3)
  const desde = req.query && req.query.desde != null ? Number(req.query.desde) : NaN;
  if (Number.isInteger(desde)) {
    const atual = Number(await redis('GET', 'dados:versao') || 0);
    if (atual === desde) return json(res, 200, { versao: atual, igual: true });
  }
  const [v, d, em] = await pipeline([['GET', 'dados:versao'], ['GET', 'dados'], ['GET', 'dados:em']]);
  json(res, 200, { versao: Number(v || 0), atualizadoEm: em || null, dados: d ? JSON.parse(d) : null });
}
async function rGravarDados(req, res){
  await autenticar(req, []);
  const corpo = await exigirJson(req);
  if (!corpo.dados || typeof corpo.dados !== 'object' || Array.isArray(corpo.dados)) throw new ErroApi(422, 'Envie { base, dados }.');
  const base = Number(corpo.base);
  if (!Number.isInteger(base) || base < 0) throw new ErroApi(422, 'base deve ser a versão lida (número inteiro).');
  const em = agora();
  const [ok, versao] = await redis('EVAL', GRAVA_DADOS, '3', 'dados:versao', 'dados', 'dados:em', String(base), JSON.stringify(corpo.dados), em);
  if (!ok) return json(res, 409, { ok: false, erro: 'Os dados mudaram em outro computador. Leia de novo e junte as mudanças.', versao: Number(versao) });
  json(res, 200, { ok: true, versao: Number(versao), atualizadoEm: em });
}

async function rPublicar(req, res){
  await autenticar(req, []);
  const d = await exigirJson(req);
  const tipo = String(d.tipo || '');
  if (!PUBLICACAO[tipo]) throw new ErroApi(422, 'tipo deve ser: ' + Object.keys(PUBLICACAO).join(', ') + '.');
  const x = String(d.xml || '').replace(/^\uFEFF/, '').trim();
  if (!x) throw new ErroApi(422, 'Informe o xml.');
  if (!PUBLICACAO[tipo].teste(raizXml(x))) throw new ErroApi(422, 'O XML não é um ' + tipo + '.');
  const h = sha(x);
  const existente = await redis('HGET', 'pubhash:' + tipo, h);
  if (existente) return json(res, 200, { ok: true, seq: Number(existente), duplicada: true });
  const seq = await redis('INCR', 'seq:pub:' + tipo);
  const item = { seq, referencia: String(d.referencia || refXml(x)).slice(0, 100), publicadoEm: agora(), xml: x };
  await pipeline([['RPUSH', 'pub:' + tipo, JSON.stringify(item)], ['LTRIM', 'pub:' + tipo, -MAX_LISTA, -1], ['HSET', 'pubhash:' + tipo, h, String(seq)]]);
  json(res, 201, { ok: true, seq, duplicada: false });
}
async function rListarPub(req, res, p){
  await autenticar(req, ['estoque']);
  const r = await listarPublicacoes(ROTA_PUB[p._base], req.query.desde, req.query.limite);
  if (r.itens.length) req._comItens = true;
  json(res, 200, r);
}
async function rLerPub(req, res, p){
  await autenticar(req, ['estoque']);
  xmlResp(res, 200, (await lerPublicacao(ROTA_PUB[p._base], p.seq)).xml);
}

async function rReceber(req, res, p){
  const esperado = ROTA_ENTRADA[p._base] || null;
  const quem = await autenticar(req, esperado ? ENTRADA[esperado].setores : ['estoque', 'financeiro']);
  const entrada = (esperado === 'aviso-pagamento' && tipoConteudo(req) === 'application/json') ? { aviso: await exigirJson(req) } : { xml: await exigirXml(req) };
  const r = await gravarEntrada(quem, entrada, esperado);
  json(res, r.duplicada ? 200 : 202, { ok: true, seq: r.seq, tipo: r.tipo, duplicada: r.duplicada,
    mensagem: r.duplicada ? 'Mensagem já recebida antes; nada mudou.' : 'Recebida. O Compras aplica na próxima leitura da caixa de entrada.' });
}
async function rCaixaEntrada(req, res){
  await autenticar(req, []);
  const desde = Math.max(0, parseInt(req.query.desde, 10) || 0);
  const todos = (await redis('LRANGE', 'caixa', 0, -1) || []).map(v => JSON.parse(v));
  const itens = todos.filter(i => i.seq > desde).slice(0, 100);
  json(res, 200, { desde, ultimo: itens.length ? itens[itens.length - 1].seq : desde, itens });
}

// --------------------------------------------------------------------------- despacho
function casar(metodo, caminho){
  for (const r of ROTAS) {
    if (r[0] !== metodo) continue;
    const pa = r[1].split('/'), pc = caminho.split('/');
    if (pa.length !== pc.length) continue;
    const p = {}; let ok = true;
    for (let i = 0; i < pa.length; i++) {
      if (pa[i].startsWith('{')) { if (!/^[\w-]{1,40}$/.test(pc[i])) { ok = false; break; } p[pa[i].slice(1, -1)] = pc[i]; }
      else if (pa[i] !== pc[i]) { ok = false; break; }
    }
    if (ok) { p._base = pa[1]; return { fn: r[2], p }; }
  }
  return null;
}
module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  const bruto = String((req.query && req.query.caminho) || '').replace(/^\/+|\/+$/g, '');
  const caminho = 'v1' + (bruto ? '/' + bruto : '');
  let status = 500;
  try {
    const rota = casar(req.method, caminho);
    if (!rota) {
      const existe = ROTAS.some(r => casar(r[0], caminho) && r[0] !== req.method);
      throw new ErroApi(existe ? 405 : 404, existe ? 'Método não permitido nesta rota.' : 'Rota não encontrada. GET /api/v1 lista as rotas.');
    }
    await rota.fn(req, res, rota.p);
    status = res.statusCode;
  } catch (e) {
    status = e instanceof ErroApi ? e.status : 500;
    if (e.extra && e.extra.www) res.setHeader('WWW-Authenticate', 'Bearer');
    json(res, status, { ok: false, erro: e instanceof ErroApi ? e.message : 'Erro interno.', ...(e.extra && e.extra.aceitos ? { aceitos: e.extra.aceitos } : {}) });
    if (!(e instanceof ErroApi)) console.error(e);
  }
  if (caminho !== 'v1/caixa-entrada' && caminho !== 'v1/acessos') await registrarAcesso(req, status, '/api/' + caminho);
};
