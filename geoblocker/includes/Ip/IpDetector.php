<?php
/**
 * Determines the real visitor IP address safely.
 *
 * @package GeoBlocker
 */

namespace GeoBlocker\Ip;

use GeoBlocker\Settings;

defined( 'ABSPATH' ) || exit;

/**
 * Client IP detection with a trusted-proxy model.
 *
 * Forwarding headers (X-Forwarded-For, CF-Connecting-IP, ...) are only honoured
 * when the direct connection (REMOTE_ADDR) comes from a proxy the administrator
 * has explicitly trusted. Otherwise any visitor could spoof their location by
 * sending a fake header.
 */
final class IpDetector {

	/**
	 * Singleton instance.
	 *
	 * @var IpDetector|null
	 */
	private static ?IpDetector $instance = null;

	/**
	 * Cached detection result for this request.
	 *
	 * @var array{ip:string,remote:string,via_cloudflare:bool,via_proxy:bool,source:string}|null
	 */
	private ?array $detected = null;

	/**
	 * Get the shared instance.
	 */
	public static function instance(): IpDetector {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	/**
	 * The visitor's IP address ('' if it cannot be determined).
	 */
	public function get_client_ip(): string {
		return $this->detect()['ip'];
	}

	/**
	 * Whether the current request verifiably arrived through Cloudflare.
	 */
	public function is_from_cloudflare(): bool {
		return $this->detect()['via_cloudflare'];
	}

	/**
	 * Full detection details (for the admin testing tool).
	 *
	 * @return array{ip:string,remote:string,via_cloudflare:bool,via_proxy:bool,source:string}
	 */
	public function details(): array {
		return $this->detect();
	}

	/**
	 * Reset the per-request cache (after settings changes).
	 */
	public function reset(): void {
		$this->detected = null;
	}

	/**
	 * Run the detection once per request.
	 *
	 * @return array{ip:string,remote:string,via_cloudflare:bool,via_proxy:bool,source:string}
	 */
	private function detect(): array {
		if ( null !== $this->detected ) {
			return $this->detected;
		}

		$remote = IpUtils::normalize( self::server( 'REMOTE_ADDR' ) );
		$result = array(
			'ip'             => $remote,
			'remote'         => $remote,
			'via_cloudflare' => false,
			'via_proxy'      => false,
			'source'         => 'REMOTE_ADDR',
		);

		if ( '' !== $remote ) {
			$settings        = Settings::all();
			$trusted_proxies = (array) $settings['trusted_proxies'];
			$cf_ranges       = ! empty( $settings['trust_cloudflare'] ) ? CloudflareRanges::get() : array();

			// 1. Cloudflare: only when the connecting IP is a Cloudflare edge server.
			if ( $cf_ranges && IpUtils::in_list( $remote, $cf_ranges ) ) {
				$cf_ip = IpUtils::normalize( self::server( 'HTTP_CF_CONNECTING_IP' ) );
				if ( '' !== $cf_ip ) {
					$result['ip']             = $cf_ip;
					$result['via_cloudflare'] = true;
					$result['source']         = 'CF-Connecting-IP';
				}
			} elseif ( $trusted_proxies && IpUtils::in_list( $remote, $trusted_proxies ) ) {
				// 2. Generic trusted reverse proxy / CDN / load balancer.
				$forwarded = $this->from_proxy_header( $settings, array_merge( $trusted_proxies, $cf_ranges ) );
				if ( '' !== $forwarded['ip'] ) {
					$result['ip']        = $forwarded['ip'];
					$result['via_proxy'] = true;
					$result['source']    = $forwarded['source'];

					// A trusted proxy may itself sit behind Cloudflare.
					if ( $cf_ranges && $forwarded['hop'] && IpUtils::in_list( $forwarded['hop'], $cf_ranges ) ) {
						$cf_ip = IpUtils::normalize( self::server( 'HTTP_CF_CONNECTING_IP' ) );
						if ( '' !== $cf_ip ) {
							$result['ip']             = $cf_ip;
							$result['via_cloudflare'] = true;
							$result['source']         = 'CF-Connecting-IP';
						}
					}
				}
			}
		}

		/**
		 * Filter the detected client IP.
		 *
		 * @param string $ip     Detected IP.
		 * @param array  $result Detection details.
		 */
		$filtered = apply_filters( 'geoblocker_client_ip', $result['ip'], $result );
		if ( is_string( $filtered ) ) {
			$result['ip'] = IpUtils::normalize( $filtered );
		}

		$this->detected = $result;
		return $result;
	}

	/**
	 * Extract the client IP from the configured forwarding header.
	 *
	 * For list headers (X-Forwarded-For) the chain is walked right-to-left and
	 * every trusted hop is skipped; the first untrusted address is the client.
	 * Entries left of that one are attacker-controlled and ignored.
	 *
	 * @param array<string,mixed> $settings Settings.
	 * @param string[]            $trusted  Trusted proxy entries.
	 * @return array{ip:string,source:string,hop:string}
	 */
	private function from_proxy_header( array $settings, array $trusted ): array {
		$choices = Settings::proxy_header_choices();
		$key     = (string) $settings['proxy_header'];
		$server  = $choices[ $key ] ?? 'HTTP_X_FORWARDED_FOR';

		if ( 'custom' === $key ) {
			$custom = (string) $settings['proxy_custom_header'];
			$server = '' === $custom ? '' : 'HTTP_' . $custom;
		}

		$empty = array(
			'ip'     => '',
			'source' => '',
			'hop'    => '',
		);

		if ( '' === $server ) {
			return $empty;
		}

		$value = self::server( $server );
		if ( '' === $value ) {
			return $empty;
		}

		$label = str_replace( '_', '-', substr( $server, 5 ) );
		$parts = array_reverse( array_map( 'trim', explode( ',', $value ) ) );
		$hop   = '';

		foreach ( $parts as $index => $part ) {
			$ip = IpUtils::normalize( $part );
			if ( '' === $ip ) {
				// A malformed entry means we cannot trust anything further left.
				return $empty;
			}
			if ( IpUtils::in_list( $ip, $trusted ) && $index < count( $parts ) - 1 ) {
				$hop = $ip;
				continue;
			}
			return array(
				'ip'     => $ip,
				'source' => $label,
				'hop'    => $hop,
			);
		}

		return $empty;
	}

	/**
	 * Read a $_SERVER value as a sanitized string.
	 *
	 * @param string $key Server key.
	 */
	private static function server( string $key ): string {
		if ( ! isset( $_SERVER[ $key ] ) || ! is_string( $_SERVER[ $key ] ) ) {
			return '';
		}
		// IP headers only need a restricted character set; strip everything else.
		$value = sanitize_text_field( wp_unslash( $_SERVER[ $key ] ) ); // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized
		return (string) preg_replace( '/[^0-9A-Fa-f:\.,\[\]%\s]/', '', substr( $value, 0, 1024 ) );
	}
}
