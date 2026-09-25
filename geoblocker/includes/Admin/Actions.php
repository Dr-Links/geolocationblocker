<?php
/**
 * admin-post.php handlers for one-off admin actions.
 *
 * @package GeoBlocker
 */

namespace GeoBlocker\Admin;

use GeoBlocker\Geo\DatabaseUpdater;
use GeoBlocker\Geo\GeoLocator;
use GeoBlocker\Ip\CloudflareRanges;
use GeoBlocker\Logging\Logger;
use GeoBlocker\Security\Guard;

defined( 'ABSPATH' ) || exit;

/**
 * Every handler verifies capability + nonce, performs the action and
 * redirects back (Post/Redirect/Get) with a notice.
 */
final class Actions {

	public const DOWNLOAD_DB = 'geoblocker_download_db';
	public const CLEAR_CACHE = 'geoblocker_clear_cache';
	public const REFRESH_CF  = 'geoblocker_refresh_cf';
	public const CLEAR_LOGS  = 'geoblocker_clear_logs';

	/**
	 * Register handlers.
	 */
	public static function register(): void {
		add_action( 'admin_post_' . self::DOWNLOAD_DB, array( self::class, 'download_db' ) );
		add_action( 'admin_post_' . self::CLEAR_CACHE, array( self::class, 'clear_cache' ) );
		add_action( 'admin_post_' . self::REFRESH_CF, array( self::class, 'refresh_cf' ) );
		add_action( 'admin_post_' . self::CLEAR_LOGS, array( self::class, 'clear_logs' ) );
	}

	/**
	 * Print a hidden-field action form button.
	 *
	 * @param string $action  Action name.
	 * @param string $label   Button label.
	 * @param string $classes Button classes.
	 * @param array  $attrs   Extra form attributes.
	 */
	public static function button( string $action, string $label, string $classes = 'button', array $attrs = array() ): void {
		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" class="geoblocker-inline-form"';
		foreach ( $attrs as $attr => $value ) {
			echo ' ' . esc_attr( $attr ) . '="' . esc_attr( $value ) . '"';
		}
		echo '>';
		echo '<input type="hidden" name="action" value="' . esc_attr( $action ) . '">';
		wp_nonce_field( $action );
		echo '<button type="submit" class="' . esc_attr( $classes ) . '">' . esc_html( $label ) . '</button>';
		echo '</form>';
	}

	/**
	 * Download / update the GeoIP database.
	 */
	public static function download_db(): void {
		Guard::check_admin_request( self::DOWNLOAD_DB );

		$result = DatabaseUpdater::update();
		if ( is_wp_error( $result ) ) {
			Notices::add( 'error', $result->get_error_message() );
		} else {
			Notices::add( 'success', __( 'The GeoIP database was installed successfully.', 'geoblocker' ) );
		}
		self::back( 'geolocation' );
	}

	/**
	 * Clear cached lookups.
	 */
	public static function clear_cache(): void {
		Guard::check_admin_request( self::CLEAR_CACHE );
		GeoLocator::instance()->cache()->flush();
		Notices::add( 'success', __( 'The geolocation cache was cleared.', 'geoblocker' ) );
		self::back( 'geolocation' );
	}

	/**
	 * Refresh Cloudflare ranges.
	 */
	public static function refresh_cf(): void {
		Guard::check_admin_request( self::REFRESH_CF );
		$result = CloudflareRanges::refresh();
		if ( is_wp_error( $result ) ) {
			Notices::add( 'error', $result->get_error_message() );
		} else {
			Notices::add( 'success', __( 'Cloudflare IP ranges were updated.', 'geoblocker' ) );
		}
		self::back( 'proxy' );
	}

	/**
	 * Delete all logs.
	 */
	public static function clear_logs(): void {
		Guard::check_admin_request( self::CLEAR_LOGS );
		Logger::clear();
		Notices::add( 'success', __( 'All log entries were deleted.', 'geoblocker' ) );
		self::back( 'logs' );
	}

	/**
	 * Redirect back to a tab.
	 *
	 * @param string $tab Tab slug.
	 */
	private static function back( string $tab ): void {
		wp_safe_redirect( AdminPage::url( $tab ) );
		exit;
	}
}
