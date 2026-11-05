<?php
// Test-only SMTP server: accepts one session on argv[1], logs the conversation to argv[2].
$server = stream_socket_server('tcp://127.0.0.1:' . $argv[1], $errno, $errstr);
$log = fopen($argv[2], 'w');
$conn = stream_socket_accept($server, 10);
$say = function ($l) use ($conn) { fwrite($conn, $l . "\r\n"); };
$say('220 fake.test ESMTP');
$inData = false;
while (($line = fgets($conn)) !== false) {
    fwrite($log, $line);
    $cmd = strtoupper(rtrim($line));
    if ($inData) {
        if (rtrim($line, "\r\n") === '.') { $inData = false; $say('250 queued'); }
        continue;
    }
    if (str_starts_with($cmd, 'EHLO')) { $say('250-fake.test'); $say('250 AUTH LOGIN'); }
    elseif ($cmd === 'AUTH LOGIN') { $say('334 VXNlcm5hbWU6'); $u = fgets($conn); fwrite($log, $u); $say('334 UGFzc3dvcmQ6'); $p = fgets($conn); fwrite($log, $p); $say(base64_decode(trim($p)) === 'right-pass' ? '235 ok' : '535 bad'); }
    elseif (str_starts_with($cmd, 'MAIL FROM') || str_starts_with($cmd, 'RCPT TO')) { $say('250 ok'); }
    elseif ($cmd === 'DATA') { $inData = true; $say('354 go'); }
    elseif ($cmd === 'QUIT') { $say('221 bye'); break; }
    else { $say('500 ?'); }
}
fclose($log);
