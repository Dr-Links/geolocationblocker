<?php
/**
 * Geolocation lookup result value object.
 *
 * @package GeoBlocker
 */

namespace GeoBlocker\Geo;

defined( 'ABSPATH' ) || exit;

/**
 * Immutable result of a geolocation lookup.
 */
final class GeoResult {

	/**
	 * Constructor.
	 *
	 * @param bool   $success        Whether a country was determined.
	 * @param string $country_code   ISO country code ('' if unknown).
	 * @param string $continent_code Continent code ('' if unknown).
	 * @param string $provider       Provider id that produced the result.
	 * @param string $error          Error message on failure.
	 * @param bool   $from_cache     Whether the result came from cache.
	 */
	public function __construct(
		public readonly bool $success,
		public readonly string $country_code = '',
		public readonly string $continent_code = '',
		public readonly string $provider = '',
		public readonly string $error = '',
		public readonly bool $from_cache = false
	) {}

	/**
	 * Build a successful result, filling the continent from the country if needed.
	 *
	 * @param string $country   Country code.
	 * @param string $continent Continent code.
	 * @param string $provider  Provider id.
	 */
	public static function found( string $country, string $continent, string $provider ): self {
		$country   = strtoupper( substr( preg_replace( '/[^A-Za-z0-9]/', '', $country ), 0, 2 ) );
		$continent = strtoupper( substr( preg_replace( '/[^A-Za-z]/', '', $continent ), 0, 2 ) );

		if ( '' === $country || 'XX' === $country ) {
			return self::failed( $provider, 'Country not found for this IP address.' );
		}

		if ( '' === $continent ) {
			$continent = Countries::continent_for( $country );
		}

		return new self( true, $country, $continent, $provider );
	}

	/**
	 * Build a failed result.
	 *
	 * @param string $provider Provider id.
	 * @param string $error    Error message.
	 */
	public static function failed( string $provider, string $error ): self {
		return new self( false, '', '', $provider, $error );
	}

	/**
	 * Copy of this result flagged as cached.
	 */
	public function as_cached(): self {
		return new self( $this->success, $this->country_code, $this->continent_code, $this->provider, $this->error, true );
	}

	/**
	 * Array form (for caching).
	 *
	 * @return array<string,mixed>
	 */
	public function to_array(): array {
		return array(
			's' => $this->success ? 1 : 0,
			'c' => $this->country_code,
			'n' => $this->continent_code,
			'p' => $this->provider,
			'e' => $this->error,
		);
	}

	/**
	 * Restore from array form.
	 *
	 * @param mixed $data Cached data.
	 */
	public static function from_array( $data ): ?self {
		if ( ! is_array( $data ) || ! isset( $data['s'], $data['c'], $data['n'], $data['p'] ) ) {
			return null;
		}
		return new self( (bool) $data['s'], (string) $data['c'], (string) $data['n'], (string) $data['p'], (string) ( $data['e'] ?? '' ), true );
	}
}
