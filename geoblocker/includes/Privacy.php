<?php
/**
 * Privacy policy integration.
 *
 * @package GeoBlocker
 */

namespace GeoBlocker;

defined( 'ABSPATH' ) || exit;

/**
 * Adds suggested privacy policy text (Settings → Privacy → Policy Guide).
 */
final class Privacy {

	/**
	 * Register hooks.
	 */
	public static function register(): void {
		add_action( 'admin_init', array( self::class, 'add_policy_content' ) );
	}

	/**
	 * Suggested policy text.
	 */
	public static function policy_text(): string {
		$paragraphs = array(
			__( 'This website uses GeoBlocker to restrict access from certain geographical locations.', 'geoblocker' ),
			__( 'When you visit this website, your IP address is used to determine your country and continent. By default the lookup is performed locally on our server using a GeoIP database, so your IP address is not sent to any third party. If the site administrator has configured an external geolocation service, your IP address is sent to that service for the lookup.', 'geoblocker' ),
			__( 'Location results may be cached temporarily (by default for up to 7 days) under a one-way hashed key to improve performance. Your IP address is not stored permanently unless access logging is enabled.', 'geoblocker' ),
			__( 'If access logging is enabled and your visit is blocked, we record the date and time, your IP address (optionally anonymised), your country and continent, the page you requested, your browser user agent and the reason for the block. These logs are used for security purposes and are automatically deleted after the retention period configured by the administrator.', 'geoblocker' ),
		);

		return '<p class="privacy-policy-tutorial">' . esc_html__( 'Suggested text:', 'geoblocker' ) . '</p><p>' . implode( '</p><p>', array_map( 'esc_html', $paragraphs ) ) . '</p>';
	}

	/**
	 * Register the suggested text with WordPress.
	 */
	public static function add_policy_content(): void {
		if ( function_exists( 'wp_add_privacy_policy_content' ) ) {
			wp_add_privacy_policy_content( 'GeoBlocker', wp_kses_post( self::policy_text() ) );
		}
	}
}
