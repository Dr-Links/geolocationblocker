<?php
/**
 * Geolocation result cache.
 *
 * @package GeoBlocker
 */

namespace GeoBlocker\Cache;

use GeoBlocker\Geo\GeoResult;

defined( 'ABSPATH' ) || exit;

/**
 * Three cache layers:
 *
 * 1. In-request memory (always).
 * 2. Persistent object cache (Redis/Memcached) when the site has one.
 * 3. Transients – only for remote providers, to avoid repeated API calls.
 *    Local database lookups are faster than a database round-trip, so they are
 *    never written to the options table.
 *
 * Cache keys are salted hashes, so raw IP addresses are never stored as keys.
 */
final class GeoCache {

	public const GROUP            = 'geoblocker';
	public const TRANSIENT_PREFIX = 'geoblocker_geo_';
	public const FAILURE_TTL      = 10 * MINUTE_IN_SECONDS;

	/**
	 * In-request cache.
	 *
	 * @var array<string,GeoResult>
	 */
	private array $memory = array();

	/**
	 * Build a cache key.
	 *
	 * @param string $ip       IP address.
	 * @param string $provider Provider id.
	 */
	private function key( string $ip, string $provider ): string {
		return substr( hash_hmac( 'sha256', $provider . '|' . $ip, wp_salt( 'nonce' ) ), 0, 32 );
	}

	/**
	 * Get a cached result.
	 *
	 * @param string $ip       IP address.
	 * @param string $provider Provider id.
	 * @param bool   $remote   Whether the provider is remote.
	 */
	public function get( string $ip, string $provider, bool $remote ): ?GeoResult {
		$memory_key = $provider . '|' . $ip;
		if ( isset( $this->memory[ $memory_key ] ) ) {
			return $this->memory[ $memory_key ];
		}

		$key = $this->key( $ip, $provider );

		if ( wp_using_ext_object_cache() ) {
			$data = wp_cache_get( $key, self::GROUP );
		} elseif ( $remote ) {
			$data = get_transient( self::TRANSIENT_PREFIX . $key );
		} else {
			return null;
		}

		$result = GeoResult::from_array( $data );
		if ( null !== $result ) {
			$this->memory[ $memory_key ] = $result;
		}
		return $result;
	}

	/**
	 * Store a result.
	 *
	 * @param string    $ip       IP address.
	 * @param GeoResult $result   Result.
	 * @param bool      $remote   Whether the provider is remote.
	 * @param int       $ttl      Time to live for successful lookups.
	 */
	public function set( string $ip, GeoResult $result, bool $remote, int $ttl ): void {
		$this->memory[ $result->provider . '|' . $ip ] = $result;

		$ttl = $result->success ? $ttl : self::FAILURE_TTL;
		$key = $this->key( $ip, $result->provider );

		if ( wp_using_ext_object_cache() ) {
			wp_cache_set( $key, $result->to_array(), self::GROUP, $ttl );
		} elseif ( $remote ) {
			set_transient( self::TRANSIENT_PREFIX . $key, $result->to_array(), $ttl );
		}
	}

	/**
	 * Clear all cached lookups.
	 */
	public function flush(): void {
		global $wpdb;

		$this->memory = array();

		if ( wp_using_ext_object_cache() && function_exists( 'wp_cache_supports' ) && wp_cache_supports( 'flush_group' ) ) {
			wp_cache_flush_group( self::GROUP );
		}

		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching -- bulk transient cleanup.
		$wpdb->query(
			$wpdb->prepare(
				"DELETE FROM {$wpdb->options} WHERE option_name LIKE %s OR option_name LIKE %s",
				$wpdb->esc_like( '_transient_' . self::TRANSIENT_PREFIX ) . '%',
				$wpdb->esc_like( '_transient_timeout_' . self::TRANSIENT_PREFIX ) . '%'
			)
		);
	}
}
