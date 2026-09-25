<?php
/**
 * Flash notices for the GeoBlocker screen.
 *
 * @package GeoBlocker
 */

namespace GeoBlocker\Admin;

defined( 'ABSPATH' ) || exit;

/**
 * Stores one-time notices per user in a short-lived transient.
 */
final class Notices {

	/**
	 * Transient key for the current user.
	 */
	private static function key(): string {
		return 'geoblocker_notices_' . get_current_user_id();
	}

	/**
	 * Queue a notice.
	 *
	 * @param string $type    success|error|warning|info.
	 * @param string $message Plain-text message.
	 */
	public static function add( string $type, string $message ): void {
		$notices   = get_transient( self::key() );
		$notices   = is_array( $notices ) ? $notices : array();
		$notices[] = array(
			'type'    => in_array( $type, array( 'success', 'error', 'warning', 'info' ), true ) ? $type : 'info',
			'message' => $message,
		);
		set_transient( self::key(), $notices, 5 * MINUTE_IN_SECONDS );
	}

	/**
	 * Print and clear queued notices.
	 */
	public static function render(): void {
		$notices = get_transient( self::key() );
		if ( ! is_array( $notices ) || empty( $notices ) ) {
			return;
		}
		delete_transient( self::key() );
		foreach ( $notices as $notice ) {
			printf(
				'<div class="notice notice-%1$s is-dismissible"><p>%2$s</p></div>',
				esc_attr( (string) $notice['type'] ),
				esc_html( (string) $notice['message'] )
			);
		}
	}
}
