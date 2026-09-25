<?php
/**
 * Capability and nonce helpers.
 *
 * @package GeoBlocker
 */

namespace GeoBlocker\Security;

defined( 'ABSPATH' ) || exit;

/**
 * Centralised security checks.
 */
final class Guard {

	/**
	 * Capability required to manage GeoBlocker.
	 */
	public static function capability(): string {
		/**
		 * Filter the capability required to manage GeoBlocker. Defaults to manage_options.
		 *
		 * @param string $capability Capability.
		 */
		$cap = apply_filters( 'geoblocker_capability', 'manage_options' );
		return is_string( $cap ) && '' !== $cap ? $cap : 'manage_options';
	}

	/**
	 * Whether the current user may manage GeoBlocker.
	 */
	public static function current_user_can_manage(): bool {
		return function_exists( 'current_user_can' ) && current_user_can( self::capability() );
	}

	/**
	 * Whether the current visitor is a logged-in administrator (for the bypass rule).
	 */
	public static function current_user_is_admin(): bool {
		if ( ! function_exists( 'is_user_logged_in' ) || ! is_user_logged_in() ) {
			return false;
		}
		return current_user_can( 'manage_options' ) || ( is_multisite() && is_super_admin() );
	}

	/**
	 * Abort unless the current user can manage GeoBlocker and the nonce is valid.
	 * Used for admin-post handlers.
	 *
	 * @param string $action Nonce action.
	 * @param string $field  Nonce field name.
	 */
	public static function check_admin_request( string $action, string $field = '_wpnonce' ): void {
		if ( ! self::current_user_can_manage() ) {
			wp_die( esc_html__( 'You do not have permission to manage GeoBlocker.', 'geoblocker' ), '', array( 'response' => 403 ) );
		}
		check_admin_referer( $action, $field );
	}

	/**
	 * Same as check_admin_request() for AJAX handlers (JSON error responses).
	 *
	 * @param string $action Nonce action.
	 */
	public static function check_ajax_request( string $action ): void {
		if ( ! check_ajax_referer( $action, 'nonce', false ) ) {
			wp_send_json_error( array( 'message' => __( 'Your session has expired. Please reload the page and try again.', 'geoblocker' ) ), 403 );
		}
		if ( ! self::current_user_can_manage() ) {
			wp_send_json_error( array( 'message' => __( 'You do not have permission to do this.', 'geoblocker' ) ), 403 );
		}
	}
}
