<?php
/*
 * Gera uma API key para cada sistema que se conecta ao Compras e monta o
 * public_html/compras/api/config.php a partir do config.exemplo.php.
 *
 * Uso (na raiz do repositorio):
 *   php ferramentas/gerar-chaves.php            cria o config.php (nao sobrescreve)
 *   php ferramentas/gerar-chaves.php --forcar   troca TODAS as chaves de um config.php existente
 *
 * Fica fora de public_html/ de proposito: nao vai para o servidor e nao pode ser chamado pela web.
 * O config.php gerado esta no .gitignore. Nunca faca commit dele.
 */
declare(strict_types=1);

if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }

// setor => para quem a chave e entregue
const SETORES = [
    'painel'     => 'tela do proprio Compras (aba API REST); nao entregue a ninguem',
    'estoque'    => 'equipe do Estoque',
    'financeiro' => 'equipe do Financeiro',
];

$dir     = dirname(__DIR__) . '/public_html/compras/api';
$exemplo = $dir . '/config.exemplo.php';
$destino = $dir . '/config.php';
$forcar  = in_array('--forcar', $argv, true);

if (!is_file($exemplo)) { fwrite(STDERR, "Nao encontrei $exemplo\n"); exit(1); }

if (is_file($destino) && !$forcar) {
    fwrite(STDERR, "Ja existe $destino.\nUse --forcar para gerar chaves novas (as antigas param de funcionar).\n");
    exit(1);
}

// Com --forcar, preserva o resto do config.php atual (URLs, chave do Finanweb etc.) e troca so as chaves.
$base = ($forcar && is_file($destino)) ? file_get_contents($destino) : file_get_contents($exemplo);

$chaves = [];
foreach (array_keys(SETORES) as $setor) $chaves[$setor] = bin2hex(random_bytes(24));

$linhas = '';
foreach ($chaves as $setor => $chave) $linhas .= "        '$chave' => '$setor',\n";

$novo = preg_replace("/('chaves'\s*=>\s*\[)[^\]]*(\])/s", "$1\n$linhas    $2", $base, 1, $trocas);
if ($trocas !== 1) { fwrite(STDERR, "Nao achei o bloco 'chaves' em " . basename($forcar ? $destino : $exemplo) . "\n"); exit(1); }

file_put_contents($destino, $novo);
@chmod($destino, 0640);

echo "config.php gravado em $destino\n\n";
foreach ($chaves as $setor => $chave) {
    printf("%-11s %s\n            -> %s\n", $setor, $chave, SETORES[$setor]);
}
echo "\nEntregue cada chave por canal privado. Falta preencher a mao: financeiro.chave (emitida pelo Finanweb).\n";
