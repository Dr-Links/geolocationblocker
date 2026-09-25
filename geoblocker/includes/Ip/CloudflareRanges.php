<?php
/**
 * Cloudflare edge IP ranges.
 *
 * @package GeoBlocker
 */

namespace GeoBlocker\Ip;

defined( 'ABSPATH' ) || exit;

/**
 * Provides Cloudflare's published edge ranges. A built-in list is shipped with
 * the plugin and can be refreshed from https://www.cloudflare.com/ips-v4 and
 * https://www.cloudflare.com/ips-v6 (server-side, no visitor data is sent).
 */
final class CloudflareRanges {

	public const OPTION = 'geoblocker_cloudflare_ranges';

	/**
	 * Built-in ranges (published by Cloudflare).
	 */
	private const BUILT_IN = array(
		'173.245.48.0/20',
		'103.21.244.0/22',
		'103.22.200.0/22',
		'103.31.4.0/22',
		'141.101.64.0/18',
		'108.162.192.0/18',
		'190.93.240.0/20',
		'188.114.96.0/20',
		'197.234.240.0/22',
		'198.41.128.0/17',
		'162.158.0.0/15',
		'104.16.0.0/13',
		'104.24.0.0/14',
		'172.64.0.0/13',
		'131.0.72.0/22',
		'2400:cb00::/32',
		'2606:4700::/32',
		'2803:f800::/32',
		'2405:b500::/32',
		'2405:8100::/32',
		'2a06:98c0::/29',
		'2c0f:f248::/32',
	);

	/**
	 * Current ranges (refreshed list if available, otherwise built-in).
	 *
	 * @return string[]
	 */
	public static function get(): array {
		$stored = get_option( self::OPTION );
		if ( is_array( $stored ) && ! empty( $stored['ranges'] ) && is_array( $stored['ranges'] ) ) {
			return $stored['ranges'];
		}
		return self::BUILT_IN;
	}

	/**
	 * When the list was last refreshed (0 = built-in list in use).
	 */
	public static function last_updated(): int {
		$stored = get_option( self::OPTION );
		return is_array( $stored ) ? (int) ( $stored['updated'] ?? 0 ) : 0;
	}

	/**
	 * Download the latest ranges from Cloudflare.
	 *
	 * @return true|\WP_Error
	 */
	public static function refresh() {
		$ranges = array();
		foreach ( array( 'https://www.cloudflare.com/ips-v4', 'https://www.cloudflare.com/ips-v6' ) as $url ) {
			$response = wp_safe_remote_get(
				$url,
				array(
					'timeout'    => 10,
					'user-agent' => 'GeoBlocker/' . GEOBLOCKER_VERSION . '; ' . home_url( '/' ),
				)
			);
			if ( is_wp_error( $response ) ) {
				return $response;
			}
			if ( 200 !== (int) wp_remote_retrieve_response_code( $response ) ) {
				return new \WP_Error( 'geoblocker_cf_http', __( 'Cloudflare returned an unexpected response.', 'geoblocker' ) );
			}
			$parsed = IpUtils::parse_list( (string) wp_remote_retrieve_body( $response ) );
			foreach ( $parsed['valid'] as $range ) {
				if ( false !== strpos( $range, '/' ) ) {
					$ranges[] = $range;
				}
			}
		}

		// Sanity check: Cloudflare publishes well over 10 ranges.
		if ( count( $ranges ) < 10 ) {
			return new \WP_Error( 'geoblocker_cf_empty', __( 'The downloaded Cloudflare IP list looked incomplete and was not saved.', 'geoblocker' ) );
		}

		update_option(
			self::OPTION,
			array(
				'ranges'  => array_values( array_unique( $ranges ) ),
				'updated' => time(),
			),
			true
		);

		return true;
	}
}
