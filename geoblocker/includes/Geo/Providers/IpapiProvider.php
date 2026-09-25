<?php
/**
 * ipapi.co provider (optional, external).
 *
 * @package GeoBlocker
 */

namespace GeoBlocker\Geo\Providers;

use GeoBlocker\Geo\GeoResult;
use GeoBlocker\Settings;

defined( 'ABSPATH' ) || exit;

/**
 * Uses https://ipapi.co. Works without a key (limited free tier); an API key
 * can be added for higher limits.
 */
final class IpapiProvider extends AbstractRemoteProvider {

	/**
	 * {@inheritDoc}
	 */
	public function get_id(): string {
		return 'ipapi';
	}

	/**
	 * {@inheritDoc}
	 */
	public function get_label(): string {
		return __( 'ipapi.co (external API, free tier available)', 'geoblocker' );
	}

	/**
	 * {@inheritDoc}
	 */
	public function is_available(): bool {
		return true;
	}

	/**
	 * {@inheritDoc}
	 *
	 * @param string $ip IP address.
	 */
	protected function build_url( string $ip ): string {
		$url = 'https://ipapi.co/' . rawurlencode( $ip ) . '/json/';
		$key = (string) Settings::get( 'ipapi_key' );
		return '' !== $key ? add_query_arg( 'key', rawurlencode( $key ), $url ) : $url;
	}

	/**
	 * {@inheritDoc}
	 *
	 * @param array<string,mixed> $data Response.
	 */
	protected function parse( array $data ): GeoResult {
		if ( ! empty( $data['error'] ) ) {
			return GeoResult::failed( $this->get_id(), sanitize_text_field( (string) ( $data['reason'] ?? 'API error' ) ) );
		}
		return GeoResult::found( (string) ( $data['country_code'] ?? $data['country'] ?? '' ), (string) ( $data['continent_code'] ?? '' ), $this->get_id() );
	}
}
