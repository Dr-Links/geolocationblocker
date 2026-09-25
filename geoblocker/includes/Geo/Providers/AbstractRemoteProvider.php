<?php
/**
 * Base class for HTTP API providers.
 *
 * @package GeoBlocker
 */

namespace GeoBlocker\Geo\Providers;

use GeoBlocker\Geo\GeoResult;
use GeoBlocker\Geo\ProviderInterface;

defined( 'ABSPATH' ) || exit;

/**
 * Shared HTTP handling for remote providers. API keys are only ever used in
 * server-side requests and are never printed to the front end.
 */
abstract class AbstractRemoteProvider implements ProviderInterface {

	/**
	 * HTTP timeout in seconds. Kept short so a slow API never stalls page loads.
	 */
	protected const TIMEOUT = 3;

	/**
	 * {@inheritDoc}
	 */
	public function is_remote(): bool {
		return true;
	}

	/**
	 * Build the request URL for an IP.
	 *
	 * @param string $ip IP address.
	 */
	abstract protected function build_url( string $ip ): string;

	/**
	 * Convert a decoded JSON body into a result.
	 *
	 * @param array<string,mixed> $data Decoded response.
	 */
	abstract protected function parse( array $data ): GeoResult;

	/**
	 * {@inheritDoc}
	 */
	public function lookup( string $ip ): GeoResult {
		if ( ! $this->is_available() ) {
			return GeoResult::failed( $this->get_id(), 'The provider is not configured.' );
		}

		$response = wp_safe_remote_get(
			$this->build_url( $ip ),
			array(
				'timeout'     => static::TIMEOUT,
				'redirection' => 1,
				'user-agent'  => 'GeoBlocker/' . GEOBLOCKER_VERSION,
				'headers'     => array( 'Accept' => 'application/json' ),
			)
		);

		if ( is_wp_error( $response ) ) {
			return GeoResult::failed( $this->get_id(), $response->get_error_message() );
		}

		$code = (int) wp_remote_retrieve_response_code( $response );
		if ( 429 === $code ) {
			return GeoResult::failed( $this->get_id(), 'Rate limit reached for the geolocation API.' );
		}
		if ( $code < 200 || $code >= 300 ) {
			return GeoResult::failed( $this->get_id(), sprintf( 'Geolocation API returned HTTP %d.', $code ) );
		}

		$data = json_decode( (string) wp_remote_retrieve_body( $response ), true );
		if ( ! is_array( $data ) ) {
			return GeoResult::failed( $this->get_id(), 'Invalid response from the geolocation API.' );
		}

		return $this->parse( $data );
	}
}
