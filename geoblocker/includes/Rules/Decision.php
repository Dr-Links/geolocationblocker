<?php
/**
 * Result of evaluating the blocking rules for a visitor.
 *
 * @package GeoBlocker
 */

namespace GeoBlocker\Rules;

defined( 'ABSPATH' ) || exit;

/**
 * Immutable decision.
 */
final class Decision {

	public const REASON_DISABLED            = 'disabled';
	public const REASON_IP_WHITELISTED      = 'ip_whitelisted';
	public const REASON_ADMIN_BYPASS        = 'admin_bypass';
	public const REASON_PRIVATE_IP          = 'private_ip';
	public const REASON_COUNTRY_WHITELISTED = 'country_whitelisted';
	public const REASON_COUNTRY_BLOCKED     = 'country_blocked';
	public const REASON_CONTINENT_BLOCKED   = 'continent_blocked';
	public const REASON_LOOKUP_FAILED_ALLOW = 'lookup_failed_allowed';
	public const REASON_LOOKUP_FAILED_BLOCK = 'lookup_failed_blocked';
	public const REASON_NOT_BLOCKED         = 'not_blocked';

	/**
	 * Constructor.
	 *
	 * @param bool   $blocked     Whether the visitor is blocked.
	 * @param string $reason      Reason code (see constants).
	 * @param string $ip          Evaluated IP.
	 * @param string $country     Country code.
	 * @param string $continent   Continent code.
	 * @param bool   $whitelisted Whether a whitelist rule matched.
	 * @param string $provider    Geolocation provider used.
	 * @param string $geo_error   Geolocation error message, if any.
	 * @param bool   $from_cache  Whether the geolocation came from cache.
	 */
	public function __construct(
		public readonly bool $blocked,
		public readonly string $reason,
		public readonly string $ip,
		public readonly string $country = '',
		public readonly string $continent = '',
		public readonly bool $whitelisted = false,
		public readonly string $provider = '',
		public readonly string $geo_error = '',
		public readonly bool $from_cache = false
	) {}

	/**
	 * Whether the geolocation lookup failed.
	 */
	public function lookup_failed(): bool {
		return in_array( $this->reason, array( self::REASON_LOOKUP_FAILED_ALLOW, self::REASON_LOOKUP_FAILED_BLOCK ), true );
	}

	/**
	 * Human readable labels for reason codes.
	 *
	 * @return array<string,string>
	 */
	public static function reason_labels(): array {
		return array(
			self::REASON_DISABLED            => __( 'GeoBlocker is disabled', 'geoblocker' ),
			self::REASON_IP_WHITELISTED      => __( 'IP address is whitelisted', 'geoblocker' ),
			self::REASON_ADMIN_BYPASS        => __( 'Logged-in administrator bypass', 'geoblocker' ),
			self::REASON_PRIVATE_IP          => __( 'Private / local IP address (cannot be geolocated)', 'geoblocker' ),
			self::REASON_COUNTRY_WHITELISTED => __( 'Country is whitelisted', 'geoblocker' ),
			self::REASON_COUNTRY_BLOCKED     => __( 'Country is blocked', 'geoblocker' ),
			self::REASON_CONTINENT_BLOCKED   => __( 'Continent is blocked', 'geoblocker' ),
			self::REASON_LOOKUP_FAILED_ALLOW => __( 'Location detection failed (visitor allowed)', 'geoblocker' ),
			self::REASON_LOOKUP_FAILED_BLOCK => __( 'Location detection failed (visitor blocked)', 'geoblocker' ),
			self::REASON_NOT_BLOCKED         => __( 'Location is not blocked', 'geoblocker' ),
		);
	}

	/**
	 * Label for this decision's reason.
	 */
	public function reason_label(): string {
		$labels = self::reason_labels();
		return $labels[ $this->reason ] ?? $this->reason;
	}
}
