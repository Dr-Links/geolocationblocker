<?php
/**
 * Pairing, configuration refresh, rotation and disconnection.
 *
 * @package SignalpostConnector
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Manages the link to the central server.
 */
class Signalpost_Connection {

	const CRON_HOOK = 'signalpost_refresh_config';
	/** Seconds after which cached configuration is refreshed. */
	const REFRESH_AFTER = 900;

	/**
	 * Register hooks.
	 */
	public static function init() {
		add_filter( 'cron_schedules', array( __CLASS__, 'cron_schedules' ) );
		add_action( self::CRON_HOOK, array( __CLASS__, 'refresh' ) );
		if ( ! wp_next_scheduled( self::CRON_HOOK ) && self::is_connected() ) {
			wp_schedule_event( time() + 60, 'signalpost_15min', self::CRON_HOOK );
		}
	}

	/**
	 * Add a 15-minute cron interval.
	 *
	 * @param array $schedules Schedules.
	 * @return array
	 */
	public static function cron_schedules( $schedules ) {
		$schedules['signalpost_15min'] = array(
			'interval' => 900,
			'display'  => __( 'Every 15 minutes (Signalpost)', 'signalpost-connector' ),
		);
		return $schedules;
	}

	/**
	 * Activation: nothing remote happens until the admin pairs the site.
	 */
	public static function activate() {
		if ( false === get_option( Signalpost_Store::OPT_CONNECTION, false ) ) {
			add_option( Signalpost_Store::OPT_CONNECTION, array( 'status' => 'disconnected' ), '', false );
		}
	}

	/**
	 * Deactivation keeps the connection (and all central data); it only stops background jobs.
	 */
	public static function deactivate() {
		wp_clear_scheduled_hook( self::CRON_HOOK );
	}

	/**
	 * Whether a usable credential is stored.
	 *
	 * @return bool
	 */
	public static function is_connected() {
		$conn = Signalpost_Store::connection();
		return 'connected' === $conn['status'] && '' !== Signalpost_Store::credential() && '' !== $conn['central_url'];
	}

	/**
	 * Exchange a pairing code for a credential.
	 *
	 * @param string $central_url Central server URL.
	 * @param string $code        Pairing code.
	 * @return true|WP_Error
	 */
	public static function pair( $central_url, $code ) {
		$central = Signalpost_API::normalize_central_url( $central_url );
		if ( is_wp_error( $central ) ) {
			return $central;
		}
		$code = strtoupper( preg_replace( '/[^A-Za-z0-9]/', '', (string) $code ) );
		if ( 16 !== strlen( $code ) ) {
			return new WP_Error( 'invalid_code', __( 'The pairing code has 16 characters, like ABCD-EFGH-JKLM-NPQR.', 'signalpost-connector' ) );
		}
		$result = Signalpost_API::request(
			'POST',
			$central,
			'/integration/pair',
			array(
				'pairing_code'   => $code,
				'site_url'       => home_url( '/' ),
				'plugin_version' => SIGNALPOST_CONNECTOR_VERSION,
				'wp_version'     => get_bloginfo( 'version' ),
			)
		);
		if ( is_wp_error( $result ) ) {
			self::record_error( $result->get_error_code() );
			return $result;
		}
		if ( empty( $result['credential'] ) || ! is_string( $result['credential'] ) || '' === Signalpost_Store::prefix_of( $result['credential'] ) ) {
			return new WP_Error( 'bad_response', __( 'Unexpected response from the Signalpost server.', 'signalpost-connector' ) );
		}
		Signalpost_Store::set_credential( $result['credential'] );
		Signalpost_Store::update_connection(
			array(
				'central_url'     => $central,
				'status'          => 'connected',
				'key_prefix'      => Signalpost_Store::prefix_of( $result['credential'] ),
				'public_key'      => isset( $result['website']['public_key'] ) ? sanitize_key( $result['website']['public_key'] ) : '',
				'site_name'       => isset( $result['website']['name'] ) ? sanitize_text_field( $result['website']['name'] ) : '',
				'connected_at'    => time(),
				'last_success_at' => time(),
				'last_error'      => '',
			)
		);
		if ( ! wp_next_scheduled( self::CRON_HOOK ) ) {
			wp_schedule_event( time() + 900, 'signalpost_15min', self::CRON_HOOK );
		}
		return self::refresh();
	}

	/**
	 * Fetch configuration from the central server, performing a requested rotation first.
	 *
	 * @return true|WP_Error
	 */
	public static function refresh() {
		if ( ! self::is_connected() ) {
			return new WP_Error( 'not_connected', __( 'This site is not connected.', 'signalpost-connector' ) );
		}
		$conn   = Signalpost_Store::connection();
		$config = Signalpost_API::request( 'GET', $conn['central_url'], '/integration/config', null, Signalpost_Store::credential() );
		if ( is_wp_error( $config ) ) {
			return self::handle_failure( $config );
		}
		if ( ! empty( $config['rotation_requested'] ) ) {
			$rotated = self::rotate();
			if ( is_wp_error( $rotated ) ) {
				return $rotated;
			}
		}
		Signalpost_API::request(
			'POST',
			$conn['central_url'],
			'/integration/heartbeat',
			array(
				'plugin_version' => SIGNALPOST_CONNECTOR_VERSION,
				'wp_version'     => get_bloginfo( 'version' ),
			),
			Signalpost_Store::credential()
		);
		return self::store_config( $config );
	}

	/**
	 * Replace the credential server-to-server. The new secret is never shown to anyone.
	 *
	 * @return true|WP_Error
	 */
	public static function rotate() {
		if ( defined( 'SIGNALPOST_CREDENTIAL' ) ) {
			return new WP_Error( 'constant_credential', __( 'The credential is defined in wp-config.php. Rotate it by re-pairing and updating the constant.', 'signalpost-connector' ) );
		}
		$conn   = Signalpost_Store::connection();
		$result = Signalpost_API::request( 'POST', $conn['central_url'], '/integration/rotate', array(), Signalpost_Store::credential() );
		if ( is_wp_error( $result ) ) {
			return self::handle_failure( $result );
		}
		if ( empty( $result['credential'] ) || '' === Signalpost_Store::prefix_of( (string) $result['credential'] ) ) {
			return new WP_Error( 'bad_response', __( 'Unexpected response from the Signalpost server.', 'signalpost-connector' ) );
		}
		Signalpost_Store::set_credential( $result['credential'] );
		Signalpost_Store::update_connection(
			array(
				'key_prefix'      => Signalpost_Store::prefix_of( $result['credential'] ),
				'last_success_at' => time(),
			)
		);
		return true;
	}

	/**
	 * Revoke this site's credential centrally and forget it locally.
	 * Conversations and visitor data on the central server are NOT deleted.
	 *
	 * @param bool $remote Whether to notify the central server.
	 * @return true
	 */
	public static function disconnect( $remote = true ) {
		$conn = Signalpost_Store::connection();
		if ( $remote && self::is_connected() ) {
			Signalpost_API::request( 'POST', $conn['central_url'], '/integration/disconnect', array(), Signalpost_Store::credential() );
		}
		Signalpost_Store::forget();
		wp_clear_scheduled_hook( self::CRON_HOOK );
		return true;
	}

	/**
	 * Push widget/tracking settings edited in WordPress to the central server.
	 *
	 * @param array $payload Keys "widget" and/or "tracking".
	 * @return true|WP_Error
	 */
	public static function push_settings( array $payload ) {
		if ( ! self::is_connected() ) {
			return new WP_Error( 'not_connected', __( 'This site is not connected.', 'signalpost-connector' ) );
		}
		$conn   = Signalpost_Store::connection();
		$config = Signalpost_API::request( 'PUT', $conn['central_url'], '/integration/settings', $payload, Signalpost_Store::credential() );
		if ( is_wp_error( $config ) ) {
			return 'validation_failed' === $config->get_error_code() ? $config : self::handle_failure( $config );
		}
		return self::store_config( $config );
	}

	/**
	 * Validate and cache configuration.
	 *
	 * @param array $config Config payload.
	 * @return true|WP_Error
	 */
	private static function store_config( array $config ) {
		$conn = Signalpost_Store::connection();
		// Scripts may only be loaded from the configured central server.
		$script = isset( $config['endpoints']['widget_script'] ) ? (string) $config['endpoints']['widget_script'] : '';
		if ( 0 !== strpos( $script, $conn['central_url'] . '/' ) ) {
			return new WP_Error( 'bad_response', __( 'The server returned an unexpected widget address.', 'signalpost-connector' ) );
		}
		Signalpost_Store::set_config( $config );
		Signalpost_Store::update_connection(
			array(
				'last_success_at' => time(),
				'last_error'      => '',
				'site_name'       => isset( $config['website']['name'] ) ? sanitize_text_field( $config['website']['name'] ) : $conn['site_name'],
				'public_key'      => isset( $config['website']['public_key'] ) ? sanitize_key( $config['website']['public_key'] ) : $conn['public_key'],
			)
		);
		return true;
	}

	/**
	 * Record a failure. Rejected credentials put the plugin into the safe disconnected state.
	 *
	 * @param WP_Error $error Error.
	 * @return WP_Error
	 */
	private static function handle_failure( WP_Error $error ) {
		self::record_error( $error->get_error_code() );
		$data = $error->get_error_data();
		if ( is_array( $data ) && isset( $data['status'] ) && 401 === (int) $data['status'] ) {
			Signalpost_Store::update_connection( array( 'status' => 'revoked' ) );
			delete_option( Signalpost_Store::OPT_CONFIG );
		}
		return $error;
	}

	/**
	 * Store a short error code for diagnostics.
	 *
	 * @param string $code Error code.
	 */
	private static function record_error( $code ) {
		Signalpost_Store::update_connection(
			array(
				'last_error'    => sanitize_key( $code ),
				'last_error_at' => time(),
			)
		);
	}
}
