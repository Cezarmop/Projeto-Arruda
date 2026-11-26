# Projeto-Arruda · Controle de Compras

Sistema do setor de **Compras**, integrado ao **Estoque** e ao **Financeiro (Finanweb)** por API REST, XML e socket.

**No ar:** https://compras.cezbyte.com.br · **API:** https://compras.cezbyte.com.br/api/v1 · **Contratos:** https://compras.cezbyte.com.br/contratos/

## Telas

| Tela | O que faz |
|---|---|
| Pedidos | Criar, editar e filtrar pedidos de compra; importar o CSV do Estoque e exportar CSV |
| Recebimentos | Baixa item a item (parcial permitido); cada baixa vira uma entrada para o Estoque |
| Estoque | Saldo buscado sozinho na API do Estoque, valor total em estoque, entregas previstas, entradas e consulta de disponibilidade |
| Financeiro | Contas a pagar (POST /compras), pendências e avisos de pagamento buscados sozinhos no Finanweb |
| Fornecedores | Cadastro com CPF/CNPJ; um nome usado em 2 pedidos vira cadastro automaticamente |
| Integrações | Dados da empresa, API do Estoque, API do Financeiro e ponte do socket |
| API e contratos | Chaves de API por setor, registro de serviços, contratos XSD e log de acessos |
| Atividade | Histórico de todo XML/JSON trocado (com o XSD de cada um) e logs |

## Estrutura

```
index.html        app (HTML, CSS e JS num arquivo só)
estoque-xml.js    gera e lê os XMLs dos contratos (estoque v2, recebimento-v1, previsao-entrega-v1,
                  confirmacao-recebimento-v1, consulta/resposta de disponibilidade)
api/_nucleo.js    banco, chaves, filas e caixa de entrada, comum à API REST e ao SOAP
api/v1.js         API REST do Compras (Vercel Function, Node, sem dependências)
api/soap-v1.js    webservice SOAP no padrão da turma (/api/soap/v1/compras)
api/soap.js       webservice SOAP anterior (/api/soap), documentos XML no Body
soap/             página do webservice SOAP: WSDL, operações, exemplos e testador
contratos/        XSD e exemplo de cada mensagem + página de documentação
vercel.json       rotas /api/v1/* e cabeçalhos dos XSD
```

## Integrações

**O Compras chama**
- **Estoque:** `GET /api/xml` (saldo, a cada 2 min) e `POST /api/xml/validar` + `POST /api/xml` (entrada no saldo) em `https://sistema-de-estoque-cyan.vercel.app`, com `X-API-Key` opcional.
- **Financeiro:** `POST /api/v1/compras` (ou a operação SOAP `EnviarCompra` em `/api/soap`), `GET /api/v1/pendencias` e `GET /api/v1/avisos-pagamento` em `https://finanwebsistema.vercel.app`, com `Authorization: Bearer <chave do setor compras>`. Pendências e avisos a cada 5 min.
- **Socket da turma** (alternativa), pela ponte `ponte-socket.js` em `http://localhost:8787`.

**Os outros setores chamam o Compras** em `https://compras.cezbyte.com.br/api/v1`, com `Authorization: Bearer <chave do setor>` (`GET /api/v1` lista as rotas):

| Rota | Quem | Para quê |
|---|---|---|
| `GET /recebimentos?desde=<seq>` | estoque | recebimento-v1 publicados |
| `GET /previsoes-entrega?desde=<seq>` | estoque | previsao-entrega-v1 publicadas |
| `GET /consultas-disponibilidade?desde=<seq>` | estoque | consultas de saldo |
| `POST /confirmacoes-recebimento` | estoque | confirmacao-recebimento-v1 |
| `POST /respostas-disponibilidade` | estoque | respostaDisponibilidade |
| `POST /saldos-estoque` | estoque | saldo no XML v2 (opcional) |
| `POST /avisos-pagamento` | financeiro | aviso de pagamento, JSON do Finanweb ou XML |
| `POST /respostas-pendencias` | financeiro | respostaPendencias (opcional) |
| `POST /solicitacoes-compra` | estoque | solicitacao-compra-v1: o Estoque pede uma compra |
| `GET /respostas-solicitacao?desde=<seq>` | estoque | resposta-solicitacao-v1: ATENDIDA (com o pedido) ou RECUSADA |
| `POST /mensagens` | estoque, financeiro | qualquer um dos XMLs acima |

Respostas: `202` recebida, `200` duplicada, `401` chave inválida, `403` rota de outro setor, `422` fora do contrato.
**Webservice SOAP** ([documentação e testador](https://compras.cezbyte.com.br/soap/)) no padrão de interoperabilidade da turma (o mesmo do VendasWebService): `https://compras.cezbyte.com.br/api/soap/v1/compras`, WSDL em [`?wsdl`](https://compras.cezbyte.com.br/api/soap/v1/compras?wsdl), namespace `urn:interoperabilidade:compras:soap:v1`, SOAPAction `urn:interoperabilidade:compras:soap:v1#<Operação>`. Parâmetros simples; toda resposta é `<Operação>Response` com `codigo`, `mensagem` e `dadosJson`. Mesmas chaves e filas da API REST.

| Operação | Quem | Parâmetros |
|---|---|---|
| `ConsultarSaude` | livre | nenhum |
| `ConsultarPedido`, `ConsultarStatusPedido` | estoque, financeiro | `idPedido` |
| `ListarRecebimentos`, `ListarPrevisoesEntrega`, `ListarConsultasDisponibilidade`, `ListarRespostasSolicitacao` | estoque | `desde`, `limite` |
| `EnviarSolicitacaoCompra` | estoque | `idSolicitacao`, `sku`, `produto`, `quantidade`, `motivo` (+ opcionais) |
| `ConsultarSolicitacao` | estoque | `idSolicitacao` |
| `ConfirmarRecebimento` | estoque | `referencia`, `status` (+ divergência) |
| `ResponderDisponibilidade` | estoque | `idConsulta`, `produtoCodigo`, `nome` e `quantidadeDisponivel`, ou `erro` |
| `EnviarAvisoPagamento` | financeiro | `idAviso`, `referencia`, `situacao`, `valor` |
| `EnviarMensagem` | estoque, financeiro | `xml` |

`codigo`: 200 ok, 202 recebida, 400 parâmetro inválido, 401 sem chave, 403 setor sem permissão, 404 não encontrado, 422 fora do contrato. A versão anterior, com documentos XML inteiros no Body, continua em `/api/soap`.

Os serviços estão publicados no [registro do Finanweb](https://finanwebsistema.vercel.app/registro) como versão 2.0.

## Chaves e segredos

- As chaves dos setores são geradas na tela **API e contratos** (protegida pela chave de administrador, criada uma única vez) e ficam no banco só como hash SHA-256.
- As chaves que o Compras usa (Finanweb e Estoque) e os dados da empresa ficam no navegador e numa cópia no servidor, lida só com a chave de administrador.
- **Nenhuma chave vai para o repositório.**

## Publicação (Vercel)

- Projeto `compras` ligado a este repositório (branch `main`, raiz do repositório); cada push publica.
- Banco: Redis da Upstash (`compras-db`, plano grátis) conectado ao projeto. A API acha as variáveis sozinha (`KV_REST_API_URL`/`KV_REST_API_TOKEN` ou com outro prefixo).
- Domínio `compras.cezbyte.com.br` com CNAME na Hostinger.

## Rodar localmente

Abra o `index.html` no navegador (a API do Estoque e a do Finanweb liberam CORS). Para a API própria use `vercel dev` com as variáveis do Redis.
