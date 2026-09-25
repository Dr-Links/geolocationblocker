<?php
/**
 * Local MMDB database provider (DB-IP Lite, MaxMind GeoLite2 or a custom file).
 *
 * @package GeoBlocker
 */

namespace GeoBlocker\Geo\Providers;

use GeoBlocker\Geo\DatabaseUpdater;
use GeoBlocker\Geo\GeoResult;
use GeoBlocker\Geo\MaxMindReader;
use GeoBlocker\Geo\ProviderInterface;

defined( 'ABSPATH' ) || exit;

/**
 * Looks up IPs in a local .mmdb file. No visitor data leaves the server.
 */
final class LocalDatabaseProvider implements ProviderInterface {

	/**
	 * Lazily opened reader.
	 *
	 * @var MaxMindReader|null
	 */
	private ?MaxMindReader $reader = null;

	/**
	 * Error from opening the database.
	 *
	 * @var string
	 */
	private string $open_error = '';

	/**
	 * {@inheritDoc}
	 */
	public function get_id(): string {
		return 'local';
	}

	/**
	 * {@inheritDoc}
	 */
	public function get_label(): string {
		return __( 'Local GeoIP database (recommended, private & fast)', 'geoblocker' );
	}

	/**
	 * {@inheritDoc}
	 */
	public function is_remote(): bool {
		return false;
	}

	/**
	 * {@inheritDoc}
	 */
	public function is_available(): bool {
		$path = DatabaseUpdater::get_active_path();
		return '' !== $path && is_readable( $path );
	}

	/**
	 * {@inheritDoc}
	 */
	public function lookup( string $ip ): GeoResult {
		$reader = $this->reader();
		if ( null === $reader ) {
			return GeoResult::failed( $this->get_id(), $this->open_error );
		}

		try {
			$record = $reader->get( $ip );
		} catch ( \Throwable $e ) {
			return GeoResult::failed( $this->get_id(), $e->getMessage() );
		}

		if ( ! is_array( $record ) ) {
			return GeoResult::failed( $this->get_id(), 'IP address not found in the GeoIP database.' );
		}

		// Some networks (e.g. anycast / satellite) only have a registered country.
		$country = $record['country']['iso_code'] ?? $record['registered_country']['iso_code'] ?? $record['country_code'] ?? '';
		// Continent is only trusted when it belongs to the same country record.
		$continent = isset( $record['country']['iso_code'] ) ? ( $record['continent']['code'] ?? '' ) : '';

		return GeoResult::found( (string) $country, (string) $continent, $this->get_id() );
	}

	/**
	 * Open the database once per request.
	 */
	private function reader(): ?MaxMindReader {
		if ( null !== $this->reader ) {
			return $this->reader;
		}
		if ( '' !== $this->open_error ) {
			return null;
		}

		$path = DatabaseUpdater::get_active_path();
		if ( '' === $path ) {
			$this->open_error = 'No GeoIP database has been installed yet.';
			return null;
		}

		try {
			$this->reader = new MaxMindReader( $path );
		} catch ( \Throwable $e ) {
			$this->open_error = $e->getMessage();
			return null;
		}

		return $this->reader;
	}
}
