<?php
/**
 * Uninstall GeoBlocker: remove all options, transients, tables, cron events
 * and downloaded database files created by the plugin.
 *
 * @package GeoBlocker
 */

// Only run when WordPress uninstalls the plugin.
if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

/**
 * Remove GeoBlocker data from the current site.
 */
function geoblocker_uninstall_site() {
	global $wpdb;

	$options = array(
		'geoblocker_settings',
		'geoblocker_db_version',
		'geoblocker_geoip_db',
		'geoblocker_cloudflare_ranges',
	);
	foreach ( $options as $option ) {
		delete_option( $option );
	}

	// Transients (cached lookups and admin notices).
	// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching
	$wpdb->query(
		$wpdb->prepare(
			"DELETE FROM {$wpdb->options} WHERE option_name LIKE %s OR option_name LIKE %s",
			$wpdb->esc_like( '_transient_geoblocker_' ) . '%',
			$wpdb->esc_like( '_transient_timeout_geoblocker_' ) . '%'
		)
	);

	wp_clear_scheduled_hook( 'geoblocker_daily_maintenance' );
	wp_clear_scheduled_hook( 'geoblocker_weekly_maintenance' );

	$table = $wpdb->prefix . 'geoblocker_log';
	$wpdb->query( "DROP TABLE IF EXISTS `{$table}`" ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared, WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.DirectDatabaseQuery.SchemaChange

	// Downloaded GeoIP database.
	$uploads = wp_upload_dir( null, false );
	$dir     = trailingslashit( $uploads['basedir'] ) . 'geoblocker';
	if ( is_dir( $dir ) ) {
		foreach ( array( 'geoblocker-country.mmdb', 'index.php', '.htaccess' ) as $file ) {
			if ( file_exists( $dir . '/' . $file ) ) {
				wp_delete_file( $dir . '/' . $file );
			}
		}
		foreach ( (array) glob( $dir . '/*.tmp' ) as $tmp ) {
			wp_delete_file( (string) $tmp );
		}
		@rmdir( $dir ); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged, WordPress.WP.AlternativeFunctions.file_system_operations_rmdir
	}
}

if ( is_multisite() ) {
	$geoblocker_site_ids = get_sites(
		array(
			'fields' => 'ids',
			'number' => 0,
		)
	);
	foreach ( $geoblocker_site_ids as $geoblocker_site_id ) {
		switch_to_blog( (int) $geoblocker_site_id );
		geoblocker_uninstall_site();
		restore_current_blog();
	}
} else {
	geoblocker_uninstall_site();
}
