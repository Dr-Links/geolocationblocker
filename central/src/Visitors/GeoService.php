<?php

declare(strict_types=1);

namespace Signalpost\Visitors;

use Signalpost\Core\App;
use Signalpost\Http\ClientIp;
use Signalpost\Http\Request;

/**
 * Optional country estimation without paid or remote APIs.
 *
 * Providers (config geo.provider):
 *   none           - always unknown
 *   table          - local geo_ip_ranges table imported from a CSV (e.g. DB-IP Lite, CC BY 4.0)
 *   trusted_header - a country header set by a configured trusted proxy (e.g. Cloudflare CF-IPCountry)
 *
 * The IP address is used transiently for the lookup and is never stored.
 * Results are estimates and are labelled as such everywhere.
 */
final class GeoService
{
    public function __construct(private readonly App $app)
    {
    }

    /** @return array{country:?string,source:string} */
    public function estimate(Request $request): array
    {
        $provider = (string) $this->app->config->get('geo.provider');
        try {
            if ($provider === 'trusted_header') {
                if (!ClientIp::isTrustedPeer($request, (array) $this->app->config->get('security.trusted_proxies'))) {
                    return ['country' => null, 'source' => 'unavailable'];
                }
                $cc = strtoupper(trim((string) $request->header(strtolower((string) $this->app->config->get('geo.trusted_header')))));
                return preg_match('/^[A-Z]{2}$/', $cc) === 1 && !in_array($cc, ['XX', 'T1'], true)
                    ? ['country' => $cc, 'source' => 'proxy_header'] : ['country' => null, 'source' => 'unknown'];
            }
            if ($provider === 'table') {
                return ['country' => $this->lookup($this->app->clientIp($request)), 'source' => 'local_db'];
            }
        } catch (\Throwable $e) {
            $this->app->logger()->warning('Geo lookup failed', ['type' => $e::class]);
        }
        return ['country' => null, 'source' => 'unavailable'];
    }

    public function lookup(string $ip): ?string
    {
        $bin = @inet_pton($ip);
        if ($bin === false) {
            return null;
        }
        $bin = strlen($bin) === 4 ? str_repeat("\0", 10) . "\xff\xff" . $bin : $bin;
        $row = $this->app->db()->one(
            'SELECT ip_end, country_code FROM geo_ip_ranges WHERE ip_start <= ? ORDER BY ip_start DESC LIMIT 1',
            [$bin]
        );
        if ($row === null || strcmp($bin, $row['ip_end']) > 0) {
            return null;
        }
        $cc = strtoupper($row['country_code']);
        return preg_match('/^[A-Z]{2}$/', $cc) === 1 && $cc !== 'ZZ' ? $cc : null;
    }

    /**
     * Imports "start_ip,end_ip,country_code" CSV rows (DB-IP Lite format) into geo_ip_ranges.
     * Replaces existing data. Returns the number of rows imported.
     */
    public function import(string $csvPath): int
    {
        $fh = fopen($csvPath, 'rb');
        if ($fh === false) {
            throw new \RuntimeException('Cannot open CSV file.');
        }
        $db = $this->app->db();
        $db->exec('DELETE FROM geo_ip_ranges');
        $count = 0;
        $batch = [];
        $flush = static function () use (&$batch, $db): void {
            if ($batch === []) {
                return;
            }
            $sql = 'INSERT IGNORE INTO geo_ip_ranges (ip_start, ip_end, country_code) VALUES ' . implode(',', array_fill(0, count($batch), '(?,?,?)'));
            $db->exec($sql, array_merge(...$batch));
            $batch = [];
        };
        while (($row = fgetcsv($fh, 0, ',', '"', '')) !== false) {
            if (count($row) < 3) {
                continue;
            }
            $start = @inet_pton(trim($row[0]));
            $end = @inet_pton(trim($row[1]));
            $cc = strtoupper(trim($row[2]));
            if ($start === false || $end === false || strlen($start) !== strlen($end) || preg_match('/^[A-Z]{2}$/', $cc) !== 1) {
                continue;
            }
            if (strlen($start) === 4) {
                $start = str_repeat("\0", 10) . "\xff\xff" . $start;
                $end = str_repeat("\0", 10) . "\xff\xff" . $end;
            }
            $batch[] = [$start, $end, $cc];
            $count++;
            if (count($batch) >= 500) {
                $flush();
            }
        }
        $flush();
        fclose($fh);
        return $count;
    }
}
