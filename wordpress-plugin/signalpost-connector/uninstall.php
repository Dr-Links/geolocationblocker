<?php
/**
 * Uninstall: removes this plugin's local options only.
 *
 * Central conversations, visitors and settings are NOT deleted. The site's
 * credential is revoked on a best-effort basis so the deleted secret cannot
 * be reused; manage or delete central data from the Signalpost dashboard.
 *
 * @package SignalpostConnector
 */

if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

$signalpost_conn       = get_option( 'signalpost_connection', array() );
$signalpost_credential = get_option( 'signalpost_credential', '' );
if ( is_array( $signalpost_conn ) && ! empty( $signalpost_conn['central_url'] ) && is_string( $signalpost_credential ) && '' !== $signalpost_credential ) {
	wp_remote_post(
		$signalpost_conn['central_url'] . '/api/v1/integration/disconnect',
		array(
			'timeout'   => 3,
			'blocking'  => false,
			'sslverify' => true,
			'headers'   => array( 'Authorization' => 'Bearer ' . $signalpost_credential ),
		)
	);
}

delete_option( 'signalpost_connection' );
delete_option( 'signalpost_credential' );
delete_option( 'signalpost_config_cache' );
wp_clear_scheduled_hook( 'signalpost_refresh_config' );
