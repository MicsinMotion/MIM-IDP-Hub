<?php
// Kurzes Diagnose-Skript — zeigt uns, was der Server kann, ohne irgendwas zu verändern.
// Einfach als serverinfo.php ins Hauptverzeichnis hochladen, im Browser aufrufen,
// Ergebnis kopieren/screenshotten, DANACH WIEDER LÖSCHEN (zeigt Server-Interna).

header('Content-Type: text/plain; charset=utf-8');

echo "=== PHP ===\n";
echo "PHP-Version: " . phpversion() . "\n";
echo "cURL verfügbar: " . (function_exists('curl_init') ? 'JA' : 'NEIN') . "\n";
echo "allow_url_fopen: " . (ini_get('allow_url_fopen') ? 'AN' : 'AUS') . "\n";
echo "OpenSSL/HTTPS-Fetch möglich: " . (extension_loaded('openssl') ? 'JA' : 'NEIN') . "\n";

echo "\n=== Datenbank ===\n";
echo "MySQLi verfügbar: " . (function_exists('mysqli_connect') ? 'JA' : 'NEIN') . "\n";
echo "PDO verfügbar: " . (class_exists('PDO') ? 'JA (Treiber: ' . implode(', ', PDO::getAvailableDrivers()) . ')' : 'NEIN') . "\n";

echo "\n=== Testfetch (extern) ===\n";
$test = @file_get_contents('https://api.sleeper.app/v1/state/nfl');
echo "Externer HTTPS-Fetch funktioniert: " . ($test ? 'JA' : 'NEIN (evtl. Firewall/Einstellung)') . "\n";

echo "\n=== Sonstiges ===\n";
echo "Server-Software: " . ($_SERVER['SERVER_SOFTWARE'] ?? 'unbekannt') . "\n";
echo "Document Root: " . ($_SERVER['DOCUMENT_ROOT'] ?? 'unbekannt') . "\n";
echo "max_execution_time: " . ini_get('max_execution_time') . "s\n";
echo "upload_max_filesize: " . ini_get('upload_max_filesize') . "\n";

echo "\n=== Cronjobs ===\n";
echo "(Das lässt sich von hier aus nicht automatisch erkennen — bitte im Hosting-Control-Panel\n";
echo "nach 'Cronjobs' oder 'Geplante Aufgaben' suchen und Screenshot schicken, falls vorhanden.)\n";
