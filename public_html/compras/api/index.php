<?php
/*
 * API REST do Controle de Compras (Projeto Arruda).
 *
 * Substitui o socket da turma por HTTP:
 *  - Os outros setores ENVIAM mensagens ao Compras (POST /v1/mensagens e rotas por tipo).
 *  - O Compras PUBLICA o que antes ia por arquivo no socket (recebimentos, previsoes, consultas)
 *    e o Estoque BUSCA (GET /v1/recebimentos etc.).
 *  - A tela do Compras (index.html) le a caixa de entrada (GET /v1/caixa-entrada) e usa o servidor
 *    como proxy para as APIs do Financeiro e do Estoque, sem expor as chaves no navegador.
 *
 * Rotas: GET /v1 lista todas. Contrato completo: GET /v1/openapi.json.
 * Funciona com URL amigavel (.htaccess) ou como index.php/v1/...
 */
declare(strict_types=1);

require __DIR__ . '/lib.php';

// ------------------------------------------------------------------ roteamento
function caminhoRequisicao(): string
{
    if (!empty($_SERVER['PATH_INFO'])) return '/' . trim($_SERVER['PATH_INFO'], '/');
    $uri = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
    $base = rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '')), '/');
    if ($base !== '' && str_starts_with($uri, $base)) $uri = substr($uri, strlen($base));
    $uri = preg_replace('#^/index\.php#', '', $uri);
    return '/' . trim($uri, '/');
}

/** [metodo, padrao, funcao, descricao, quem] */
function rotas(): array
{
    return [
        ['GET',  '/v1',                              'rIndice',            'Lista as rotas', 'livre'],
        ['GET',  '/v1/saude',                        'rSaude',             'Estado da API e das integracoes', 'livre'],
        ['GET',  '/v1/openapi.json',                 'rOpenApi',           'Contrato OpenAPI 3', 'livre'],
        // Entrada: os setores mandam mensagens ao Compras
        ['POST', '/v1/mensagens',                    'rReceberMensagem',   'Recebe qualquer XML suportado (tipo pela raiz/namespace)', 'estoque, financeiro'],
        ['POST', '/v1/confirmacoes-recebimento',     'rReceberTipo',       'confirmacao-recebimento-v1 (Estoque)', 'estoque'],
        ['POST', '/v1/respostas-disponibilidade',    'rReceberTipo',       'respostaDisponibilidade (Estoque)', 'estoque'],
        ['POST', '/v1/saldos-estoque',               'rReceberTipo',       'Saldo no XML v2 do Estoque', 'estoque'],
        ['POST', '/v1/avisos-pagamento',             'rReceberTipo',       'avisoPagamento (Financeiro), XML ou JSON', 'financeiro'],
        ['POST', '/v1/respostas-pendencias',         'rReceberTipo',       'respostaPendencias (Financeiro)', 'financeiro'],
        // Saida: o Estoque busca o que o Compras publicou
        ['GET',  '/v1/recebimentos',                 'rListarPublicacoes', 'recebimento-v1 publicados (?desde=seq)', 'estoque'],
        ['GET',  '/v1/recebimentos/{seq}',           'rLerPublicacao',     'Um recebimento-v1 em XML', 'estoque'],
        ['GET',  '/v1/previsoes-entrega',            'rListarPublicacoes', 'previsao-entrega-v1 publicadas (?desde=seq)', 'estoque'],
        ['GET',  '/v1/previsoes-entrega/{seq}',      'rLerPublicacao',     'Uma previsao-entrega-v1 em XML', 'estoque'],
        ['GET',  '/v1/consultas-disponibilidade',    'rListarPublicacoes', 'consultaDisponibilidade publicadas (?desde=seq)', 'estoque'],
        ['GET',  '/v1/consultas-disponibilidade/{seq}', 'rLerPublicacao',  'Uma consultaDisponibilidade em XML', 'estoque'],
        // Painel (tela do Compras)
        ['GET',  '/v1/caixa-entrada',                'rCaixaEntrada',      'Mensagens recebidas (?desde=seq); busca avisos no Financeiro', 'painel'],
        ['POST', '/v1/publicacoes',                  'rPublicar',          'Publica recebimento, previsao ou consulta para o Estoque', 'painel'],
        ['POST', '/v1/financeiro/compras',           'rFinCompras',        'Proxy: POST /api/v1/compras do Finanweb', 'painel'],
        ['GET',  '/v1/financeiro/pendencias',        'rFinPendencias',     'Proxy: GET /api/v1/pendencias do Finanweb', 'painel'],
        ['POST', '/v1/financeiro/avisos-pagamento/buscar', 'rFinBuscarAvisos', 'Busca agora os avisos no Finanweb', 'painel'],
        ['GET',  '/v1/estoque/xml',                  'rEstoqueProxy',      'Proxy: GET /api/xml do Estoque (saldo)', 'painel'],
        ['POST', '/v1/estoque/xml/validar',          'rEstoqueProxy',      'Proxy: POST /api/xml/validar do Estoque', 'painel'],
        ['POST', '/v1/estoque/xml',                  'rEstoqueProxy',      'Proxy: POST /api/xml do Estoque (importa)', 'painel'],
    ];
}

function despachar(): void
{
    $metodo = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    $caminho = caminhoRequisicao();
    if ($caminho === '/') $caminho = '/v1';
    $permitidos = [];
    foreach (rotas() as [$m, $padrao, $fn]) {
        $re = '#^' . preg_replace('#\\\{(\w+)\\\}#', '(?P<$1>\d+)', preg_quote($padrao, '#')) . '$#';
        if (!preg_match($re, $caminho, $p)) continue;
        if ($m !== $metodo) { $permitidos[] = $m; continue; }
        $fn(array_filter($p, 'is_string', ARRAY_FILTER_USE_KEY) + ['_rota' => $padrao]);
        return;
    }
    if ($permitidos) throw new ErroApi(405, 'Metodo nao permitido. Use ' . implode(', ', array_unique($permitidos)) . '.');
    throw new ErroApi(404, "Rota $metodo $caminho nao existe. Veja GET /v1.");
}

// ------------------------------------------------------------------ rotas livres
function rIndice(): void
{
    responderJson(200, [
        'api' => 'Controle de Compras - Projeto Arruda',
        'versao' => VERSAO_API,
        'autenticacao' => 'Authorization: Bearer <chave do setor>',
        'rotas' => array_map(fn($r) => ['metodo' => $r[0], 'caminho' => $r[1], 'descricao' => $r[3], 'quem' => $r[4]], rotas()),
    ]);
}

function rSaude(): void
{
    $cfg = config();
    $banco = 'ok';
    try { db()->query('SELECT 1'); } catch (Throwable $e) { $banco = $e->getMessage(); }
    $setores = array_values(array_unique(array_filter(array_map(
        fn($c, $s) => str_starts_with((string)$c, 'TROQUE') ? null : $s, array_keys($cfg['chaves'] ?? []), $cfg['chaves'] ?? []))));
    responderJson(200, [
        'ok' => $banco === 'ok',
        'versao' => VERSAO_API,
        'agora' => agoraIso(),
        'php' => PHP_VERSION,
        'extensoes' => ['pdo_sqlite' => extension_loaded('pdo_sqlite'), 'curl' => extension_loaded('curl'), 'dom' => extension_loaded('dom')],
        'banco' => $banco,
        'setores_com_chave' => $setores,
        'financeiro' => [
            'proxy' => !empty($cfg['financeiro']['chave']),
            'ultima_busca_avisos' => ($t = kvLerSeguro('fin_avisos_ultima_busca')) ? gmdate('Y-m-d\TH:i:s\Z', (int)$t) : null,
            'ultimo_erro' => kvLerSeguro('fin_avisos_erro'),
        ],
        'estoque' => ['proxy' => !empty($cfg['estoque']['url'])],
    ]);
}

function kvLerSeguro(string $k): ?string
{
    try { return kvLer($k); } catch (Throwable $e) { return null; }
}

function rOpenApi(): void
{
    header('Content-Type: application/json; charset=utf-8');
    readfile(__DIR__ . '/openapi.json');
}

// ------------------------------------------------------------------ entrada (setores -> Compras)
const ROTA_TIPO = [
    '/v1/confirmacoes-recebimento'  => 'confirmacao-recebimento',
    '/v1/respostas-disponibilidade' => 'resposta-disponibilidade',
    '/v1/saldos-estoque'            => 'saldo-estoque',
    '/v1/avisos-pagamento'          => 'aviso-pagamento',
    '/v1/respostas-pendencias'      => 'resposta-pendencias',
];

function rReceberMensagem(array $p): void
{
    $setor = autenticar(['estoque', 'financeiro']);
    receber($setor, null);
}

function rReceberTipo(array $p): void
{
    $tipo = ROTA_TIPO[$p['_rota']];
    $setor = autenticar(TIPOS_ENTRADA[$tipo]['setores']);
    if ($tipo === 'aviso-pagamento' && tipoConteudo() === 'application/json') { receberAvisoJson($setor); return; }
    receber($setor, $tipo);
}

function receber(string $setor, ?string $esperado): void
{
    $xml = exigirXml();
    $doc = carregarXml($xml);
    $tipo = classificar($doc, TIPOS_ENTRADA);
    if ($tipo === null) {
        throw new ErroApi(422, 'XML nao reconhecido: raiz <' . $doc->documentElement->localName . '> nao e um contrato que o Compras recebe.',
            ['aceitos' => array_keys(TIPOS_ENTRADA)]);
    }
    if ($esperado !== null && $tipo !== $esperado) throw new ErroApi(422, "Esta rota recebe $esperado, mas o XML e $tipo. Use POST /v1/mensagens.");
    $c = TIPOS_ENTRADA[$tipo];
    if ($setor !== 'painel' && !in_array($setor, $c['setores'], true)) throw new ErroApi(403, "O setor \"$setor\" nao envia $tipo.");
    validarXsd($doc, $c['xsd']);
    [$seq, $dup] = gravarMensagem($tipo, 'xml', $setor, referenciaXml($doc), $xml);
    responderJson($dup ? 200 : 202, ['ok' => true, 'seq' => $seq, 'tipo' => $tipo, 'duplicada' => $dup,
        'mensagem' => $dup ? 'Mensagem ja recebida antes; nada mudou.' : 'Recebida. O Compras aplica na proxima leitura da caixa de entrada.']);
}

/** avisoPagamento em JSON, no mesmo formato do GET /api/v1/avisos-pagamento do Finanweb. */
function receberAvisoJson(string $setor): void
{
    $a = exigirJson();
    validarAvisoJson($a);
    [$seq, $dup] = gravarMensagem('aviso-pagamento', 'json', $setor, (string)$a['referencia'],
        json_encode($a, JSON_UNESCAPED_UNICODE), 'id:' . $a['id']);
    responderJson($dup ? 200 : 202, ['ok' => true, 'seq' => $seq, 'tipo' => 'aviso-pagamento', 'duplicada' => $dup]);
}

function validarAvisoJson(array $a): void
{
    $faltam = array_diff(['id', 'origem', 'referencia', 'situacao', 'valor'], array_keys(array_filter($a, fn($v) => $v !== null && $v !== '')));
    if ($faltam) throw new ErroApi(422, 'avisoPagamento sem: ' . implode(', ', $faltam) . '.');
    if (!in_array($a['situacao'], ['PAGO', 'CANCELADO'], true)) throw new ErroApi(422, 'situacao deve ser PAGO ou CANCELADO.');
    if (!is_numeric($a['valor']) || $a['valor'] < 0) throw new ErroApi(422, 'valor deve ser numero >= 0.');
}

// ------------------------------------------------------------------ publicacoes (Compras -> Estoque busca)
const ROTA_PUB = [
    '/v1/recebimentos' => 'recebimento', '/v1/recebimentos/{seq}' => 'recebimento',
    '/v1/previsoes-entrega' => 'previsao-entrega', '/v1/previsoes-entrega/{seq}' => 'previsao-entrega',
    '/v1/consultas-disponibilidade' => 'consulta-disponibilidade', '/v1/consultas-disponibilidade/{seq}' => 'consulta-disponibilidade',
];

function rPublicar(): void
{
    autenticar(['painel']);
    $d = exigirJson();
    $tipo = (string)($d['tipo'] ?? '');
    if (!isset(TIPOS_PUBLICACAO[$tipo])) throw new ErroApi(422, 'tipo deve ser: ' . implode(', ', array_keys(TIPOS_PUBLICACAO)) . '.');
    $xml = trim((string)($d['xml'] ?? ''));
    if ($xml === '') throw new ErroApi(422, 'Informe o xml.');
    $doc = carregarXml($xml);
    if (classificar($doc, [$tipo => TIPOS_PUBLICACAO[$tipo]]) !== $tipo) throw new ErroApi(422, "O XML nao e um $tipo.");
    validarXsd($doc, TIPOS_PUBLICACAO[$tipo]['xsd']);
    $hash = hash('sha256', $xml);
    $st = db()->prepare('SELECT seq FROM publicacoes WHERE tipo = ? AND hash = ?');
    $st->execute([$tipo, $hash]);
    if (($seq = $st->fetchColumn()) !== false) {
        responderJson(200, ['ok' => true, 'seq' => (int)$seq, 'duplicada' => true]);
        return;
    }
    $ref = isset($d['referencia']) ? substr((string)$d['referencia'], 0, 100) : referenciaXml($doc);
    db()->prepare('INSERT INTO publicacoes (tipo, referencia, publicado_em, hash, xml) VALUES (?,?,?,?,?)')
        ->execute([$tipo, $ref, agoraIso(), $hash, $xml]);
    responderJson(201, ['ok' => true, 'seq' => (int)db()->lastInsertId(), 'duplicada' => false]);
}

function rListarPublicacoes(array $p): void
{
    autenticar(['estoque']);
    $tipo = ROTA_PUB[$p['_rota']];
    $desde = max(0, (int)($_GET['desde'] ?? 0));
    $limite = min(200, max(1, (int)($_GET['limite'] ?? 50)));
    $st = db()->prepare('SELECT seq, referencia, publicado_em, xml FROM publicacoes WHERE tipo = ? AND seq > ? ORDER BY seq LIMIT ?');
    $st->execute([$tipo, $desde, $limite]);
    $itens = array_map(fn($r) => ['seq' => (int)$r['seq'], 'referencia' => $r['referencia'], 'publicadoEm' => $r['publicado_em'], 'xml' => $r['xml']], $st->fetchAll());
    responderJson(200, ['tipo' => $tipo, 'desde' => $desde, 'ultimo' => $itens ? end($itens)['seq'] : $desde, 'itens' => $itens]);
}

function rLerPublicacao(array $p): void
{
    autenticar(['estoque']);
    $st = db()->prepare('SELECT xml FROM publicacoes WHERE tipo = ? AND seq = ?');
    $st->execute([ROTA_PUB[$p['_rota']], (int)$p['seq']]);
    $xml = $st->fetchColumn();
    if ($xml === false) throw new ErroApi(404, 'Publicacao nao encontrada.');
    responderXml(200, (string)$xml);
}

// ------------------------------------------------------------------ painel: caixa de entrada
function rCaixaEntrada(): void
{
    autenticar(['painel']);
    $busca = buscarAvisosFinanceiro(false);
    $desde = max(0, (int)($_GET['desde'] ?? 0));
    $st = db()->prepare('SELECT seq, tipo, formato, de, referencia, recebido_em, conteudo FROM mensagens WHERE seq > ? ORDER BY seq LIMIT 100');
    $st->execute([$desde]);
    $itens = array_map(fn($r) => [
        'seq' => (int)$r['seq'], 'tipo' => $r['tipo'], 'formato' => $r['formato'], 'de' => $r['de'],
        'referencia' => $r['referencia'], 'recebidoEm' => $r['recebido_em'], 'conteudo' => $r['conteudo'],
    ], $st->fetchAll());
    responderJson(200, ['desde' => $desde, 'ultimo' => $itens ? end($itens)['seq'] : $desde, 'itens' => $itens, 'financeiro' => $busca]);
}

/**
 * Busca os avisos de pagamento no Finanweb (que nao chama o Compras: a gente busca)
 * e grava cada um na caixa de entrada. Respeita o intervalo minimo e o Retry-After.
 */
function buscarAvisosFinanceiro(bool $forcar): array
{
    $cfg = config()['financeiro'] ?? [];
    if (empty($cfg['chave']) || empty($cfg['url'])) return ['ativo' => false];
    $agora = time();
    $proxima = (int)kvLer('fin_avisos_proxima', '0');
    if (!$forcar && $agora < $proxima) return ['ativo' => true, 'buscou' => false];
    kvGravar('fin_avisos_ultima_busca', (string)$agora);
    kvGravar('fin_avisos_proxima', (string)($agora + (int)($cfg['intervalo_avisos'] ?? 60)));

    $desde = kvLer('fin_avisos_desde');
    $q = ['origem' => ORIGEM_SETOR] + ($desde ? ['desde' => $desde] : []);
    $url = rtrim($cfg['url'], '/') . '/api/v1/avisos-pagamento?' . http_build_query($q);
    try {
        $r = chamarExterno('GET', $url, null, ['Authorization: Bearer ' . $cfg['chave'], 'Accept: application/json']);
    } catch (ErroApi $e) {
        kvGravar('fin_avisos_erro', $e->getMessage());
        return ['ativo' => true, 'buscou' => true, 'erro' => $e->getMessage()];
    }
    if ($r['status'] === 429 && isset($r['cabecalhos']['retry-after'])) {
        kvGravar('fin_avisos_proxima', (string)($agora + max(1, (int)$r['cabecalhos']['retry-after'])));
    }
    $j = json_decode($r['corpo'], true);
    if ($r['status'] !== 200 || !is_array($j) || !isset($j['avisos']) || !is_array($j['avisos'])) {
        $msg = "Finanweb respondeu {$r['status']}: " . (is_array($j) ? ($j['erro'] ?? 'resposta inesperada') : substr($r['corpo'], 0, 200));
        kvGravar('fin_avisos_erro', $msg);
        return ['ativo' => true, 'buscou' => true, 'erro' => $msg];
    }
    $novos = 0;
    foreach ($j['avisos'] as $a) {
        if (!is_array($a) || empty($a['id'])) continue;
        [, $dup] = gravarMensagem('aviso-pagamento', 'json', 'financeiro-api', (string)($a['referencia'] ?? ''),
            json_encode($a, JSON_UNESCAPED_UNICODE), 'id:' . $a['id']);
        if (!$dup) $novos++;
        if (!empty($a['geradoEm']) && (!$desde || strcmp((string)$a['geradoEm'], $desde) > 0)) $desde = (string)$a['geradoEm'];
    }
    if ($desde) kvGravar('fin_avisos_desde', $desde);
    kvGravar('fin_avisos_erro', null);
    return ['ativo' => true, 'buscou' => true, 'novos' => $novos];
}

function rFinBuscarAvisos(): void
{
    autenticar(['painel']);
    $r = buscarAvisosFinanceiro(true);
    if (!$r['ativo']) throw new ErroApi(503, 'Chave do Financeiro nao configurada no config.php.');
    responderJson(isset($r['erro']) ? 502 : 200, ['ok' => !isset($r['erro'])] + $r);
}

// ------------------------------------------------------------------ painel: proxies
function cfgFinanceiro(): array
{
    $cfg = config()['financeiro'] ?? [];
    if (empty($cfg['chave']) || empty($cfg['url'])) throw new ErroApi(503, 'Chave do Financeiro nao configurada no config.php.');
    return $cfg;
}

function rFinCompras(): void
{
    autenticar(['painel']);
    $cfg = cfgFinanceiro();
    $corpo = exigirJson();
    repassar(chamarExterno('POST', rtrim($cfg['url'], '/') . '/api/v1/compras', json_encode($corpo, JSON_UNESCAPED_UNICODE),
        ['Authorization: Bearer ' . $cfg['chave'], 'Content-Type: application/json', 'Accept: application/json']));
}

function rFinPendencias(): void
{
    autenticar(['painel']);
    $cfg = cfgFinanceiro();
    // a origem e sempre o proprio setor (o Finanweb recusa origem de outro setor com 403)
    $q = ['origem' => ORIGEM_SETOR] + array_intersect_key($_GET, array_flip(['documento', 'id']));
    $url = rtrim($cfg['url'], '/') . '/api/v1/pendencias?' . http_build_query($q);
    repassar(chamarExterno('GET', $url, null, ['Authorization: Bearer ' . $cfg['chave'], 'Accept: application/json']));
}

/** Repassa ao Estoque. A URL vem do config.php (nao do cliente), entao nao vira proxy aberto. */
function rEstoqueProxy(array $p): void
{
    autenticar(['painel']);
    $cfg = config()['estoque'] ?? [];
    if (empty($cfg['url'])) throw new ErroApi(503, 'URL do Estoque nao configurada no config.php.');
    $destino = substr($p['_rota'], strlen('/v1/estoque'));   // /xml ou /xml/validar
    $cab = ['Accept: application/xml, application/json'];
    if (!empty($cfg['chave'])) $cab[] = 'Authorization: Bearer ' . $cfg['chave'];
    $metodo = $_SERVER['REQUEST_METHOD'];
    $corpo = null;
    if ($metodo === 'POST') { $corpo = exigirXml(); $cab[] = 'Content-Type: application/xml'; }
    repassar(chamarExterno($metodo, rtrim($cfg['url'], '/') . '/api' . $destino, $corpo, $cab));
}

// ------------------------------------------------------------------ execucao
try {
    header('X-Content-Type-Options: nosniff');
    aplicarCors();
    if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') { http_response_code(204); exit; }
    despachar();
} catch (ErroApi $e) {
    $cab = !empty($e->extra['www']) ? ['WWW-Authenticate' => 'Bearer'] : [];
    unset($e->extra['www']);
    responderJson($e->getCode(), ['ok' => false, 'erro' => $e->getMessage()] + $e->extra, $cab);
} catch (Throwable $e) {
    error_log('[api-compras] ' . $e);
    responderJson(500, ['ok' => false, 'erro' => 'Erro interno no servidor do Compras.']);
}
