<?php
/**
 * Local option storage.
 *
 * @package SignalpostConnector
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Wraps the plugin's options. The site credential is kept in its own
 * non-autoloaded option (or a wp-config.php constant) and is never output.
 */
class Signalpost_Store {

	const OPT_CONNECTION = 'signalpost_connection';
	const OPT_CREDENTIAL = 'signalpost_credential';
	const OPT_CONFIG     = 'signalpost_config_cache';

	/**
	 * Connection metadata (no secrets).
	 *
	 * @return array
	 */
	public static function connection() {
		$defaults = array(
			'central_url'     => '',
			'status'          => 'disconnected',
			'key_prefix'      => '',
			'public_key'      => '',
			'site_name'       => '',
			'connected_at'    => 0,
			'last_success_at' => 0,
			'last_error'      => '',
			'last_error_at'   => 0,
		);
		$value    = get_option( self::OPT_CONNECTION, array() );
		return wp_parse_args( is_array( $value ) ? $value : array(), $defaults );
	}

	/**
	 * Merge and save connection metadata.
	 *
	 * @param array $changes Fields to change.
	 */
	public static function update_connection( array $changes ) {
		update_option( self::OPT_CONNECTION, array_merge( self::connection(), $changes ), false );
	}

	/**
	 * The site credential. A SIGNALPOST_CREDENTIAL constant in wp-config.php takes precedence.
	 *
	 * @return string
	 */
	public static function credential() {
		if ( defined( 'SIGNALPOST_CREDENTIAL' ) && is_string( SIGNALPOST_CREDENTIAL ) ) {
			return SIGNALPOST_CREDENTIAL;
		}
		$value = get_option( self::OPT_CREDENTIAL, '' );
		return is_string( $value ) ? $value : '';
	}

	/**
	 * Store a new credential (not autoloaded).
	 *
	 * @param string $credential Credential string.
	 */
	public static function set_credential( $credential ) {
		if ( '' === $credential ) {
			delete_option( self::OPT_CREDENTIAL );
			return;
		}
		update_option( self::OPT_CREDENTIAL, $credential, false );
	}

	/**
	 * Non-secret prefix of a credential, for display.
	 *
	 * @param string $credential Credential.
	 * @return string
	 */
	public static function prefix_of( $credential ) {
		return preg_match( '/^spk_([0-9a-f]{12})\./', $credential, $m ) ? $m[1] : '';
	}

	/**
	 * Last known good configuration from the central server.
	 *
	 * @return array
	 */
	public static function config() {
		$value = get_option( self::OPT_CONFIG, array() );
		return is_array( $value ) ? $value : array();
	}

	/**
	 * Save configuration.
	 *
	 * @param array $config Config payload from the central server.
	 */
	public static function set_config( array $config ) {
		$config['fetched_at'] = time();
		update_option( self::OPT_CONFIG, $config, true );
	}

	/**
	 * Remove all local state (does not touch central data).
	 */
	public static function forget() {
		delete_option( self::OPT_CREDENTIAL );
		delete_option( self::OPT_CONFIG );
		$conn = self::connection();
		update_option(
			self::OPT_CONNECTION,
			array(
				'central_url' => $conn['central_url'],
				'status'      => 'disconnected',
			),
			false
		);
	}
}
