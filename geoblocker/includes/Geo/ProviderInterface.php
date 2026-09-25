<?php
/**
 * GeoIP provider contract.
 *
 * @package GeoBlocker
 */

namespace GeoBlocker\Geo;

defined( 'ABSPATH' ) || exit;

/**
 * Every geolocation provider implements this interface. Third-party providers
 * can be added with the `geoblocker_providers` filter:
 *
 *     add_filter( 'geoblocker_providers', function ( $providers ) {
 *         $providers['my_provider'] = new My_Provider(); // implements ProviderInterface
 *         return $providers;
 *     } );
 */
interface ProviderInterface {

	/**
	 * Unique machine id (lowercase, a-z0-9_).
	 */
	public function get_id(): string;

	/**
	 * Human readable name.
	 */
	public function get_label(): string;

	/**
	 * Whether the provider sends IP addresses to a remote service.
	 * Remote results are cached persistently; local results are not (local lookups are faster than a DB query).
	 */
	public function is_remote(): bool;

	/**
	 * Whether the provider is configured and ready (database present, key set, ...).
	 */
	public function is_available(): bool;

	/**
	 * Look up an IP address. Must never throw.
	 *
	 * @param string $ip Normalised public IP address.
	 */
	public function lookup( string $ip ): GeoResult;
}
