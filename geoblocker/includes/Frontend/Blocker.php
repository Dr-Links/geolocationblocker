<?php
/**
 * Front-end enforcement.
 *
 * @package GeoBlocker
 */

namespace GeoBlocker\Frontend;

use GeoBlocker\Ip\IpDetector;
use GeoBlocker\Logging\Logger;
use GeoBlocker\Rules\Decision;
use GeoBlocker\Rules\Evaluator;
use GeoBlocker\Settings;

defined( 'ABSPATH' ) || exit;

/**
 * Runs the blocking check as early as practical.
 *
 * The check is hooked on `plugins_loaded` (before the theme, the query and
 * WooCommerce/Elementor rendering run). It loads no assets, performs no
 * database queries when the plugin is disabled (settings are autoloaded) and,
 * with the default local provider, no queries at all for allowed visitors.
 */
final class Blocker {

	/**
	 * Decision for the current request (available to other code via geoblocker_get_decision()).
	 *
	 * @var Decision|null
	 */
	private static ?Decision $decision = null;

	/**
	 * Register hooks.
	 */
	public static function register(): void {
		add_action( 'plugins_loaded', array( self::class, 'maybe_block' ), 1 );
	}

	/**
	 * Decision for the current request, if one was made.
	 */
	public static function current_decision(): ?Decision {
		return self::$decision;
	}

	/**
	 * Evaluate the current request and block it when required.
	 */
	public static function maybe_block(): void {
		if ( ! self::should_check() ) {
			return;
		}

		$ip       = IpDetector::instance()->get_client_ip();
		$decision = ( new Evaluator() )->evaluate( $ip );

		/**
		 * Filter the blocking decision for the current request.
		 *
		 * @param Decision $decision Decision.
		 */
		$filtered = apply_filters( 'geoblocker_decision', $decision );
		if ( $filtered instanceof Decision ) {
			$decision = $filtered;
		}

		self::$decision = $decision;

		if ( $decision->blocked || $decision->lookup_failed() ) {
			Logger::log( $decision );
		}

		if ( ! $decision->blocked ) {
			return;
		}

		/**
		 * Fires right before a visitor is blocked.
		 *
		 * @param Decision $decision Decision.
		 */
		do_action( 'geoblocker_before_block', $decision );

		( new BlockResponse() )->send( $decision );
	}

	/**
	 * Cheap checks that skip requests which must never be blocked.
	 */
	private static function should_check(): bool {
		// Emergency kill switch: define( 'GEOBLOCKER_DISABLED', true ); in wp-config.php.
		if ( defined( 'GEOBLOCKER_DISABLED' ) && GEOBLOCKER_DISABLED ) {
			return false;
		}

		$settings = Settings::all();
		if ( empty( $settings['enabled'] ) ) {
			return false;
		}

		// Command line, cron and installer requests.
		if ( ( defined( 'WP_CLI' ) && WP_CLI ) || wp_doing_cron() || ( defined( 'WP_INSTALLING' ) && WP_INSTALLING ) || 'cli' === PHP_SAPI ) {
			return false;
		}

		if ( ! empty( $settings['exclude_admin_login'] ) && self::is_admin_or_login_request() ) {
			return false;
		}

		// Never block the page blocked visitors are redirected to (prevents redirect loops).
		if ( Settings::ACTION_REDIRECT === $settings['action'] && self::is_redirect_target( (string) $settings['redirect_url'] ) ) {
			return false;
		}

		/**
		 * Filter whether GeoBlocker should check the current request.
		 *
		 * @param bool $check Whether to check.
		 */
		return (bool) apply_filters( 'geoblocker_should_check_request', true );
	}

	/**
	 * Whether this is wp-login.php or a wp-admin screen. admin-ajax.php is only
	 * treated as admin for logged-in users, so front-end AJAX endpoints remain
	 * protected for anonymous visitors.
	 */
	private static function is_admin_or_login_request(): bool {
		global $pagenow;

		if ( isset( $pagenow ) && in_array( $pagenow, array( 'wp-login.php', 'wp-register.php' ), true ) ) {
			return true;
		}

		if ( wp_doing_ajax() ) {
			return is_user_logged_in();
		}

		return is_admin();
	}

	/**
	 * Whether the current request is for the redirect target on this site.
	 *
	 * @param string $url Redirect URL.
	 */
	private static function is_redirect_target( string $url ): bool {
		if ( '' === $url ) {
			return false;
		}
		$target = wp_parse_url( $url );
		$home   = wp_parse_url( home_url() );
		if ( empty( $target['host'] ) || empty( $home['host'] ) || strtolower( $target['host'] ) !== strtolower( $home['host'] ) ) {
			return false;
		}
		$request_uri = isset( $_SERVER['REQUEST_URI'] ) ? (string) wp_parse_url( sanitize_text_field( wp_unslash( $_SERVER['REQUEST_URI'] ) ), PHP_URL_PATH ) : '/'; // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized
		return untrailingslashit( $request_uri ) === untrailingslashit( $target['path'] ?? '/' );
	}
}
