<?php
/*
 * Configuracao da API REST do Compras.
 * Copie este arquivo para config.php (mesma pasta) e troque as chaves.
 * O config.php fica fora do Git (.gitignore) e o .htaccess bloqueia o acesso pela web.
 *
 * Gere chaves fortes, por exemplo:  php -r "echo bin2hex(random_bytes(24)), PHP_EOL;"
 */
return [
    // Chave Bearer => setor. Cada setor recebe a sua chave e manda no cabecalho:
    //   Authorization: Bearer <chave>
    // "painel" e a tela do proprio Compras (index.html): pode tudo.
    'chaves' => [
        'TROQUE-chave-do-painel-do-compras' => 'painel',
        'TROQUE-chave-entregue-ao-estoque'   => 'estoque',
        'TROQUE-chave-entregue-ao-financeiro'=> 'financeiro',
    ],

    // Origens que podem chamar a API pelo navegador (CORS). ['*'] libera todas.
    // A autenticacao e por Bearer (sem cookie), entao '*' e aceitavel; restrinja se quiser.
    'cors_origens' => ['*'],

    // API do Financeiro (Finanweb). A chave e emitida pelo Financeiro para o setor "compras".
    'financeiro' => [
        'url'              => 'https://finanwebsistema.vercel.app',
        'chave'            => '',   // Bearer do Finanweb; vazio desliga o proxy e a busca de avisos
        'intervalo_avisos' => 60,   // segundos minimos entre duas buscas automaticas de avisos de pagamento
    ],

    // API do Estoque (XML v2: GET /api/xml, POST /api/xml/validar e /api/xml).
    'estoque' => [
        'url'   => 'https://sistema-de-estoque-cyan.vercel.app',
        'chave' => '',              // se o Estoque exigir Bearer, coloque aqui
    ],

    // Banco SQLite (a pasta dados/ e bloqueada pelo .htaccess).
    'banco' => __DIR__ . '/dados/compras.sqlite',

    // Tamanho maximo do corpo das requisicoes, em bytes.
    'limite_corpo' => 1000000,

    // Tempo limite das chamadas as APIs dos outros setores, em segundos.
    'timeout' => 20,
];
