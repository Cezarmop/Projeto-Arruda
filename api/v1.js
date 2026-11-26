/*
 * API REST do Compras (Vercel Function, Node, sem dependências).
 * Mesmas rotas e respostas da API PHP do Projeto-Arruda (public_html/compras/api), para o Estoque e o
 * Financeiro integrarem do mesmo jeito.
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
const crypto = require('crypto');

const LIMITE_CORPO = 1000000;
const MAX_LISTA = 2000;
const SETORES_VALIDOS = /^[a-z][a-z0-9-]{1,29}$/;

// --------------------------------------------------------------------------- Redis (Upstash REST)
function redisCfg(){
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new ErroApi(503, 'Banco não configurado: conecte um Redis (Upstash) ao projeto na Vercel.');
  return { url: url.replace(/\/+$/, ''), token };
}
async function redis(...cmd){
  const { url, token } = redisCfg();
  const r = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new ErroApi(503, 'Erro no banco: ' + (j.error || r.status));
  return j.result;
}
async function pipeline(cmds){
  const { url, token } = redisCfg();
  const r = await fetch(url + '/pipeline', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(cmds) });
  const j = await r.json().catch(() => []);
  if (!r.ok) throw new ErroApi(503, 'Erro no banco: ' + r.status);
  return j.map(x => x.result);
}

// --------------------------------------------------------------------------- utilitários
class ErroApi extends Error { constructor(status, msg, extra){ super(msg); this.status = status; this.extra = extra || {}; } }
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const agora = () => new Date().toISOString();
const novaChave = () => crypto.randomBytes(24).toString('hex');

function cors(res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept');
  res.setHeader('Access-Control-Max-Age', '86400');
}
function json(res, status, corpo){ res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(corpo)); }
function xmlResp(res, status, corpo){ res.statusCode = status; res.setHeader('Content-Type', 'application/xml; charset=utf-8'); res.end(corpo); }

async function lerCorpo(req){
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  if (req.body && typeof req.body === 'object') return JSON.stringify(req.body);
  const partes = []; let tam = 0;
  for await (const p of req) { tam += p.length; if (tam > LIMITE_CORPO) throw new ErroApi(413, 'Corpo maior que ' + LIMITE_CORPO + ' bytes.'); partes.push(p); }
  return Buffer.concat(partes).toString('utf8');
}
const tipoConteudo = req => String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
async function exigirJson(req){
  const t = await lerCorpo(req);
  try { const o = JSON.parse(t || ''); if (o && typeof o === 'object') return o; } catch (e) {}
  throw new ErroApi(400, 'Corpo deve ser um objeto JSON.');
}
async function exigirXml(req){
  const t = String(await lerCorpo(req) || '').replace(/^﻿/, '').trim();
  if (!t) throw new ErroApi(400, 'Envie o XML no corpo (Content-Type: application/xml).');
  if (t.length > LIMITE_CORPO) throw new ErroApi(413, 'XML grande demais.');
  if (/<!DOCTYPE|<!ENTITY/i.test(t)) throw new ErroApi(422, 'XML com DTD ou entidades não é aceito.');
  if (!/^(<\?xml[^>]*\?>\s*)?<[A-Za-z_]/.test(t)) throw new ErroApi(422, 'O corpo não é um XML.');
  return t;
}

// raiz e namespace do XML (sem parser completo: o app valida o conteúdo ao aplicar)
function raizXml(x){
  const semCab = x.replace(/^<\?xml[^>]*\?>\s*/, '').replace(/^(<!--[\s\S]*?-->\s*)+/, '');
  const m = semCab.match(/^<([A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)([^>]*)>/);
  if (!m) throw new ErroApi(422, 'XML mal formado.');
  const ns = (m[3].match(/\sxmlns(?::[\w.-]+)?="([^"]*)"/) || [])[1] || '';
  return { nome: m[2], ns };
}
const refXml = x => ((x.match(/referencia="([^"]{1,100})"/) || x.match(/<idConsulta>([^<]{1,100})</) || x.match(/<lote_id>([^<]{1,100})</) || x.match(/\bid="([^"]{1,100})"/) || [])[1] || '');

// tipos que o Compras recebe e quem pode enviar cada um
const ENTRADA = {
  'confirmacao-recebimento': { setores: ['estoque'], teste: r => r.nome === 'confirmacaoRecebimento' && r.ns === 'urn:compras:confirmacao-recebimento:1.0' },
  'resposta-disponibilidade': { setores: ['estoque'], teste: r => r.nome === 'respostaDisponibilidade' },
  'saldo-estoque': { setores: ['estoque'], teste: r => r.nome === 'estoque' },
  'aviso-pagamento': { setores: ['financeiro'], teste: r => r.nome === 'avisoPagamento' && r.ns === 'urn:finanweb:aviso-pagamento:1.0' },
  'resposta-pendencias': { setores: ['financeiro'], teste: r => r.nome === 'respostaPendencias' && r.ns === 'urn:finanweb:pendencias-fornecedor:1.0' },
};
const ROTA_ENTRADA = { 'confirmacoes-recebimento': 'confirmacao-recebimento', 'respostas-disponibilidade': 'resposta-disponibilidade',
  'saldos-estoque': 'saldo-estoque', 'avisos-pagamento': 'aviso-pagamento', 'respostas-pendencias': 'resposta-pendencias' };
// publicações que o Compras deixa para o Estoque buscar
const PUBLICACAO = {
  'recebimento': { rota: 'recebimentos', teste: r => r.nome === 'movimento' && r.ns === 'urn:compras:recebimento:1.0' },
  'previsao-entrega': { rota: 'previsoes-entrega', teste: r => r.nome === 'movimento' && r.ns === 'urn:compras:previsao-entrega:1.0' },
  'consulta-disponibilidade': { rota: 'consultas-disponibilidade', teste: r => r.nome === 'consultaDisponibilidade' },
};
const ROTA_PUB = Object.fromEntries(Object.entries(PUBLICACAO).map(([t, c]) => [c.rota, t]));

// --------------------------------------------------------------------------- autenticação
async function setorDaChave(req){
  const m = String(req.headers.authorization || '').match(/^Bearer\s+(\S+)$/i);
  if (!m) return null;
  const h = sha(m[1]);
  const [admin, reg] = await pipeline([['GET', 'admin'], ['HGET', 'chaves', h]]);
  if (admin && admin === h) return { setor: 'painel', id: 'painel' };
  if (reg) { const c = JSON.parse(reg); return { setor: c.setor, id: c.id, nome: c.nome }; }
  return null;
}
async function autenticar(req, permitidos){
  const quem = await setorDaChave(req);
  if (!quem) throw new ErroApi(401, 'Chave ausente ou inválida. Use Authorization: Bearer <chave do setor>.', { www: true });
  if (quem.setor !== 'painel' && !permitidos.includes(quem.setor)) throw new ErroApi(403, 'O setor "' + quem.setor + '" não usa esta rota.');
  req._quem = quem;
  return quem;
}

// --------------------------------------------------------------------------- rotas
const ROTAS = [
  ['GET', 'v1', rIndice, 'Lista as rotas', 'livre'],
  ['GET', 'v1/saude', rSaude, 'Estado da API e do banco', 'livre'],
  ['POST', 'v1/admin/setup', rSetup, 'Cria a chave de administrador (só uma vez)', 'livre'],
  ['GET', 'v1/chaves', rListarChaves, 'Lista as chaves dos setores (sem a chave)', 'painel'],
  ['POST', 'v1/chaves', rCriarChave, 'Cria a chave de um setor; a chave aparece só nesta resposta', 'painel'],
  ['DELETE', 'v1/chaves/{id}', rRevogarChave, 'Revoga uma chave', 'painel'],
  ['GET', 'v1/acessos', rAcessos, 'Últimos acessos com chave', 'painel'],
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
  const todas = await redis('HVALS', 'chaves') || [];
  const lista = todas.map(v => JSON.parse(v)).sort((a, b) => a.criadaEm.localeCompare(b.criadaEm))
    .map(c => ({ id: c.id, setor: c.setor, nome: c.nome, prefixo: c.prefixo, criadaEm: c.criadaEm, ultimoUso: c.ultimoUso || null }));
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
    if (c.id === p.id) { await redis('HDEL', 'chaves', todas[i]); return json(res, 200, { ok: true, revogada: c.id, setor: c.setor }); }
  }
  throw new ErroApi(404, 'Chave não encontrada.');
}
async function rAcessos(req, res){
  await autenticar(req, []);
  const l = await redis('LRANGE', 'acessos', 0, 199) || [];
  json(res, 200, { acessos: l.map(x => JSON.parse(x)) });
}

async function rPublicar(req, res){
  await autenticar(req, []);
  const d = await exigirJson(req);
  const tipo = String(d.tipo || '');
  if (!PUBLICACAO[tipo]) throw new ErroApi(422, 'tipo deve ser: ' + Object.keys(PUBLICACAO).join(', ') + '.');
  const x = String(d.xml || '').replace(/^﻿/, '').trim();
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
  const tipo = ROTA_PUB[p._base];
  const desde = Math.max(0, parseInt(req.query.desde, 10) || 0);
  const limite = Math.min(200, Math.max(1, parseInt(req.query.limite, 10) || 50));
  const todos = (await redis('LRANGE', 'pub:' + tipo, 0, -1) || []).map(v => JSON.parse(v));
  const itens = todos.filter(i => i.seq > desde).slice(0, limite);
  json(res, 200, { tipo, desde, ultimo: itens.length ? itens[itens.length - 1].seq : desde, itens });
}
async function rLerPub(req, res, p){
  await autenticar(req, ['estoque']);
  const tipo = ROTA_PUB[p._base], seq = parseInt(p.seq, 10);
  const todos = (await redis('LRANGE', 'pub:' + tipo, 0, -1) || []).map(v => JSON.parse(v));
  const it = todos.find(i => i.seq === seq);
  if (!it) throw new ErroApi(404, 'Publicação não encontrada.');
  xmlResp(res, 200, it.xml);
}

async function rReceber(req, res, p){
  const esperado = ROTA_ENTRADA[p._base] || null;
  const quem = await autenticar(req, esperado ? ENTRADA[esperado].setores : ['estoque', 'financeiro']);
  let tipo, formato = 'xml', conteudo, ref, chaveDup;
  if (esperado === 'aviso-pagamento' && tipoConteudo(req) === 'application/json') {
    const a = await exigirJson(req);
    const faltam = ['id', 'origem', 'referencia', 'situacao', 'valor'].filter(k => a[k] == null || a[k] === '');
    if (faltam.length) throw new ErroApi(422, 'avisoPagamento sem: ' + faltam.join(', ') + '.');
    if (!['PAGO', 'CANCELADO'].includes(a.situacao)) throw new ErroApi(422, 'situacao deve ser PAGO ou CANCELADO.');
    if (!(Number(a.valor) >= 0)) throw new ErroApi(422, 'valor deve ser número >= 0.');
    tipo = 'aviso-pagamento'; formato = 'json'; conteudo = JSON.stringify(a); ref = String(a.referencia); chaveDup = 'id:' + a.id;
  } else {
    conteudo = await exigirXml(req);
    const raiz = raizXml(conteudo);
    tipo = Object.keys(ENTRADA).find(t => ENTRADA[t].teste(raiz));
    if (!tipo) throw new ErroApi(422, 'XML não reconhecido: a raiz <' + raiz.nome + '> não é um contrato que o Compras recebe.', { aceitos: Object.keys(ENTRADA) });
    if (esperado && tipo !== esperado) throw new ErroApi(422, 'Esta rota recebe ' + esperado + ', mas o XML é ' + tipo + '. Use POST /api/v1/mensagens.');
    if (quem.setor !== 'painel' && !ENTRADA[tipo].setores.includes(quem.setor)) throw new ErroApi(403, 'O setor "' + quem.setor + '" não envia ' + tipo + '.');
    ref = refXml(conteudo); chaveDup = sha(conteudo);
  }
  const dup = await redis('HGET', 'msghash', tipo + ':' + chaveDup);
  if (dup) return json(res, 200, { ok: true, seq: Number(dup), tipo, duplicada: true, mensagem: 'Mensagem já recebida antes; nada mudou.' });
  const seq = await redis('INCR', 'seq:caixa');
  const item = { seq, tipo, formato, de: quem.setor, referencia: ref, recebidoEm: agora(), conteudo };
  await pipeline([['RPUSH', 'caixa', JSON.stringify(item)], ['LTRIM', 'caixa', -MAX_LISTA, -1], ['HSET', 'msghash', tipo + ':' + chaveDup, String(seq)]]);
  json(res, 202, { ok: true, seq, tipo, duplicada: false, mensagem: 'Recebida. O Compras aplica na próxima leitura da caixa de entrada.' });
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
async function registrarAcesso(req, status, caminho){
  const q = req._quem; if (!q) return;
  try {
    const cmds = [['LPUSH', 'acessos', JSON.stringify({ em: agora(), setor: q.setor, chave: q.id, metodo: req.method, rota: '/api/' + caminho, status })], ['LTRIM', 'acessos', 0, 499]];
    if (q.setor !== 'painel') {
      const todas = await redis('HGETALL', 'chaves') || [];
      for (let i = 0; i < todas.length; i += 2) { const c = JSON.parse(todas[i + 1]); if (c.id === q.id) { c.ultimoUso = agora(); cmds.push(['HSET', 'chaves', todas[i], JSON.stringify(c)]); } }
    }
    await pipeline(cmds);
  } catch (e) {}
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
  if (caminho !== 'v1/caixa-entrada' && caminho !== 'v1/acessos') await registrarAcesso(req, status, caminho);
};
