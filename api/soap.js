/*
 * Webservice SOAP do Compras (SOAP 1.1, document/literal), no mesmo modelo do SOAP do Finanweb.
 *   Endereço: /api/soap        WSDL: /api/soap?wsdl
 *   Chave do setor no cabeçalho HTTP:  Authorization: Bearer <chave>   (as mesmas chaves da API REST)
 *   soap:Header opcional: <cs:controle><cs:idMensagem/></cs:controle>; a resposta sempre devolve um <cs:controle>.
 *   Erros: soap:Fault, com HTTP 401 (sem chave), 403 (operação de outro setor), 429, ou 500 (recusado, motivo em faultstring).
 *
 * Operações (o corpo é o mesmo XML dos contratos usados por arquivo e pela API REST):
 *   ListarRecebimentos / ListarPrevisoesEntrega / ListarConsultasDisponibilidade   (estoque)
 *     Body: <cs:listarRecebimentos><cs:desde>0</cs:desde><cs:limite>50</cs:limite></cs:listarRecebimentos>
 *     Resposta: <cs:publicacoes tipo desde ultimo><cs:publicacao seq referencia publicadoEm> XML </cs:publicacao>...
 *   ConfirmarRecebimento     Body: <confirmacaoRecebimento xmlns="urn:compras:confirmacao-recebimento:1.0">   (estoque)
 *   EnviarSolicitacaoCompra  Body: <solicitacaoCompra xmlns="urn:compras:solicitacao-compra:1.0">            (estoque)
 *   ListarRespostasSolicitacao: como as outras listagens; devolve as respostaSolicitacao publicadas      (estoque)
 *   ResponderDisponibilidade Body: <cs:responderDisponibilidade><respostaDisponibilidade>…</cs:responderDisponibilidade> (estoque)
 *   EnviarSaldo              Body: <cs:enviarSaldo><estoque versao="2">…</cs:enviarSaldo>                       (estoque)
 *   EnviarAvisoPagamento     Body: <cs:enviarAvisoPagamento><avisoPagamento xmlns="urn:finanweb:aviso-pagamento:1.0">…   (financeiro)
 *   EnviarRespostaPendencias Body: <cs:enviarRespostaPendencias><respostaPendencias xmlns="urn:finanweb:pendencias-fornecedor:1.0">… (financeiro)
 *   EnviarMensagem           Body: <cs:enviarMensagem> qualquer XML acima </cs:enviarMensagem>                 (estoque, financeiro)
 *   Os documentos com namespace também podem ir direto no Body (sem o invólucro cs:); a operação vem do SOAPAction ou da raiz.
 *   Resposta dos envios: <cs:confirmacaoEnvio><cs:situacao>RECEBIDA|DUPLICADA</cs:situacao><cs:tipo/><cs:seq/><cs:mensagem/></cs:confirmacaoEnvio>
 */
'use strict';
const { ErroApi, agora, cors, lerCorpo, checarXml, raizXml, ENTRADA, autenticar, listarPublicacoes, gravarEntrada, registrarAcesso } = require('./_nucleo');

const NS = 'urn:compras:servico:1.0';
const NS_SOAP = 'http://schemas.xmlsoap.org/soap/envelope/';
const xesc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

// operação -> como tratar
const OPS = {
  ListarRecebimentos:             { lista: 'recebimento', el: 'listarRecebimentos' },
  ListarPrevisoesEntrega:         { lista: 'previsao-entrega', el: 'listarPrevisoesEntrega' },
  ListarConsultasDisponibilidade: { lista: 'consulta-disponibilidade', el: 'listarConsultasDisponibilidade' },
  ListarRespostasSolicitacao:     { lista: 'resposta-solicitacao', el: 'listarRespostasSolicitacao' },
  EnviarSolicitacaoCompra:        { tipo: 'solicitacao-compra', el: 'enviarSolicitacaoCompra' },
  ConfirmarRecebimento:           { tipo: 'confirmacao-recebimento', el: 'confirmarRecebimento' },
  ResponderDisponibilidade:       { tipo: 'resposta-disponibilidade', el: 'responderDisponibilidade' },
  EnviarSaldo:                    { tipo: 'saldo-estoque', el: 'enviarSaldo' },
  EnviarAvisoPagamento:           { tipo: 'aviso-pagamento', el: 'enviarAvisoPagamento' },
  EnviarRespostaPendencias:       { tipo: 'resposta-pendencias', el: 'enviarRespostaPendencias' },
  EnviarMensagem:                 { tipo: null, el: 'enviarMensagem' },
};
const OP_POR_EL = Object.fromEntries(Object.entries(OPS).map(([op, c]) => [c.el, op]));
const OP_POR_TIPO = Object.fromEntries(Object.entries(OPS).filter(([, c]) => c.tipo).map(([op, c]) => [c.tipo, op]));

// --------------------------------------------------------------------------- envelope
function envelope(corpo, controle){
  return '<?xml version="1.0" encoding="UTF-8"?>\n<soap:Envelope xmlns:soap="' + NS_SOAP + '" xmlns:cs="' + NS + '">\n' +
    '  <soap:Header><cs:controle><cs:idMensagem>' + xesc(controle.idMensagem) + '</cs:idMensagem><cs:operacao>' + xesc(controle.operacao || '') +
    '</cs:operacao><cs:dataHora>' + agora() + '</cs:dataHora></cs:controle></soap:Header>\n  <soap:Body>\n' + corpo + '\n  </soap:Body>\n</soap:Envelope>\n';
}
function responder(res, status, corpo, controle){
  res.statusCode = status; res.setHeader('Content-Type', 'text/xml; charset=utf-8'); res.end(envelope(corpo, controle));
}
function fault(res, status, msg, controle){
  const codigo = status === 503 || status === 502 ? 'soap:Server' : 'soap:Client';
  responder(res, status, '    <soap:Fault><faultcode>' + codigo + '</faultcode><faultstring>' + xesc(msg) + '</faultstring>' +
    '<detail><cs:erro><cs:status>' + status + '</cs:status><cs:mensagem>' + xesc(msg) + '</cs:mensagem></cs:erro></detail></soap:Fault>', controle);
}

// tags de abertura com as declarações xmlns que o filho herda do Envelope/Header/Body
const declaracoes = tag => [...tag.matchAll(/\sxmlns(:[\w.-]+)?="([^"]*)"/g)].map(m => ({ p: m[1] ? m[1].slice(1) : '', ns: m[2] }));
// Primeiro elemento filho de um trecho de XML: devolve { pref, local, aberturas, interno, completo }
function primeiroFilho(trecho){
  const t = trecho.replace(/^(\s|<!--[\s\S]*?-->)+/, '');
  const m = t.match(/^<([A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)([^>]*?)(\/?)>/);
  if (!m) return null;
  const pref = m[1] ? m[1].slice(0, -1) : '', local = m[2], nome = (m[1] || '') + local;
  if (m[4]) return { pref, local, abertura: m[0], interno: '', completo: m[0] };
  // acha o fechamento correspondente contando aberturas e fechamentos do mesmo nome
  const re = new RegExp('<(/?)' + nome.replace(/[.-]/g, '\\$&') + '(?=[\\s>/])[^>]*?(/?)>', 'g');
  let prof = 0, mm;
  while ((mm = re.exec(t))) {
    if (mm[1]) { prof--; if (prof === 0) return { pref, local, abertura: m[0], interno: t.slice(m[0].length, mm.index), completo: t.slice(0, mm.index + mm[0].length) }; }
    else if (!mm[2]) prof++;
  }
  throw new ErroApi(400, 'XML mal formado: <' + nome + '> sem fechamento.');
}
// Recorta um elemento do envelope como documento independente, levando as declarações de namespace herdadas
function comoDocumento(el, herdadas){
  const ja = new Set(declaracoes(el.abertura).map(d => d.p));
  const faltam = herdadas.filter(d => !ja.has(d.p) && d.ns !== NS_SOAP && (d.p === el.pref || el.completo.includes(d.p + ':') || (d.p === '' && !el.pref)));
  const extra = faltam.map(d => ' xmlns' + (d.p ? ':' + d.p : '') + '="' + d.ns + '"').join('');
  return el.completo.replace(/^<([^\s>/]+)/, '<$1' + extra);
}
const nsDoPrefixo = (pref, decls) => { for (let i = decls.length - 1; i >= 0; i--) if (decls[i].p === pref) return decls[i].ns; return ''; };

function lerEnvelope(texto){
  const t = String(texto || '').replace(/^﻿/, '').trim();
  if (!t) throw new ErroApi(400, 'Envie um envelope SOAP 1.1 no corpo (Content-Type: text/xml).');
  if (/<!DOCTYPE|<!ENTITY/i.test(t)) throw new ErroApi(400, 'XML com DTD ou entidades não é aceito.');
  const env = primeiroFilho(t.replace(/^<\?xml[^>]*\?>/, ''));
  if (!env || env.local !== 'Envelope') throw new ErroApi(400, 'O corpo não é um soap:Envelope.');
  const decls = declaracoes(env.abertura);
  if (nsDoPrefixo(env.pref, decls) !== NS_SOAP) throw new ErroApi(400, 'Envelope fora do SOAP 1.1 (' + NS_SOAP + ').');
  let resto = env.interno, cab = null, corpo = null;
  while (resto.replace(/(\s|<!--[\s\S]*?-->)/g, '')) {
    const f = primeiroFilho(resto); if (!f) break;
    if (f.local === 'Header') cab = f; else if (f.local === 'Body') corpo = f;
    resto = resto.replace(/^(\s|<!--[\s\S]*?-->)+/, '').slice(f.completo.length);
  }
  if (!corpo) throw new ErroApi(400, 'Envelope sem soap:Body.');
  const idMensagem = cab ? ((cab.interno.match(/<(?:[\w.-]+:)?idMensagem>([^<]{1,100})</) || [])[1] || '') : '';
  const herdadas = [...decls, ...declaracoes(corpo.abertura)];
  const filho = primeiroFilho(corpo.interno);
  if (!filho) throw new ErroApi(400, 'soap:Body vazio.');
  const nsFilho = nsDoPrefixo(filho.pref, [...herdadas, ...declaracoes(filho.abertura)]);
  return { idMensagem, filho, nsFilho, herdadas };
}

// --------------------------------------------------------------------------- WSDL
function wsdl(base){
  const C = base + '/contratos/';
  const op = (nome, entrada, saida) => ({ nome, entrada, saida });
  const ops = [
    op('ListarRecebimentos', 'cs:listarRecebimentos', 'cs:publicacoes'),
    op('ListarPrevisoesEntrega', 'cs:listarPrevisoesEntrega', 'cs:publicacoes'),
    op('ListarConsultasDisponibilidade', 'cs:listarConsultasDisponibilidade', 'cs:publicacoes'),
    op('ListarRespostasSolicitacao', 'cs:listarRespostasSolicitacao', 'cs:publicacoes'),
    op('EnviarSolicitacaoCompra', 'sc:solicitacaoCompra', 'cs:confirmacaoEnvio'),
    op('ConfirmarRecebimento', 'cr:confirmacaoRecebimento', 'cs:confirmacaoEnvio'),
    op('ResponderDisponibilidade', 'cs:responderDisponibilidade', 'cs:confirmacaoEnvio'),
    op('EnviarSaldo', 'cs:enviarSaldo', 'cs:confirmacaoEnvio'),
    op('EnviarAvisoPagamento', 'cs:enviarAvisoPagamento', 'cs:confirmacaoEnvio'),
    op('EnviarRespostaPendencias', 'cs:enviarRespostaPendencias', 'cs:confirmacaoEnvio'),
    op('EnviarMensagem', 'cs:enviarMensagem', 'cs:confirmacaoEnvio'),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<wsdl:definitions name="Compras" targetNamespace="${NS}"
    xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
    xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:tns="${NS}" xmlns:cs="${NS}"
    xmlns:cr="urn:compras:confirmacao-recebimento:1.0" xmlns:sc="urn:compras:solicitacao-compra:1.0">
  <wsdl:documentation>Serviço SOAP 1.1 do Compras (document/literal). Chave do setor no cabeçalho HTTP Authorization: Bearer &lt;chave&gt;, a mesma da API REST (${base}/api/v1). Contratos: ${C}</wsdl:documentation>
  <wsdl:types>
    <xsd:schema>
      <xsd:import namespace="${NS}" schemaLocation="${C}servico-compras-v1.xsd"/>
      <xsd:import namespace="urn:compras:confirmacao-recebimento:1.0" schemaLocation="${C}confirmacao-recebimento-v1.xsd"/>
      <xsd:import namespace="urn:compras:solicitacao-compra:1.0" schemaLocation="${C}solicitacao-compra-v1.xsd"/>
    </xsd:schema>
  </wsdl:types>
  <wsdl:message name="Controle"><wsdl:part name="controle" element="cs:controle"/></wsdl:message>
${ops.map(o => `  <wsdl:message name="${o.nome}Entrada"><wsdl:part name="corpo" element="${o.entrada}"/></wsdl:message>
  <wsdl:message name="${o.nome}Saida"><wsdl:part name="corpo" element="${o.saida}"/></wsdl:message>`).join('\n')}
  <wsdl:portType name="ComprasPortType">
${ops.map(o => `    <wsdl:operation name="${o.nome}"><wsdl:input message="tns:${o.nome}Entrada"/><wsdl:output message="tns:${o.nome}Saida"/></wsdl:operation>`).join('\n')}
  </wsdl:portType>
  <wsdl:binding name="ComprasBinding" type="tns:ComprasPortType">
    <soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
${ops.map(o => `    <wsdl:operation name="${o.nome}">
      <soap:operation soapAction="${NS}#${o.nome}" style="document"/>
      <wsdl:input><soap:header message="tns:Controle" part="controle" use="literal"/><soap:body use="literal"/></wsdl:input>
      <wsdl:output><soap:header message="tns:Controle" part="controle" use="literal"/><soap:body use="literal"/></wsdl:output>
    </wsdl:operation>`).join('\n')}
  </wsdl:binding>
  <wsdl:service name="Compras">
    <wsdl:port name="ComprasPort" binding="tns:ComprasBinding"><soap:address location="${base}/api/soap"/></wsdl:port>
  </wsdl:service>
</wsdl:definitions>
`;
}

// --------------------------------------------------------------------------- operações
async function executar(req, op, ctx){
  const c = OPS[op];
  if (c.lista) {
    await autenticar(req, ['estoque']);
    const tx = n => (ctx.filho.interno.match(new RegExp('<(?:[\\w.-]+:)?' + n + '>\\s*(\\d+)\\s*<')) || [])[1];
    const r = await listarPublicacoes(c.lista, tx('desde'), tx('limite'));
    if (r.itens.length) req._comItens = true;
    return '    <cs:publicacoes tipo="' + r.tipo + '" desde="' + r.desde + '" ultimo="' + r.ultimo + '">\n' +
      r.itens.map(i => '      <cs:publicacao seq="' + i.seq + '" referencia="' + xesc(i.referencia) + '" publicadoEm="' + xesc(i.publicadoEm) + '">\n' +
        i.xml.replace(/^<\?xml[^>]*\?>\s*/, '') + '\n      </cs:publicacao>').join('\n') + '\n    </cs:publicacoes>';
  }
  // envio: o documento vem direto no Body ou dentro do invólucro cs:<operacao>
  let doc = ctx.filho, herdadas = ctx.herdadas;
  if (ctx.nsFilho === NS) {
    herdadas = [...herdadas, ...declaracoes(doc.abertura)];
    doc = primeiroFilho(doc.interno);
    if (!doc) throw new ErroApi(422, 'O invólucro <cs:' + c.el + '> está vazio: coloque dentro o XML do contrato.');
  }
  const xml = checarXml(comoDocumento(doc, herdadas));
  const permitidos = c.tipo ? ENTRADA[c.tipo].setores : ['estoque', 'financeiro'];
  const quem = await autenticar(req, permitidos);
  const r = await gravarEntrada(quem, { xml }, c.tipo);
  return '    <cs:confirmacaoEnvio>\n      <cs:situacao>' + (r.duplicada ? 'DUPLICADA' : 'RECEBIDA') + '</cs:situacao>\n      <cs:tipo>' + r.tipo +
    '</cs:tipo>\n      <cs:seq>' + r.seq + '</cs:seq>\n      <cs:mensagem>' +
    (r.duplicada ? 'Mensagem já recebida antes; nada mudou.' : 'Recebida. O Compras aplica na próxima leitura da caixa de entrada.') +
    '</cs:mensagem>\n    </cs:confirmacaoEnvio>';
}

function descobrirOperacao(req, ctx){
  const acao = String(req.headers.soapaction || '').replace(/^"|"$/g, '');
  const pelaAcao = acao.startsWith(NS + '#') ? acao.slice(NS.length + 1) : '';
  if (pelaAcao && !OPS[pelaAcao]) throw new ErroApi(400, 'SOAPAction desconhecida: ' + acao + '.');
  if (ctx.nsFilho === NS) {
    const op = OP_POR_EL[ctx.filho.local];
    if (!op) throw new ErroApi(400, 'Elemento <cs:' + ctx.filho.local + '> não é uma operação deste serviço.');
    if (pelaAcao && pelaAcao !== op) throw new ErroApi(400, 'SOAPAction ' + pelaAcao + ' não bate com o corpo <cs:' + ctx.filho.local + '>.');
    return op;
  }
  if (pelaAcao) return pelaAcao;
  const raiz = raizXml(comoDocumento(ctx.filho, ctx.herdadas));
  const tipo = Object.keys(ENTRADA).find(t => ENTRADA[t].teste(raiz));
  if (!tipo) throw new ErroApi(422, 'O soap:Body traz <' + raiz.nome + '>, que não é um contrato que o Compras recebe.');
  return OP_POR_TIPO[tipo];
}

module.exports = async (req, res) => {
  cors(res);
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, SOAPAction');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  const base = 'https://' + (req.headers['x-forwarded-host'] || req.headers.host || 'compras.cezbyte.com.br');
  const ctrl = { idMensagem: 'compras-' + Date.now().toString(36), operacao: '' };
  if (req.method === 'GET') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/xml; charset=utf-8');
    return res.end(wsdl(base));   // com ou sem ?wsdl, o GET devolve o WSDL
  }
  if (req.method !== 'POST') return fault(res, 405, 'Use POST com um envelope SOAP, ou GET ?wsdl.', ctrl);
  let status = 200;
  try {
    const ctx = lerEnvelope(await lerCorpo(req));
    if (ctx.idMensagem) ctrl.idMensagem = ctx.idMensagem;
    const op = descobrirOperacao(req, ctx);
    ctrl.operacao = op; req._metodoLog = 'SOAP';
    const corpo = await executar(req, op, ctx);
    responder(res, 200, corpo, ctrl);
  } catch (e) {
    status = e instanceof ErroApi ? (e.status === 422 || e.status === 400 || e.status === 404 || e.status === 413 ? 500 : e.status) : 500;
    if (status === 401) res.setHeader('WWW-Authenticate', 'Bearer');
    fault(res, status, e instanceof ErroApi ? e.message : 'Erro interno.', ctrl);
    if (!(e instanceof ErroApi)) console.error(e);
  }
  await registrarAcesso(req, status, '/api/soap' + (ctrl.operacao ? '#' + ctrl.operacao : ''));
};
