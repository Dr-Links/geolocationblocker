<?php
/**
 * Geolocation service: provider registry, selection and caching.
 *
 * @package GeoBlocker
 */

namespace GeoBlocker\Geo;

use GeoBlocker\Cache\GeoCache;
use GeoBlocker\Geo\Providers\IpapiProvider;
use GeoBlocker\Geo\Providers\IpinfoProvider;
use GeoBlocker\Geo\Providers\LocalDatabaseProvider;
use GeoBlocker\Ip\IpDetector;
use GeoBlocker\Ip\IpUtils;
use GeoBlocker\Settings;

defined( 'ABSPATH' ) || exit;

/**
 * Resolves an IP address to a country and continent.
 */
final class GeoLocator {

	/**
	 * Singleton instance.
	 *
	 * @var GeoLocator|null
	 */
	private static ?GeoLocator $instance = null;

	/**
	 * Registered providers.
	 *
	 * @var array<string,ProviderInterface>|null
	 */
	private ?array $providers = null;

	/**
	 * Cache.
	 *
	 * @var GeoCache
	 */
	private GeoCache $cache;

	/**
	 * Constructor.
	 */
	private function __construct() {
		$this->cache = new GeoCache();
	}

	/**
	 * Shared instance.
	 */
	public static function instance(): GeoLocator {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	/**
	 * All registered providers.
	 *
	 * @return array<string,ProviderInterface>
	 */
	public function get_providers(): array {
		if ( null === $this->providers ) {
			$providers = array(
				'local'  => new LocalDatabaseProvider(),
				'ipapi'  => new IpapiProvider(),
				'ipinfo' => new IpinfoProvider(),
			);

			/**
			 * Register additional geolocation providers.
			 *
			 * @param array<string,ProviderInterface> $providers Providers keyed by id.
			 */
			$filtered = apply_filters( 'geoblocker_providers', $providers );

			$this->providers = array();
			foreach ( (array) $filtered as $provider ) {
				if ( $provider instanceof ProviderInterface && preg_match( '/^[a-z0-9_]+$/', $provider->get_id() ) ) {
					$this->providers[ $provider->get_id() ] = $provider;
				}
			}
			if ( ! isset( $this->providers['local'] ) ) {
				$this->providers['local'] = new LocalDatabaseProvider();
			}
		}
		return $this->providers;
	}

	/**
	 * Registered provider ids.
	 *
	 * @return string[]
	 */
	public function get_registered_provider_ids(): array {
		return array_keys( $this->get_providers() );
	}

	/**
	 * The configured provider.
	 */
	public function get_active_provider(): ProviderInterface {
		$providers = $this->get_providers();
		$id        = (string) Settings::get( 'provider' );
		return $providers[ $id ] ?? $providers['local'];
	}

	/**
	 * Cache instance.
	 */
	public function cache(): GeoCache {
		return $this->cache;
	}

	/**
	 * Look up the current visitor. Uses Cloudflare's verified CF-IPCountry header
	 * when enabled (zero cost), otherwise the configured provider.
	 *
	 * @param string $ip The visitor IP as determined by IpDetector.
	 */
	public function lookup_visitor( string $ip ): GeoResult {
		if ( Settings::get( 'use_cloudflare_country' ) ) {
			$from_header = $this->from_cloudflare_header( $ip );
			if ( null !== $from_header ) {
				return $from_header;
			}
		}
		return $this->lookup( $ip );
	}

	/**
	 * Look up any IP address with the configured provider.
	 *
	 * @param string $ip IP address.
	 */
	public function lookup( string $ip ): GeoResult {
		$ip       = IpUtils::normalize( $ip );
		$provider = $this->get_active_provider();

		if ( '' === $ip ) {
			return GeoResult::failed( $provider->get_id(), 'Invalid IP address.' );
		}

		$remote = $provider->is_remote();
		$cached = $this->cache->get( $ip, $provider->get_id(), $remote );
		if ( null !== $cached ) {
			return $cached;
		}

		if ( ! $provider->is_available() ) {
			// Not cached: becomes available as soon as it is configured.
			return GeoResult::failed( $provider->get_id(), 'The geolocation provider is not configured (for the local provider: no GeoIP database installed).' );
		}

		try {
			$result = $provider->lookup( $ip );
		} catch ( \Throwable $e ) {
			$result = GeoResult::failed( $provider->get_id(), $e->getMessage() );
		}

		/**
		 * Filter a geolocation result before it is cached.
		 *
		 * @param GeoResult $result Result.
		 * @param string    $ip     IP address.
		 */
		$filtered = apply_filters( 'geoblocker_geo_result', $result, $ip );
		if ( $filtered instanceof GeoResult ) {
			$result = $filtered;
		}

		$this->cache->set( $ip, $result, $remote, (int) Settings::get( 'cache_ttl' ) );

		return $result;
	}

	/**
	 * Read Cloudflare's CF-IPCountry header, but only when the request provably
	 * came through Cloudflare (verified edge IP) and the IP is the visitor's.
	 *
	 * @param string $ip Visitor IP.
	 */
	private function from_cloudflare_header( string $ip ): ?GeoResult {
		$detector = IpDetector::instance();
		if ( ! $detector->is_from_cloudflare() || $detector->get_client_ip() !== $ip ) {
			return null;
		}
		if ( empty( $_SERVER['HTTP_CF_IPCOUNTRY'] ) || ! is_string( $_SERVER['HTTP_CF_IPCOUNTRY'] ) ) {
			return null;
		}
		$country = strtoupper( sanitize_text_field( wp_unslash( $_SERVER['HTTP_CF_IPCOUNTRY'] ) ) );
		if ( ! preg_match( '/^[A-Z][A-Z0-9]$/', $country ) || 'XX' === $country ) {
			return null; // Unknown: fall back to the configured provider.
		}
		return GeoResult::found( $country, '', 'cloudflare' );
	}
}
