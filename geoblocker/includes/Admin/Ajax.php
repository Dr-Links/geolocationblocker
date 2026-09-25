<?php
/**
 * AJAX endpoints for the admin testing tool.
 *
 * @package GeoBlocker
 */

namespace GeoBlocker\Admin;

use GeoBlocker\Geo\Countries;
use GeoBlocker\Ip\IpDetector;
use GeoBlocker\Ip\IpUtils;
use GeoBlocker\Rules\Evaluator;
use GeoBlocker\Security\Guard;
use GeoBlocker\Settings;

defined( 'ABSPATH' ) || exit;

/**
 * Admin-only AJAX handlers (nonce + capability protected).
 */
final class Ajax {

	public const NONCE = 'geoblocker_admin';

	/**
	 * Register handlers (logged-in only; no nopriv handlers exist).
	 */
	public static function register(): void {
		add_action( 'wp_ajax_geoblocker_test_ip', array( self::class, 'test_ip' ) );
	}

	/**
	 * Readable provider name.
	 *
	 * @param string $id Provider id.
	 */
	private static function provider_label( string $id ): string {
		if ( '' === $id ) {
			return '';
		}
		if ( 'cloudflare' === $id ) {
			return __( 'Cloudflare CF-IPCountry header', 'geoblocker' );
		}
		$providers = \GeoBlocker\Geo\GeoLocator::instance()->get_providers();
		return isset( $providers[ $id ] ) ? $providers[ $id ]->get_label() : $id;
	}

	/**
	 * Test an IP (or the current IP) against the rules.
	 */
	public static function test_ip(): void {
		Guard::check_ajax_request( self::NONCE );

		$detector = IpDetector::instance();
		$current  = $detector->get_client_ip();
		$raw      = isset( $_POST['ip'] ) ? sanitize_text_field( wp_unslash( $_POST['ip'] ) ) : ''; // phpcs:ignore WordPress.Security.NonceVerification.Missing -- verified in check_ajax_request().
		$use_self = '' === $raw || 'current' === $raw;
		$ip       = $use_self ? $current : IpUtils::normalize( $raw );

		if ( '' === $ip ) {
			wp_send_json_error(
				array(
					'message' => $use_self
						? __( 'Your IP address could not be determined.', 'geoblocker' )
						: __( 'Please enter a valid IPv4 or IPv6 address.', 'geoblocker' ),
				),
				400
			);
		}

		$settings = Settings::all();
		$decision = ( new Evaluator() )->evaluate(
			$ip,
			array(
				'ignore_enabled' => true,
				'check_user'     => false,
				'is_visitor'     => $ip === $current,
			)
		);

		$notes = array();
		if ( empty( $settings['enabled'] ) ) {
			$notes[] = __( 'GeoBlocker is currently disabled. The result shows what would happen if it were enabled.', 'geoblocker' );
		}
		if ( 'private_ip' === $decision->reason ) {
			$notes[] = __( 'This is a private or local IP address. If this is the address detected for real visitors, your site is behind a proxy or CDN: configure it on the Proxy & CDN tab.', 'geoblocker' );
		}
		if ( $ip === $current && ! empty( $settings['admin_bypass'] ) && Guard::current_user_is_admin() ) {
			$notes[] = __( 'You are logged in as an administrator and the administrator bypass is enabled, so you personally will never be blocked.', 'geoblocker' );
		}
		if ( $decision->blocked && ! empty( $settings['exclude_admin_login'] ) ) {
			$notes[] = __( 'The login page and dashboard stay accessible because "Never block wp-admin and the login page" is enabled.', 'geoblocker' );
		}

		$details = $ip === $current ? $detector->details() : null;

		wp_send_json_success(
			array(
				'ip'            => $ip,
				'isCurrent'     => $ip === $current,
				'ipSource'      => $details ? $details['source'] : '',
				'country'       => $decision->country,
				'countryName'   => '' !== $decision->country ? Countries::country_name( $decision->country ) : '',
				'continent'     => $decision->continent,
				'continentName' => '' !== $decision->continent ? Countries::continent_name( $decision->continent ) : '',
				'blocked'       => $decision->blocked,
				'reason'        => $decision->reason,
				'reasonLabel'   => $decision->reason_label(),
				'whitelisted'   => $decision->whitelisted,
				'provider'      => self::provider_label( $decision->provider ),
				'fromCache'     => $decision->from_cache,
				'geoError'      => $decision->geo_error,
				'enabled'       => ! empty( $settings['enabled'] ),
				'notes'         => $notes,
			)
		);
	}
}
