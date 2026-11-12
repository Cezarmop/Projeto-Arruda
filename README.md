# Projeto-Arruda

Controle de Compras (`public_html/compras/`) integrado ao Estoque e ao Financeiro (Finanweb).

## Integrações: API REST (padrão) e socket (alternativa)

As integrações que antes passavam só pelo socket da turma (via `ponte-socket.js`) agora usam HTTP.
O socket e a troca por arquivo continuam disponíveis como alternativa.

```
                      ┌────────────────────────────── servidor (Hostinger, PHP) ─────────────────────────────┐
 Tela do Compras ───► │ compras/api/  (index.php)                                                          │
 (index.html)         │   caixa de entrada (SQLite) ◄── POST /v1/mensagens ◄────────────── Estoque           │
   lê a caixa a       │   publicações            ───► GET /v1/recebimentos ... ──────────► Estoque           │
   cada 20 s          │   proxy Financeiro       ───► https://finanwebsistema.vercel.app/api/v1/* (Bearer)  │
                      │   proxy Estoque          ───► https://sistema-de-estoque-cyan.vercel.app/api/xml     │
                      └────────────────────────────────────────────────────────────────────────────────────┘
```

Por que um backend: a chave do Financeiro não pode ficar no navegador, as APIs dos outros setores podem
bloquear CORS, e para outro setor *chamar* o Compras é preciso ter um endereço HTTP que receba as mensagens.

### O que mudou em cada fluxo

| Fluxo | Antes (socket) | Agora (REST) |
|---|---|---|
| Contas a pagar (saida-v2) | arquivo `.xml` para `#finanweb` | `POST /api/v1/compras` do Finanweb, em JSON, pelo proxy |
| Consulta de pendências | arquivo, resposta assíncrona | `GET /api/v1/pendencias` do Finanweb, resposta na hora |
| Aviso de pagamento | arquivo empurrado pelo Finanweb | o servidor busca `GET /api/v1/avisos-pagamento` (cursor `desde`) e põe na caixa de entrada |
| Entrada no saldo (XML v2) | API do Estoque pela ponte | API do Estoque pelo proxy do Compras |
| recebimento-v1, previsões, consulta de disponibilidade | arquivo para o ID do Estoque | publicados; o Estoque busca em `GET /v1/...` |
| Confirmação, resposta de disponibilidade, saldo | arquivo do Estoque | o Estoque envia `POST /v1/mensagens` |

## Rotas da API do Compras

Base: `https://<seu-dominio>/compras/api` · Autenticação: `Authorization: Bearer <chave do setor>`
· Contrato completo: `GET /v1/openapi.json` · Lista: `GET /v1`.

| Método | Rota | Quem usa |
|---|---|---|
| GET | `/v1/saude` | livre: estado do servidor e das integrações |
| POST | `/v1/mensagens` | Estoque, Financeiro: qualquer XML suportado (tipo pela raiz/namespace) |
| POST | `/v1/confirmacoes-recebimento`, `/v1/respostas-disponibilidade`, `/v1/saldos-estoque` | Estoque |
| POST | `/v1/avisos-pagamento` (XML ou JSON), `/v1/respostas-pendencias` | Financeiro |
| GET | `/v1/recebimentos`, `/v1/previsoes-entrega`, `/v1/consultas-disponibilidade` (`?desde=seq`) | Estoque |
| GET | `/v1/<mesmas>/{seq}` | Estoque: um XML |
| GET | `/v1/caixa-entrada?desde=seq` | painel |
| POST | `/v1/publicacoes` | painel |
| POST/GET | `/v1/financeiro/compras`, `/v1/financeiro/pendencias`, `/v1/financeiro/avisos-pagamento/buscar` | painel (proxy) |
| GET/POST | `/v1/estoque/xml`, `/v1/estoque/xml/validar` | painel (proxy) |

Regras:

- XML com XSD local (`contratos/`) é validado no servidor; fora do contrato volta `422` com o motivo.
- Idempotência: o mesmo XML enviado de novo responde `200` com `"duplicada": true` e não entra outra vez.
- Cada chave só envia os tipos do seu setor (`403` caso contrário).

Exemplo para o time do Estoque:

```bash
# buscar recebimentos novos
curl -H "Authorization: Bearer CHAVE_DO_ESTOQUE" "https://SEU-DOMINIO/compras/api/v1/recebimentos?desde=0"

# devolver a confirmação
curl -X POST -H "Authorization: Bearer CHAVE_DO_ESTOQUE" -H "Content-Type: application/xml" \
     --data-binary @confirmacao-recebimento-v1.xml "https://SEU-DOMINIO/compras/api/v1/mensagens"
```

## API keys dos sistemas

Cada sistema que se conecta ao Compras tem a sua chave, enviada em `Authorization: Bearer <chave>`.
A chave identifica o setor e limita as rotas que ele pode usar.

| Setor | Quem usa | Pode |
|---|---|---|
| `painel` | a tela do próprio Compras (aba **API REST**) | todas as rotas |
| `estoque` | equipe do Estoque | buscar `GET /v1/recebimentos`, `/v1/previsoes-entrega`, `/v1/consultas-disponibilidade`; enviar `POST /v1/mensagens` (confirmação, resposta de disponibilidade, saldo) |
| `financeiro` | equipe do Financeiro | enviar `POST /v1/mensagens` ou `/v1/avisos-pagamento` e `/v1/respostas-pendencias` |

Respostas: sem chave ou chave errada `401`; chave de outro setor `403`.

**Gerar as chaves** (na raiz do repositório, com PHP 8):

```bash
php ferramentas/gerar-chaves.php           # cria public_html/compras/api/config.php com 3 chaves novas
php ferramentas/gerar-chaves.php --forcar  # troca todas as chaves (as antigas param de funcionar)
```

O script imprime cada chave e para quem entregar. Depois:

1. Envie o `config.php` para `public_html/compras/api/` no servidor.
2. Cole a chave `painel` na aba **API REST** da tela do Compras.
3. Entregue a chave `estoque` e a `financeiro` por canal privado, nunca no grupo da turma.
4. Preencha à mão `financeiro.chave`: essa é a chave que o **Finanweb** emite para o Compras chamar a API dele.

**Segurança:** as chaves reais nunca vão para o Git (o `config.php` está no `.gitignore`). Se uma chave vazar,
rode o script com `--forcar`, suba o `config.php` novo e reenvie as chaves aos setores.

## Publicar na Hostinger

1. Envie `public_html/` como já é feito hoje (inclui `compras/api/`).
2. No servidor, copie `compras/api/config.exemplo.php` para `compras/api/config.php` e preencha:
   - `chaves`: uma chave para o painel e uma para cada setor (gere com `php -r "echo bin2hex(random_bytes(24));"`);
     chaves que começam com `TROQUE` são ignoradas;
   - `financeiro.chave`: a chave Bearer que o Financeiro emitiu para o setor `compras`;
   - `estoque.chave`: só se a API do Estoque exigir.
3. Abra `https://SEU-DOMINIO/compras/api/v1/saude` e confira `pdo_sqlite`, `curl` e `banco: ok`.
4. Na tela do Compras, aba **API REST**, informe a chave do painel e clique em **Salvar e testar**.
5. Entregue a cada setor a sua chave e o link do `openapi.json`.

`config.php` e o banco (`api/dados/`) ficam fora do Git e são bloqueados pelo `.htaccess`.

## Testar localmente

```bash
cd public_html/compras/api && cp config.exemplo.php config.php   # e troque as chaves
cd ../.. && php -S 127.0.0.1:8000
# sem mod_rewrite, use o roteador direto: http://127.0.0.1:8000/compras/api/index.php/v1/saude
```

Requisitos: PHP 8.0+ com `pdo_sqlite`, `curl` e `dom`.
