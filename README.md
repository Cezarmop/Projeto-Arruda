# Compras (versão enxuta)

Versão com visual mais limpo do Controle de Compras, com as mesmas integrações do original.

## Telas
- **Pedidos**: criar, editar, filtrar; importar CSV do Estoque e exportar CSV.
- **Recebimentos**: baixa item a item (parcial permitido), com entrada automática no saldo do Estoque.
- **Estoque**: saldo, entregas previstas, entradas enviadas e consulta de disponibilidade.
- **Financeiro**: contas a pagar, consulta de pendências e avisos de pagamento, pela API REST do Finanweb (ou socket/arquivo XML).
- **Fornecedores**: viram cadastro com 2 usos.
- **Integrações**: dados da empresa, endereço da API do Estoque e ponte do socket.
- **Atividade**: histórico de XML (com XSD de cada mensagem) e logs.

## Integrações (iguais às do original)
- API do Estoque: `GET /api/xml`, `POST /api/xml/validar`, `POST /api/xml` (padrão `https://sistema-de-estoque-cyan.vercel.app`).
- Ponte `ponte-socket.js` (padrão `http://localhost:8787`): `/eventos`, `/status`, `/enviar`, `/arquivo`, `/lista`, `/proxy`.
- Contratos: estoque v2, recebimento-v1, previsao-entrega-v1, confirmacao-recebimento-v1, disponibilidade (via `estoque-xml.js`) e Finanweb saida-v2, pendencias-fornecedor-v1, aviso-pagamento-v1.

Usa o mesmo `localStorage` (`controle_compras_v2`) da versão original: no mesmo domínio, os dados são compartilhados.
Removido em relação ao original: importador de CSV avulso e tela de Movimentações (as entradas ficam em Estoque > Entradas).

## API do Financeiro (Finanweb)
`https://finanwebsistema.vercel.app/api/v1`, com `Authorization: Bearer <chave do setor compras>`:
- `POST /compras`: pedidos viram contas a pagar (saida-v2 em JSON).
- `GET /pendencias?origem=compras`: pendências com fornecedores.
- `GET /avisos-pagamento?origem=compras&desde=<geradoEm>`: avisos de pagamento.

Pendências e avisos são buscados automaticamente: ao abrir o site, ao entrar na tela Financeiro e a cada 5 min.

As chaves (Estoque e Financeiro) são informadas em Integrações e ficam só no navegador; nunca vão para o repositório.
Referências que já existem no Financeiro vindas de outro sistema Compras não são reusadas: pedidos locais ainda não enviados são renumerados.

## API do Compras (para os outros sistemas)
Base: `https://compras.cezbyte.com.br/api/v1` · `Authorization: Bearer <chave do setor>` · `GET /api/v1` lista as rotas.
Mesmas rotas da API PHP (`public_html/compras/api`): o Estoque busca `recebimentos`, `previsoes-entrega` e
`consultas-disponibilidade` (`?desde=<seq>`) e responde em `POST /mensagens`; o Financeiro pode enviar avisos e pendências.

- Função da Vercel em `api/v1.js` (Node, sem dependências) e banco Redis (Upstash) conectado ao projeto
  (`KV_REST_API_URL`/`KV_REST_API_TOKEN`).
- Tela **API e contratos**: ativação (chave de administrador, criada uma vez), chaves por setor (geradas na tela,
  mostradas uma única vez e guardadas só como hash), registro de serviços, contratos XSD e log de acessos.
- O app publica automaticamente recebimentos, previsões e consultas, e lê a caixa de entrada a cada minuto.
