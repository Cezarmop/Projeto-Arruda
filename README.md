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
api/soap.js       webservice SOAP 1.1 do Compras, com WSDL
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
| `POST /mensagens` | estoque, financeiro | qualquer um dos XMLs acima |

Respostas: `202` recebida, `200` duplicada, `401` chave inválida, `403` rota de outro setor, `422` fora do contrato.
**Webservice SOAP** ([documentação e testador](https://compras.cezbyte.com.br/soap/)) (SOAP 1.1, document/literal) em `https://compras.cezbyte.com.br/api/soap`, WSDL em [`/api/soap?wsdl`](https://compras.cezbyte.com.br/api/soap?wsdl), com as mesmas chaves e as mesmas filas da API REST:

| Operação | Quem | Corpo |
|---|---|---|
| `ListarRecebimentos`, `ListarPrevisoesEntrega`, `ListarConsultasDisponibilidade` | estoque | `<cs:listar...><cs:desde>0</cs:desde></cs:listar...>` |
| `ConfirmarRecebimento` | estoque | `<confirmacaoRecebimento>` direto no Body |
| `ResponderDisponibilidade`, `EnviarSaldo` | estoque | o XML dentro de `<cs:responderDisponibilidade>` / `<cs:enviarSaldo>` |
| `EnviarAvisoPagamento`, `EnviarRespostaPendencias` | financeiro | o XML dentro do invólucro da operação |
| `EnviarMensagem` | estoque, financeiro | qualquer XML acima |

`cs` = `urn:compras:servico:1.0` ([servico-compras-v1.xsd](contratos/servico-compras-v1.xsd)). SOAPAction `urn:compras:servico:1.0#<Operação>` (opcional: sem ela a operação vem do corpo). Envios respondem `<cs:confirmacaoEnvio>` com `RECEBIDA` ou `DUPLICADA`; erros vêm em `soap:Fault` com HTTP 401, 403 ou 500.

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
