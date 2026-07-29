<?php
// proxy.php — Allgemeiner CORS-Proxy für MIM Front Office (siehe Chat)
// Ersatz/Ergänzung für die bisherigen öffentlichen Gratis-Proxies (corsfix, cors.sh,
// corsproxy.io, allorigins), die uns wiederholt Probleme gemacht haben (Timeouts,
// JSON-Wrapping bei großen Dateien, Rate-Limits). Läuft jetzt auf unserem eigenen
// Server — PHP unterliegt keinen Browser-CORS-Regeln, kann also serverseitig
// beliebige erlaubte URLs abrufen und die Rohbytes mit passenden CORS-Headern an
// den Browser zurückgeben.
//
// Nutzung: https://mim-frontoffice.de/proxy.php?url=<urlencoded target>
//
// Sicherheits-Whitelist: NUR bekannte, im Hub tatsächlich genutzte Datenquellen
// werden durchgelassen — sonst wäre das ein offener Relay, den jeder für beliebige
// URLs missbrauchen könnte (Kosten/Missbrauchsrisiko für unseren eigenen Server).

header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

$url = $_GET['url'] ?? '';
if (!$url) {
    http_response_code(400);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'Fehlender url-Parameter. Nutzung: proxy.php?url=<urlencoded target>';
    exit;
}

// Domain-Whitelist — bei Bedarf hier neue, tatsächlich benötigte Quellen ergänzen.
$allowedHosts = [
    'github.com',
    'raw.githubusercontent.com',
    'release-assets.githubusercontent.com',
    'objects.githubusercontent.com',
    'api.sleeper.app',
    'api.sleeper.com',
    'sports.core.api.espn.com',
    'site.api.espn.com',
    'www.pff.com',
    'ncaa-api.henrygd.me',
];

$parsedHost = parse_url($url, PHP_URL_HOST);
if (!$parsedHost || !in_array($parsedHost, $allowedHosts, true)) {
    http_response_code(403);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'Domain nicht erlaubt: ' . htmlspecialchars($parsedHost ?? '(ungültige URL)');
    exit;
}

$ch = curl_init($url);
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_FOLLOWLOCATION => true,   // wichtig: GitHub-Release-Downloads leiten per 302 weiter
    CURLOPT_MAXREDIRS => 5,
    CURLOPT_TIMEOUT => 60,             // großzügig — die Contracts/ID-Crosswalk-Dateien sind mehrere MB groß
    CURLOPT_HEADER => true,
    CURLOPT_SSL_VERIFYPEER => true,
    CURLOPT_USERAGENT => 'MIM-Front-Office-Proxy/1.0 (+https://mim-frontoffice.de)',
]);
$response = curl_exec($ch);

if ($response === false) {
    $err = curl_error($ch);
    curl_close($ch);
    http_response_code(502);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'Fetch fehlgeschlagen: ' . $err;
    exit;
}

$headerSize = curl_getinfo($ch, CURLINFO_HEADER_SIZE);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$contentType = curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
curl_close($ch);

$body = substr($response, $headerSize);

http_response_code($httpCode);
header('Content-Type: ' . ($contentType ?: 'application/octet-stream'));
echo $body;
