/*
 * Webservice SOAP do Compras no padrão de interoperabilidade da turma (mesmo modelo do VendasWebService):
 *   Endereço: /api/soap/v1/compras            WSDL: /api/soap/v1/compras?wsdl
 *   Namespace: urn:interoperabilidade:compras:soap:v1      SOAPAction: "urn:interoperabilidade:compras:soap:v1#<Operacao>"
 *   SOAP 1.1, document/literal, parâmetros simples; toda resposta é <Operacao>Response com codigo, mensagem e dadosJson.
 *   Chave do setor no cabeçalho HTTP: Authorization: Bearer <chave> (a mesma da API REST). ConsultarSaude é livre.
 *
 * codigo (o HTTP é 200 sempre que há <...Response>; envelope ilegível ou operação inexistente viram soap:Fault, HTTP 500):
 *   200 consulta ok, ou mensagem já recebida antes      202 recebida para o Compras aplicar
 *   400 parâmetro ausente ou inválido     401 sem chave ou chave inválida     403 operação de outro setor
 *   404 não encontrado     422 fora do contrato     500 erro interno     503 banco fora do ar
 *
 * Os envios montam o mesmo XML dos contratos (contratos/*.xsd) e entram na mesma caixa de entrada da API REST e do
 * SOAP anterior (/api/soap, que continua funcionando); as listagens leem as mesmas filas.
 */
'use strict';
const { ErroApi, redis, pipeline, agora, cors, lerCorpo, checarXml, ENTRADA, autenticar, listarPublicacoes, gravarEntrada, registrarAcesso } = require('./_nucleo');

const NS = 'urn:interoperabilidade:compras:soap:v1';
const NS_SOAP = 'http://schemas.xmlsoap.org/soap/envelope/';
const xesc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const desfaz = v => String(v).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&(lt|gt|quot|apos|amp|#(\d+)|#x([0-9a-f]+));/gi,
  (m, n, d, h) => d ? String.fromCodePoint(+d) : h ? String.fromCodePoint(parseInt(h, 16)) : ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' }[n.toLowerCase()]));
const hojeBR = () => new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
const RE_DIA = /^\d{4}-\d{2}-\d{2}$/;
const skuNorm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

// ---------------------------------------------------------------------------- operações e parâmetros (para o WSDL)
// [nome, tipo XSD, obrigatório]
const P = (n, t = 'xs:string', obr = true) => ({ n, t, obr });
const OPS = {
  ConsultarSaude:              { livre: true, params: [] },
  ConsultarPedido:             { setores: ['estoque', 'financeiro'], params: [P('idPedido')] },
  ConsultarStatusPedido:       { setores: ['estoque', 'financeiro'], params: [P('idPedido')] },
  ConsultarSolicitacao:        { setores: ['estoque'], params: [P('idSolicitacao')] },
  ListarRecebimentos:          { setores: ['estoque'], lista: 'recebimento', params: [P('desde', 'xs:int', false), P('limite', 'xs:int', false)] },
  ListarPrevisoesEntrega:      { setores: ['estoque'], lista: 'previsao-entrega', params: [P('desde', 'xs:int', false), P('limite', 'xs:int', false)] },
  ListarConsultasDisponibilidade: { setores: ['estoque'], lista: 'consulta-disponibilidade', params: [P('desde', 'xs:int', false), P('limite', 'xs:int', false)] },
  ListarRespostasSolicitacao:  { setores: ['estoque'], lista: 'resposta-solicitacao', params: [P('desde', 'xs:int', false), P('limite', 'xs:int', false)] },
  EnviarSolicitacaoCompra:     { setores: ['estoque'], params: [P('idSolicitacao'), P('sku'), P('produto'), P('quantidade', 'xs:int'), P('motivo'),
    P('prioridade', 'xs:string', false), P('dataNecessidade', 'xs:date', false), P('observacao', 'xs:string', false), P('saldoAtual', 'xs:int', false), P('estoqueMinimo', 'xs:int', false)] },
  ConfirmarRecebimento:        { setores: ['estoque'], params: [P('referencia'), P('status'), P('sku', 'xs:string', false), P('quantidadeInformada', 'xs:int', false),
    P('quantidadeContada', 'xs:int', false), P('mensagem', 'xs:string', false)] },
  ResponderDisponibilidade:    { setores: ['estoque'], params: [P('idConsulta'), P('produtoCodigo'), P('nome', 'xs:string', false), P('quantidadeDisponivel', 'xs:int', false), P('erro', 'xs:string', false)] },
  EnviarAvisoPagamento:        { setores: ['financeiro'], params: [P('idAviso'), P('referencia'), P('situacao'), P('valor', 'xs:decimal'), P('dataPagamento', 'xs:date', false)] },
  EnviarMensagem:              { setores: ['estoque', 'financeiro'], params: [P('xml')] },
};

// ---------------------------------------------------------------------------- WSDL (esquema embutido, como o de Vendas)
function wsdl(base){
  const nomes = Object.keys(OPS);
  const el = (n, filhos) => `<xs:element name="${n}"><xs:complexType><xs:sequence>${filhos}</xs:sequence></xs:complexType></xs:element>`;
  const resp = '<xs:element name="codigo" type="xs:string"/><xs:element name="mensagem" type="xs:string"/><xs:element name="dadosJson" type="xs:string"/>';
  const tipos = nomes.map(n => el(n, OPS[n].params.map(p => `<xs:element name="${p.n}" type="${p.t}" minOccurs="${p.obr ? 1 : 0}"/>`).join('')) + el(n + 'Response', resp)).join('');
  const msgs = nomes.map(n => `<wsdl:message name="${n}Input"><wsdl:part name="parameters" element="tns:${n}"/></wsdl:message><wsdl:message name="${n}Output"><wsdl:part name="parameters" element="tns:${n}Response"/></wsdl:message>`).join('');
  const port = nomes.map(n => `<wsdl:operation name="${n}"><wsdl:input message="tns:${n}Input"/><wsdl:output message="tns:${n}Output"/></wsdl:operation>`).join('');
  const bind = nomes.map(n => `<wsdl:operation name="${n}"><soap:operation soapAction="${NS}#${n}"/><wsdl:input><soap:body use="literal"/></wsdl:input><wsdl:output><soap:body use="literal"/></wsdl:output></wsdl:operation>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:tns="${NS}" targetNamespace="${NS}" name="ComprasWebService">
<wsdl:types><xs:schema targetNamespace="${NS}" elementFormDefault="qualified">${tipos}</xs:schema></wsdl:types>
${msgs}<wsdl:portType name="ComprasPortType">${port}</wsdl:portType>
<wsdl:binding name="ComprasSoapBinding" type="tns:ComprasPortType"><soap:binding transport="http://schemas.xmlsoap.org/soap/http" style="document"/>${bind}</wsdl:binding>
<wsdl:service name="ComprasWebService"><wsdl:port name="ComprasSoapPort" binding="tns:ComprasSoapBinding"><soap:address location="${base}/api/soap/v1/compras"/></wsdl:port></wsdl:service>
</wsdl:definitions>
`;
}

// ---------------------------------------------------------------------------- envelope
const envelope = corpo => '<?xml version="1.0" encoding="UTF-8"?>\n<soap:Envelope xmlns:soap="' + NS_SOAP + '" xmlns:tns="' + NS + '"><soap:Body>' + corpo + '</soap:Body></soap:Envelope>\n';
function resposta(res, op, codigo, mensagem, dados){
  res.statusCode = 200; res.setHeader('Content-Type', 'text/xml; charset=utf-8');
  res.end(envelope(`<tns:${op}Response><tns:codigo>${codigo}</tns:codigo><tns:mensagem>${xesc(mensagem)}</tns:mensagem><tns:dadosJson>${xesc(dados === undefined ? '{}' : JSON.stringify(dados))}</tns:dadosJson></tns:${op}Response>`));
}
function fault(res, msg){
  res.statusCode = 500; res.setHeader('Content-Type', 'text/xml; charset=utf-8');
  res.end(envelope(`<soap:Fault><faultcode>soap:Client</faultcode><faultstring>${xesc(msg)}</faultstring></soap:Fault>`));
}
// operação e parâmetros: o primeiro elemento do soap:Body é a operação; seus filhos são os parâmetros (qualquer prefixo)
function lerPedido(texto){
  const t = String(texto || '').replace(/^﻿/, '');
  if (/<!DOCTYPE|<!ENTITY/i.test(t)) throw new ErroApi(400, 'XML com DTD ou entidades não é aceito.');
  const corpo = (t.match(/<(?:[\w.-]+:)?Body(?:\s[^>]*)?>([\s\S]*)<\/(?:[\w.-]+:)?Body\s*>/) || [])[1];
  if (corpo == null || !/<(?:[\w.-]+:)?Envelope[\s>]/.test(t)) throw new ErroApi(400, 'O corpo não é um envelope SOAP 1.1 com soap:Body.');
  const m = corpo.replace(/^(\s|<!--[\s\S]*?-->)+/, '').match(/^<(?:([\w.-]+):)?([A-Za-z_][\w.-]*)([^>]*?)(\/?)>/);
  if (!m) throw new ErroApi(400, 'soap:Body vazio.');
  const op = m[2], params = {};
  if (!m[4]) {
    const fim = corpo.lastIndexOf('</' + (m[1] ? m[1] + ':' : '') + op);
    const interno = corpo.slice(corpo.indexOf(m[0]) + m[0].length, fim < 0 ? corpo.length : fim);
    const re = /<(?:[\w.-]+:)?([A-Za-z_][\w.-]*)(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?\1\s*>)/g;
    let p; while ((p = re.exec(interno))) params[p[1]] = p[2] == null ? '' : desfaz(p[2]).trim();
  }
  return { op, params };
}

// ---------------------------------------------------------------------------- utilitários das operações
const exige = (p, nomes) => { const f = nomes.filter(n => !String(p[n] ?? '').trim()); if (f.length) throw new ErroApi(400, 'Parâmetro obrigatório ausente: ' + f.join(', ') + '.'); };
const inteiro = (p, n, min = 0) => { if (p[n] == null || p[n] === '') return undefined; if (!/^\d+$/.test(p[n]) || +p[n] < min) throw new ErroApi(400, n + ' deve ser inteiro' + (min ? ' maior que zero' : ' maior ou igual a zero') + '.'); return parseInt(p[n], 10); };
const dia = (p, n) => { if (!p[n]) return undefined; if (!RE_DIA.test(p[n])) throw new ErroApi(400, n + ' deve ser AAAA-MM-DD.'); return p[n]; };
async function dadosDoSistema(){
  const d = await redis('GET', 'dados');
  if (!d) throw new ErroApi(404, 'O Compras ainda não guardou os dados no servidor.');
  return JSON.parse(d);
}
const totalPedido = p => Math.round((p.itens || []).reduce((t, i) => t + (Number(i.qtd) || 0) * (Number(i.preco) || 0), 0) * 100) / 100;
function pedidoJson(p){
  return { numero: p.num, fornecedor: p.fornecedor || null, dataEmissao: p.emissao || null, previsaoEntrega: p.previsao || null, vencimento: p.vencimento || null,
    situacaoFinanceira: p.avisoFin === 'PAGO' ? 'Pago' : p.avisoFin === 'CANCELADO' ? 'Cancelado' : p.fin, situacaoLogistica: p.log,
    enviadoFinanceiro: !!p.enviadoFin, solicitacao: p.solicitacao || null, valorTotal: totalPedido(p),
    itens: (p.itens || []).map(i => ({ sku: i.sku || null, produto: i.nome, quantidade: i.qtd, quantidadeRecebida: i.receb || 0, precoUnitario: Number(i.preco) || 0 })) };
}
const recebidaOuDup = r => r.duplicada ? [200, 'Mensagem já recebida antes; nada mudou.'] : [202, 'Recebida. O Compras aplica na próxima leitura da caixa de entrada.'];

async function executar(req, op, p){
  const c = OPS[op];
  if (op === 'ConsultarSaude') {
    let banco = 'ok'; try { await redis('GET', 'admin'); } catch (e) { banco = 'fora do ar'; }
    return [200, 'Serviço do Compras no ar.', { servico: 'ComprasWebService', versao: 'v1', banco, horario: agora(), wsdl: '/api/soap/v1/compras?wsdl' }];
  }
  await autenticar(req, c.setores);
  if (c.lista) {
    const r = await listarPublicacoes(c.lista, inteiro(p, 'desde'), inteiro(p, 'limite', 1));
    if (r.itens.length) req._comItens = true;
    return [200, r.itens.length + ' item(ns) depois de ' + r.desde + '.', r];
  }
  if (op === 'ConsultarPedido' || op === 'ConsultarStatusPedido') {
    exige(p, ['idPedido']);
    const d = await dadosDoSistema(), ped = (d.pedidos || []).find(x => x.num === p.idPedido.trim().toUpperCase());
    if (!ped) return [404, 'Pedido ' + p.idPedido + ' não encontrado.', {}];
    const j = pedidoJson(ped);
    if (op === 'ConsultarPedido') return [200, 'Pedido encontrado.', j];
    return [200, 'Status do pedido.', { numero: j.numero, situacaoFinanceira: j.situacaoFinanceira, situacaoLogistica: j.situacaoLogistica, enviadoFinanceiro: j.enviadoFinanceiro,
      previsaoEntrega: j.previsaoEntrega, quantidadeTotal: j.itens.reduce((t, i) => t + i.quantidade, 0), quantidadeRecebida: j.itens.reduce((t, i) => t + i.quantidadeRecebida, 0) }];
  }
  if (op === 'ConsultarSolicitacao') {
    exige(p, ['idSolicitacao']);
    const d = await dadosDoSistema(), s = (d.solicitacoes || []).find(x => x.referencia === p.idSolicitacao.trim());
    if (!s) return [404, 'Solicitação ' + p.idSolicitacao + ' não encontrada no Compras (se acabou de ser enviada, aguarde a leitura da caixa de entrada).', {}];
    return [200, 'Solicitação ' + s.situacao.toLowerCase() + '.', { idSolicitacao: s.referencia, situacao: s.situacao, pedidos: s.pedidos || [], motivoRecusa: s.motivoRecusa || null,
      recebidaEm: s.recebidaEm, respondidaEm: s.respondidaEm || null }];
  }
  const quem = req._quem;
  if (op === 'EnviarSolicitacaoCompra') {
    exige(p, ['idSolicitacao', 'sku', 'produto', 'quantidade', 'motivo']);
    const q = inteiro(p, 'quantidade', 1), sku = skuNorm(p.sku), prio = (p.prioridade || 'NORMAL').toUpperCase(), motivo = p.motivo.toUpperCase();
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,59}$/.test(p.idSolicitacao)) throw new ErroApi(400, 'idSolicitacao: sem espaços, até 60 caracteres.');
    if (!['ESTOQUE_MINIMO', 'SEM_SALDO', 'REPOSICAO', 'PRODUTO_NOVO', 'OUTRO'].includes(motivo)) throw new ErroApi(400, 'motivo deve ser ESTOQUE_MINIMO, SEM_SALDO, REPOSICAO, PRODUTO_NOVO ou OUTRO.');
    if (!['NORMAL', 'URGENTE'].includes(prio)) throw new ErroApi(400, 'prioridade deve ser NORMAL ou URGENTE.');
    const sa = inteiro(p, 'saldoAtual'), em = inteiro(p, 'estoqueMinimo'), nec = dia(p, 'dataNecessidade');
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<solicitacaoCompra xmlns="urn:compras:solicitacao-compra:1.0" versao="1.0" referencia="${xesc(p.idSolicitacao)}">` +
      `<origem>estoque</origem><dataSolicitacao>${hojeBR()}</dataSolicitacao><motivo>${motivo}</motivo><prioridade>${prio}</prioridade>` +
      (nec ? `<dataNecessidade>${nec}</dataNecessidade>` : '') + (p.observacao ? `<observacao>${xesc(p.observacao.slice(0, 500))}</observacao>` : '') +
      `<itens><item><sku>${sku}</sku><produto>${xesc(p.produto.slice(0, 120))}</produto><quantidade>${q}</quantidade>` +
      (sa != null ? `<saldoAtual>${sa}</saldoAtual>` : '') + (em != null ? `<estoqueMinimo>${em}</estoqueMinimo>` : '') + '</item></itens></solicitacaoCompra>';
    const r = await gravarEntrada(quem, { xml }, 'solicitacao-compra');
    const [cod, msg] = recebidaOuDup(r);
    return [cod, msg, { seq: r.seq, tipo: r.tipo, idSolicitacao: p.idSolicitacao, duplicada: r.duplicada }];
  }
  if (op === 'ConfirmarRecebimento') {
    exige(p, ['referencia', 'status']);
    const st = p.status.toUpperCase();
    if (!['ACEITO', 'DIVERGENTE', 'REJEITADO', 'DUPLICADO'].includes(st)) throw new ErroApi(400, 'status deve ser ACEITO, DIVERGENTE, REJEITADO ou DUPLICADO.');
    let div = '';
    if (st === 'DIVERGENTE') {
      exige(p, ['sku', 'quantidadeInformada', 'quantidadeContada']);
      div = `<divergencia><sku>${skuNorm(p.sku)}</sku><quantidadeInformada>${inteiro(p, 'quantidadeInformada')}</quantidadeInformada><quantidadeContada>${inteiro(p, 'quantidadeContada')}</quantidadeContada></divergencia>`;
    }
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<confirmacaoRecebimento xmlns="urn:compras:confirmacao-recebimento:1.0" versao="1.0"><origem>estoque</origem><dataProcessamento>${hojeBR()}</dataProcessamento>` +
      `<resultados><resultado referencia="${xesc(p.referencia)}" status="${st}">${div}${p.mensagem ? `<mensagem>${xesc(p.mensagem.slice(0, 500))}</mensagem>` : ''}</resultado></resultados>` +
      `<totalizador><qtdRegistros>1</qtdRegistros><qtdAceitos>${st === 'ACEITO' ? 1 : 0}</qtdAceitos></totalizador></confirmacaoRecebimento>`;
    const r = await gravarEntrada(quem, { xml }, 'confirmacao-recebimento');
    const [cod, msg] = recebidaOuDup(r);
    return [cod, msg, { seq: r.seq, tipo: r.tipo, referencia: p.referencia, duplicada: r.duplicada }];
  }
  if (op === 'ResponderDisponibilidade') {
    exige(p, ['idConsulta', 'produtoCodigo']);
    if (!p.erro && (!p.nome || p.quantidadeDisponivel == null || p.quantidadeDisponivel === '')) throw new ErroApi(400, 'Informe nome e quantidadeDisponivel, ou erro.');
    const corpoR = p.erro ? `<erro>${xesc(p.erro.slice(0, 500))}</erro>` : `<produto><nome>${xesc(p.nome.slice(0, 120))}</nome><quantidadeDisponivel>${inteiro(p, 'quantidadeDisponivel')}</quantidadeDisponivel></produto>`;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<respostaDisponibilidade><idConsulta>${xesc(p.idConsulta)}</idConsulta><produtoCodigo>${xesc(p.produtoCodigo)}</produtoCodigo>${corpoR}</respostaDisponibilidade>`;
    const r = await gravarEntrada(quem, { xml }, 'resposta-disponibilidade');
    const [cod, msg] = recebidaOuDup(r);
    return [cod, msg, { seq: r.seq, tipo: r.tipo, idConsulta: p.idConsulta, duplicada: r.duplicada }];
  }
  if (op === 'EnviarAvisoPagamento') {
    exige(p, ['idAviso', 'referencia', 'situacao', 'valor']);
    const valor = Number(String(p.valor).replace(',', '.'));
    if (!(valor >= 0)) throw new ErroApi(400, 'valor deve ser número maior ou igual a zero.');
    const aviso = { id: p.idAviso, origem: 'compras', referencia: p.referencia, situacao: p.situacao.toUpperCase(), valor, ...(p.dataPagamento ? { dataPagamento: dia(p, 'dataPagamento') } : {}) };
    const r = await gravarEntrada(quem, { aviso }, 'aviso-pagamento');
    const [cod, msg] = recebidaOuDup(r);
    return [cod, msg, { seq: r.seq, tipo: r.tipo, referencia: p.referencia, duplicada: r.duplicada }];
  }
  if (op === 'EnviarMensagem') {
    exige(p, ['xml']);
    const r = await gravarEntrada(quem, { xml: checarXml(p.xml) });
    const [cod, msg] = recebidaOuDup(r);
    return [cod, msg, { seq: r.seq, tipo: r.tipo, duplicada: r.duplicada }];
  }
  throw new ErroApi(400, 'Operação sem implementação: ' + op);
}

module.exports = async (req, res) => {
  cors(res);
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, SOAPAction');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  const base = 'https://' + (req.headers['x-forwarded-host'] || req.headers.host || 'compras.cezbyte.com.br');
  if (req.method === 'GET') { res.statusCode = 200; res.setHeader('Content-Type', 'text/xml; charset=utf-8'); return res.end(wsdl(base)); }
  if (req.method !== 'POST') return fault(res, 'Use POST com um envelope SOAP, ou GET ?wsdl.');
  let op = '', codigo = 200;
  try {
    const ped = lerPedido(await lerCorpo(req));
    const acao = String(req.headers.soapaction || '').replace(/^"|"$/g, '');
    op = ped.op;
    if (acao && acao.startsWith(NS + '#') && acao.slice(NS.length + 1) !== op) throw new ErroApi(400, 'SOAPAction ' + acao + ' não bate com o elemento ' + op + ' do soap:Body.');
    if (!OPS[op]) { op = ''; return fault(res, 'Operação desconhecida: ' + ped.op + '. Veja o WSDL em ?wsdl.'); }
    req._metodoLog = 'SOAP';
    const [cod, msg, dados] = await executar(req, op, ped.params);
    codigo = cod; resposta(res, op, cod, msg, dados);
  } catch (e) {
    codigo = e instanceof ErroApi ? e.status : 500;
    if (!(e instanceof ErroApi)) console.error(e);
    const msg = e instanceof ErroApi ? e.message : 'Erro interno.';
    const { www, ...extra } = (e && e.extra) || {};
    if (codigo === 401) res.setHeader('WWW-Authenticate', 'Bearer');
    if (op) resposta(res, op, codigo, msg, extra); else fault(res, msg);
  }
  if (op && op !== 'ConsultarSaude') await registrarAcesso(req, codigo, '/api/soap/v1/compras#' + op);
};
