<?php
/*
 * lib.php - utilitarios da API REST do Compras: resposta JSON, autenticacao,
 * banco SQLite, classificacao/validacao de XML pelos contratos e cliente HTTP.
 */
declare(strict_types=1);

const VERSAO_API = '1.0.0';
const ORIGEM_SETOR = 'compras';   // nome do setor no Finanweb e no servidor da turma
const DIR_CONTRATOS = __DIR__ . '/../contratos';

/** Erro que vira resposta HTTP { ok:false, erro } com o status informado. */
final class ErroApi extends RuntimeException
{
    public array $extra;
    public function __construct(int $status, string $mensagem, array $extra = [])
    {
        parent::__construct($mensagem, $status);
        $this->extra = $extra;
    }
}

// ------------------------------------------------------------------ configuracao
function config(): array
{
    static $cfg = null;
    if ($cfg !== null) return $cfg;
    $arq = __DIR__ . '/config.php';
    if (!is_file($arq)) {
        throw new ErroApi(503, 'API sem configuracao: copie config.exemplo.php para config.php e defina as chaves.');
    }
    $cfg = require $arq;
    return $cfg;
}

// ------------------------------------------------------------------ resposta
function responderJson(int $status, $dados, array $cabecalhos = []): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    foreach ($cabecalhos as $k => $v) header("$k: $v");
    echo json_encode($dados, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRESERVE_ZERO_FRACTION);
}

function responderXml(int $status, string $xml): void
{
    http_response_code($status);
    header('Content-Type: application/xml; charset=utf-8');
    echo $xml;
}

function aplicarCors(): void
{
    $origem = $_SERVER['HTTP_ORIGIN'] ?? '';
    $permitidas = config()['cors_origens'] ?? ['*'];
    if (in_array('*', $permitidas, true)) {
        header('Access-Control-Allow-Origin: *');
    } elseif ($origem !== '' && in_array($origem, $permitidas, true)) {
        header("Access-Control-Allow-Origin: $origem");
        header('Vary: Origin');
    }
    header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
    header('Access-Control-Allow-Headers: Authorization, Content-Type, Accept');
    header('Access-Control-Max-Age: 600');
}

// ------------------------------------------------------------------ requisicao
function corpoRequisicao(): string
{
    $limite = (int)(config()['limite_corpo'] ?? 1000000);
    $tam = (int)($_SERVER['CONTENT_LENGTH'] ?? 0);
    if ($tam > $limite) throw new ErroApi(413, "Corpo maior que o limite de $limite bytes.");
    $corpo = (string)file_get_contents('php://input', false, null, 0, $limite + 1);
    if (strlen($corpo) > $limite) throw new ErroApi(413, "Corpo maior que o limite de $limite bytes.");
    return preg_replace('/^\xEF\xBB\xBF/', '', $corpo); // remove BOM
}

function tipoConteudo(): string
{
    $ct = strtolower($_SERVER['CONTENT_TYPE'] ?? $_SERVER['HTTP_CONTENT_TYPE'] ?? '');
    return trim(explode(';', $ct)[0]);
}

function exigirJson(): array
{
    if (tipoConteudo() !== 'application/json') throw new ErroApi(415, 'Envie Content-Type: application/json.');
    $dados = json_decode(corpoRequisicao(), true);
    if (!is_array($dados)) throw new ErroApi(400, 'O corpo nao e um objeto JSON valido.');
    return $dados;
}

function exigirXml(): string
{
    $ct = tipoConteudo();
    if (!in_array($ct, ['application/xml', 'text/xml', 'text/plain'], true)) {
        throw new ErroApi(415, 'Envie o XML com Content-Type: application/xml.');
    }
    $xml = trim(corpoRequisicao());
    if ($xml === '') throw new ErroApi(400, 'Corpo vazio: envie o XML.');
    return $xml;
}

/** Le o Bearer do cabecalho (Apache/LiteSpeed as vezes o move para REDIRECT_HTTP_AUTHORIZATION). */
function tokenBearer(): string
{
    $h = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
    if ($h === '' && function_exists('getallheaders')) {
        foreach (getallheaders() as $k => $v) if (strcasecmp($k, 'Authorization') === 0) $h = $v;
    }
    return preg_match('/^\s*Bearer\s+(\S+)\s*$/i', $h, $m) ? $m[1] : '';
}

/**
 * Autentica pela chave e devolve o setor. $permitidos limita quais setores podem usar a rota
 * ("painel" sempre pode).
 */
function autenticar(array $permitidos = []): string
{
    $token = tokenBearer();
    if ($token === '') throw new ErroApi(401, 'Informe a chave: Authorization: Bearer <chave>.', ['www' => true]);
    $setor = null;
    foreach (config()['chaves'] ?? [] as $chave => $s) {
        if (str_starts_with((string)$chave, 'TROQUE')) continue; // chaves de exemplo nao valem
        if (hash_equals((string)$chave, $token)) { $setor = (string)$s; break; }
    }
    if ($setor === null) throw new ErroApi(401, 'Chave invalida.', ['www' => true]);
    if ($setor !== 'painel' && $permitidos && !in_array($setor, $permitidos, true)) {
        throw new ErroApi(403, "O setor \"$setor\" nao pode usar esta rota.");
    }
    return $setor;
}

// ------------------------------------------------------------------ banco
function db(): PDO
{
    static $pdo = null;
    if ($pdo) return $pdo;
    if (!in_array('sqlite', PDO::getAvailableDrivers(), true)) {
        throw new ErroApi(503, 'O PHP do servidor nao tem o driver pdo_sqlite habilitado.');
    }
    $arq = config()['banco'];
    if (!is_dir(dirname($arq))) mkdir(dirname($arq), 0750, true);
    $pdo = new PDO('sqlite:' . $arq, null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
    $pdo->exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    $pdo->exec(<<<SQL
        CREATE TABLE IF NOT EXISTS mensagens (
            seq         INTEGER PRIMARY KEY AUTOINCREMENT,
            tipo        TEXT NOT NULL,
            formato     TEXT NOT NULL,          -- xml | json
            de          TEXT NOT NULL,          -- setor que enviou (ou "financeiro-api" na busca automatica)
            referencia  TEXT,
            recebido_em TEXT NOT NULL,
            hash        TEXT NOT NULL UNIQUE,   -- idempotencia: o mesmo conteudo nao entra duas vezes
            conteudo    TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS publicacoes (
            seq          INTEGER PRIMARY KEY AUTOINCREMENT,
            tipo         TEXT NOT NULL,
            referencia   TEXT,
            publicado_em TEXT NOT NULL,
            hash         TEXT NOT NULL,
            xml          TEXT NOT NULL,
            UNIQUE (tipo, hash)
        );
        CREATE TABLE IF NOT EXISTS kv (chave TEXT PRIMARY KEY, valor TEXT);
    SQL);
    return $pdo;
}

function kvLer(string $chave, ?string $padrao = null): ?string
{
    $st = db()->prepare('SELECT valor FROM kv WHERE chave = ?');
    $st->execute([$chave]);
    $v = $st->fetchColumn();
    return ($v === false || $v === null) ? $padrao : (string)$v;
}

function kvGravar(string $chave, ?string $valor): void
{
    db()->prepare('INSERT INTO kv (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor')
        ->execute([$chave, $valor]);
}

function agoraIso(): string
{
    return gmdate('Y-m-d\TH:i:s\Z');
}

// ------------------------------------------------------------------ contratos XML
/*
 * Tipos de mensagem que o Compras RECEBE (caixa de entrada) e que PUBLICA (para o Estoque buscar).
 * raiz/ns identificam o contrato; xsd (se houver) e validado no servidor; setores = quem pode enviar.
 */
const TIPOS_ENTRADA = [
    'confirmacao-recebimento' => ['raiz' => 'confirmacaoRecebimento', 'ns' => 'urn:compras:confirmacao-recebimento:1.0',
                                  'xsd' => 'confirmacao-recebimento-v1.xsd', 'setores' => ['estoque']],
    'resposta-disponibilidade' => ['raiz' => 'respostaDisponibilidade', 'ns' => '',
                                  'xsd' => 'disponibilidade-estoque.xsd', 'setores' => ['estoque']],
    'saldo-estoque'           => ['raiz' => 'estoque', 'ns' => '', 'xsd' => null, 'setores' => ['estoque']],
    'aviso-pagamento'         => ['raiz' => 'avisoPagamento', 'ns' => 'urn:finanweb:aviso-pagamento:1.0',
                                  'xsd' => null, 'setores' => ['financeiro']],
    'resposta-pendencias'     => ['raiz' => 'respostaPendencias', 'ns' => 'urn:finanweb:pendencias-fornecedor:1.0',
                                  'xsd' => null, 'setores' => ['financeiro']],
];

const TIPOS_PUBLICACAO = [
    'recebimento'              => ['raiz' => 'movimento', 'ns' => 'urn:compras:recebimento:1.0', 'xsd' => 'recebimento-v1.xsd'],
    'previsao-entrega'         => ['raiz' => 'movimento', 'ns' => 'urn:compras:previsao-entrega:1.0', 'xsd' => 'previsao-entrega-v1.xsd'],
    'consulta-disponibilidade' => ['raiz' => 'consultaDisponibilidade', 'ns' => '', 'xsd' => 'disponibilidade-estoque.xsd'],
];

/** Faz o parse seguro (sem rede, sem entidades externas). Lanca 400 se mal formado. */
function carregarXml(string $xml): DOMDocument
{
    if (preg_match('/<!DOCTYPE/i', $xml)) throw new ErroApi(400, 'XML com DOCTYPE nao e aceito.');
    $doc = new DOMDocument();
    $ant = libxml_use_internal_errors(true);
    $ok = $doc->loadXML($xml, LIBXML_NONET | LIBXML_NOCDATA);
    $erros = libxml_get_errors();
    libxml_clear_errors();
    libxml_use_internal_errors($ant);
    if (!$ok || !$doc->documentElement) {
        $msg = $erros ? trim($erros[0]->message) . ' (linha ' . $erros[0]->line . ')' : 'documento vazio';
        throw new ErroApi(400, "XML mal formado: $msg.");
    }
    return $doc;
}

/** Descobre o tipo pelo elemento raiz + namespace, numa das tabelas acima. */
function classificar(DOMDocument $doc, array $tabela): ?string
{
    $raiz = $doc->documentElement;
    foreach ($tabela as $tipo => $c) {
        if ($raiz->localName === $c['raiz'] && (string)$raiz->namespaceURI === $c['ns']) {
            if ($tipo === 'saldo-estoque' && $raiz->getAttribute('versao') !== '2') continue;
            return $tipo;
        }
    }
    return null;
}

/** Valida contra o XSD local do contrato. Lanca 422 com as mensagens do libxml. */
function validarXsd(DOMDocument $doc, ?string $xsd): void
{
    if (!$xsd) return;
    $ant = libxml_use_internal_errors(true);
    $ok = $doc->schemaValidate(DIR_CONTRATOS . '/' . $xsd);
    $erros = array_map(fn($e) => trim($e->message) . ' (linha ' . $e->line . ')', libxml_get_errors());
    libxml_clear_errors();
    libxml_use_internal_errors($ant);
    if (!$ok) throw new ErroApi(422, "Fora do contrato $xsd: " . ($erros[0] ?? 'invalido'), ['detalhes' => array_slice($erros, 0, 20)]);
}

/** Referencia "humana" da mensagem, para listar e filtrar (id da consulta, referencia do aviso etc.). */
function referenciaXml(DOMDocument $doc): ?string
{
    $r = $doc->documentElement;
    if ($r->getAttribute('id') !== '') return $r->getAttribute('id');
    $xp = new DOMXPath($doc);
    foreach (['(//@referencia)[1]', "(//*[local-name()='idConsulta'])[1]", "(//*[local-name()='referencia'])[1]"] as $q) {
        $n = $xp->query($q);
        if ($n && $n->length) return substr(trim($n->item(0)->nodeValue), 0, 100);
    }
    return null;
}

// ------------------------------------------------------------------ caixa de entrada
/** Grava na caixa de entrada. Devolve [seq, duplicada]. */
function gravarMensagem(string $tipo, string $formato, string $de, ?string $referencia, string $conteudo, ?string $chaveIdem = null): array
{
    $hash = hash('sha256', $tipo . '|' . ($chaveIdem ?? $conteudo));
    $st = db()->prepare('SELECT seq FROM mensagens WHERE hash = ?');
    $st->execute([$hash]);
    if (($seq = $st->fetchColumn()) !== false) return [(int)$seq, true];
    db()->prepare('INSERT INTO mensagens (tipo, formato, de, referencia, recebido_em, hash, conteudo) VALUES (?,?,?,?,?,?,?)')
        ->execute([$tipo, $formato, $de, $referencia, agoraIso(), $hash, $conteudo]);
    return [(int)db()->lastInsertId(), false];
}

// ------------------------------------------------------------------ cliente HTTP (APIs dos outros setores)
/** Chama uma API externa. Devolve ['status'=>int, 'corpo'=>string, 'tipo'=>string, 'cabecalhos'=>array]. */
function chamarExterno(string $metodo, string $url, ?string $corpo = null, array $cabecalhos = []): array
{
    if (!function_exists('curl_init')) throw new ErroApi(503, 'O PHP do servidor nao tem a extensao curl.');
    $resp = [];
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_CUSTOMREQUEST  => $metodo,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => (int)(config()['timeout'] ?? 20),
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_PROTOCOLS      => CURLPROTO_HTTPS | CURLPROTO_HTTP,
        CURLOPT_HTTPHEADER     => $cabecalhos,
        CURLOPT_HEADERFUNCTION => function ($c, $linha) use (&$resp) {
            $p = explode(':', $linha, 2);
            if (count($p) === 2) $resp[strtolower(trim($p[0]))] = trim($p[1]);
            return strlen($linha);
        },
    ]);
    if ($corpo !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, $corpo);
    $saida = curl_exec($ch);
    if ($saida === false) {
        $erro = curl_error($ch);
        curl_close($ch);
        throw new ErroApi(502, "Nao consegui falar com $url: $erro");
    }
    $status = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    return ['status' => $status, 'corpo' => (string)$saida, 'tipo' => $resp['content-type'] ?? '', 'cabecalhos' => $resp];
}

/** Repassa a resposta externa como veio (status, tipo e Retry-After). */
function repassar(array $r): void
{
    http_response_code($r['status']);
    header('Content-Type: ' . ($r['tipo'] ?: 'application/octet-stream'));
    if (isset($r['cabecalhos']['retry-after'])) header('Retry-After: ' . $r['cabecalhos']['retry-after']);
    echo $r['corpo'];
}
