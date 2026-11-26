/*
 * Núcleo da API do Compras, usado pela API REST (api/v1.js) e pelo webservice SOAP (api/soap.js):
 * banco (Redis da Upstash pela API REST), chaves por setor, filas para o Estoque e caixa de entrada.
 * Arquivos que começam com "_" não viram rota na Vercel.
 */
'use strict';
const crypto = require('crypto');

const LIMITE_CORPO = 1000000;
const MAX_LISTA = 2000;
const SETORES_VALIDOS = /^[a-z][a-z0-9-]{1,29}$/;

// --------------------------------------------------------------------------- Redis (Upstash REST)
// aceita qualquer prefixo que a integração da Vercel tenha usado (KV_, STORAGE_KV_, UPSTASH_REDIS_ ...)
function redisCfg(){
  const env = process.env;
  let url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL, token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    const k = Object.keys(env).find(n => /(KV_REST_API|REDIS_REST)_URL$/.test(n) && env[n.replace(/_URL$/, '_TOKEN')]);
    if (k) { url = env[k]; token = env[k.replace(/_URL$/, '_TOKEN')]; }
  }
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
async function exigirXml(req){ return checarXml(await lerCorpo(req)); }
function checarXml(bruto){
  const t = String(bruto || '').replace(/^\uFEFF/, '').trim();
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
  // namespace da própria raiz: xmlns:<prefixo> se ela tiver prefixo, senão o xmlns padrão
  const pref = m[1] ? m[1].slice(0, -1) : '';
  const ns = (m[3].match(pref ? new RegExp('\\sxmlns:' + pref.replace(/[.-]/g, '\\$&') + '="([^"]*)"') : /\sxmlns="([^"]*)"/) || [])[1] || '';
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
// Cache curto da autenticação (por instância): o plano grátis do Redis tem 500 mil comandos/mês.
// Revogar uma chave vale na hora nesta instância e em até 60 s nas outras.
const CACHE_AUTH_MS = 60000, cacheAuth = new Map(), ultimoUsoGravado = new Map();
async function setorDaChave(req){
  const m = String(req.headers.authorization || '').match(/^Bearer\s+(\S+)$/i);
  if (!m) return null;
  const h = sha(m[1]), c0 = cacheAuth.get(h);
  if (c0 && c0.exp > Date.now()) return c0.quem;
  const [admin, reg] = await pipeline([['GET', 'admin'], ['HGET', 'chaves', h]]);
  let quem = null;
  if (admin && admin === h) quem = { setor: 'painel', id: 'painel' };
  else if (reg) { const c = JSON.parse(reg); quem = { setor: c.setor, id: c.id, nome: c.nome }; }
  cacheAuth.set(h, { quem, exp: Date.now() + (quem ? CACHE_AUTH_MS : 5000) });
  if (cacheAuth.size > 500) cacheAuth.clear();
  return quem;
}
async function autenticar(req, permitidos){
  const quem = await setorDaChave(req);
  if (!quem) throw new ErroApi(401, 'Chave ausente ou inválida. Use Authorization: Bearer <chave do setor>.', { www: true });
  if (quem.setor !== 'painel' && !permitidos.includes(quem.setor)) throw new ErroApi(403, 'O setor "' + quem.setor + '" não usa esta rota ou operação.');
  req._quem = quem;
  return quem;
}


// --------------------------------------------------------------------------- filas e caixa de entrada (REST e SOAP)
async function listarPublicacoes(tipo, desde, limite){
  desde = Math.max(0, parseInt(desde, 10) || 0);
  limite = Math.min(200, Math.max(1, parseInt(limite, 10) || 50));
  const todos = (await redis('LRANGE', 'pub:' + tipo, 0, -1) || []).map(v => JSON.parse(v));
  const itens = todos.filter(i => i.seq > desde).slice(0, limite);
  return { tipo, desde, ultimo: itens.length ? itens[itens.length - 1].seq : desde, itens };
}
async function lerPublicacao(tipo, seq){
  const todos = (await redis('LRANGE', 'pub:' + tipo, 0, -1) || []).map(v => JSON.parse(v));
  const it = todos.find(i => i.seq === Number(seq));
  if (!it) throw new ErroApi(404, 'Publicação não encontrada.');
  return it;
}
// Grava o que um setor mandou na caixa de entrada. entrada = { xml } ou { aviso } (JSON do Finanweb).
async function gravarEntrada(quem, entrada, esperado){
  let tipo, formato = 'xml', conteudo, ref, chaveDup;
  if (entrada.aviso) {
    const a = entrada.aviso;
    const faltam = ['id', 'origem', 'referencia', 'situacao', 'valor'].filter(k => a[k] == null || a[k] === '');
    if (faltam.length) throw new ErroApi(422, 'avisoPagamento sem: ' + faltam.join(', ') + '.');
    if (!['PAGO', 'CANCELADO'].includes(a.situacao)) throw new ErroApi(422, 'situacao deve ser PAGO ou CANCELADO.');
    if (!(Number(a.valor) >= 0)) throw new ErroApi(422, 'valor deve ser número >= 0.');
    if (quem.setor !== 'painel' && !ENTRADA['aviso-pagamento'].setores.includes(quem.setor)) throw new ErroApi(403, 'O setor "' + quem.setor + '" não envia aviso-pagamento.');
    tipo = 'aviso-pagamento'; formato = 'json'; conteudo = JSON.stringify(a); ref = String(a.referencia); chaveDup = 'id:' + a.id;
  } else {
    conteudo = checarXml(entrada.xml);
    const raiz = raizXml(conteudo);
    tipo = Object.keys(ENTRADA).find(t => ENTRADA[t].teste(raiz));
    if (!tipo) throw new ErroApi(422, 'XML não reconhecido: a raiz <' + raiz.nome + '> não é um contrato que o Compras recebe.', { aceitos: Object.keys(ENTRADA) });
    if (esperado && tipo !== esperado) throw new ErroApi(422, 'Esta operação recebe ' + esperado + ', mas o XML é ' + tipo + '. Use a entrada genérica (POST /api/v1/mensagens ou EnviarMensagem).');
    if (quem.setor !== 'painel' && !ENTRADA[tipo].setores.includes(quem.setor)) throw new ErroApi(403, 'O setor "' + quem.setor + '" não envia ' + tipo + '.');
    ref = refXml(conteudo); chaveDup = sha(conteudo);
  }
  const dup = await redis('HGET', 'msghash', tipo + ':' + chaveDup);
  if (dup) return { seq: Number(dup), tipo, duplicada: true };
  const seq = await redis('INCR', 'seq:caixa');
  const item = { seq, tipo, formato, de: quem.setor, referencia: ref, recebidoEm: agora(), conteudo };
  await pipeline([['RPUSH', 'caixa', JSON.stringify(item)], ['LTRIM', 'caixa', -MAX_LISTA, -1], ['HSET', 'msghash', tipo + ':' + chaveDup, String(seq)]]);
  return { seq, tipo, duplicada: false };
}
// Log de acessos (só gravações, erros e leituras com itens) e último uso de cada chave (no máximo a cada 5 min)
async function registrarAcesso(req, status, rota){
  const q = req._quem; if (!q) return;
  try {
    const cmds = [];
    if (req.method !== 'GET' || status >= 400 || req._comItens)
      cmds.push(['LPUSH', 'acessos', JSON.stringify({ em: agora(), setor: q.setor, chave: q.id, metodo: req._metodoLog || req.method, rota, status })], ['LTRIM', 'acessos', 0, 499]);
    if (q.setor !== 'painel' && (Date.now() - (ultimoUsoGravado.get(q.id) || 0)) > 300000) {
      ultimoUsoGravado.set(q.id, Date.now()); cmds.push(['HSET', 'usos', q.id, agora()]);
    }
    if (cmds.length) await pipeline(cmds);
  } catch (e) {}
}

module.exports = { LIMITE_CORPO, MAX_LISTA, SETORES_VALIDOS, redis, pipeline, ErroApi, sha, agora, novaChave, cors, json, xmlResp,
  lerCorpo, tipoConteudo, exigirJson, exigirXml, checarXml, raizXml, refXml, ENTRADA, ROTA_ENTRADA, PUBLICACAO, ROTA_PUB,
  cacheAuth, setorDaChave, autenticar, listarPublicacoes, lerPublicacao, gravarEntrada, registrarAcesso };
