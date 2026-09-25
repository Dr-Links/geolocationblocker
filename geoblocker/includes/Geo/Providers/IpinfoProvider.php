<?php
/**
 * IPinfo Lite provider (optional, external, free token required).
 *
 * @package GeoBlocker
 */

namespace GeoBlocker\Geo\Providers;

use GeoBlocker\Geo\GeoResult;
use GeoBlocker\Settings;

defined( 'ABSPATH' ) || exit;

/**
 * Uses the free IPinfo Lite API (https://ipinfo.io/lite). Requires a free token.
 */
final class IpinfoProvider extends AbstractRemoteProvider {

	/**
	 * {@inheritDoc}
	 */
	public function get_id(): string {
		return 'ipinfo';
	}

	/**
	 * {@inheritDoc}
	 */
	public function get_label(): string {
		return __( 'IPinfo Lite (external API, free token required)', 'geoblocker' );
	}

	/**
	 * {@inheritDoc}
	 */
	public function is_available(): bool {
		return '' !== (string) Settings::get( 'ipinfo_token' );
	}

	/**
	 * {@inheritDoc}
	 *
	 * @param string $ip IP address.
	 */
	protected function build_url( string $ip ): string {
		return add_query_arg( 'token', rawurlencode( (string) Settings::get( 'ipinfo_token' ) ), 'https://api.ipinfo.io/lite/' . rawurlencode( $ip ) );
	}

	/**
	 * {@inheritDoc}
	 *
	 * @param array<string,mixed> $data Response.
	 */
	protected function parse( array $data ): GeoResult {
		if ( isset( $data['error'] ) ) {
			$message = is_array( $data['error'] ) ? (string) ( $data['error']['message'] ?? 'API error' ) : (string) $data['error'];
			return GeoResult::failed( $this->get_id(), sanitize_text_field( $message ) );
		}
		return GeoResult::found( (string) ( $data['country_code'] ?? '' ), (string) ( $data['continent_code'] ?? '' ), $this->get_id() );
	}
}
