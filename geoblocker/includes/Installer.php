<?php
/**
 * Activation, deactivation and upgrade routines.
 *
 * @package GeoBlocker
 */

namespace GeoBlocker;

use GeoBlocker\Logging\Logger;

defined( 'ABSPATH' ) || exit;

/**
 * Installer.
 */
final class Installer {

	public const DB_VERSION_OPTION = 'geoblocker_db_version';

	/**
	 * Activation hook.
	 *
	 * @param bool $network_wide Whether network-activated on multisite.
	 */
	public static function activate( $network_wide = false ): void {
		if ( is_multisite() && $network_wide ) {
			$site_ids = get_sites(
				array(
					'fields'   => 'ids',
					'number'   => 500,
					'archived' => 0,
					'deleted'  => 0,
				)
			);
			foreach ( $site_ids as $site_id ) {
				switch_to_blog( (int) $site_id );
				self::install_site();
				restore_current_blog();
			}
			return;
		}
		self::install_site();
	}

	/**
	 * Install for the current site.
	 */
	public static function install_site(): void {
		Logger::create_table();
		update_option( self::DB_VERSION_OPTION, GEOBLOCKER_DB_VERSION, false );

		// Store defaults once (autoloaded: read on every request without a query).
		if ( false === get_option( Settings::OPTION ) ) {
			add_option( Settings::OPTION, Settings::defaults(), '', true );
		}

		Cron::schedule();
	}

	/**
	 * Create tables for a site added after network activation.
	 *
	 * @param \WP_Site $site New site.
	 */
	public static function on_new_site( $site ): void {
		if ( ! function_exists( 'is_plugin_active_for_network' ) ) {
			require_once ABSPATH . 'wp-admin/includes/plugin.php';
		}
		if ( ! is_plugin_active_for_network( GEOBLOCKER_BASENAME ) ) {
			return;
		}
		switch_to_blog( (int) $site->blog_id );
		self::install_site();
		restore_current_blog();
	}

	/**
	 * Drop tables when a site is deleted.
	 *
	 * @param string[] $tables Tables to drop.
	 * @return string[]
	 */
	public static function on_delete_site_tables( $tables ): array {
		global $wpdb;
		$tables   = (array) $tables;
		$tables[] = $wpdb->prefix . Logger::TABLE_SUFFIX;
		return $tables;
	}

	/**
	 * Run upgrades when the stored DB version is outdated (cheap: autoloaded option compare).
	 */
	public static function maybe_upgrade(): void {
		if ( get_option( self::DB_VERSION_OPTION ) !== GEOBLOCKER_DB_VERSION ) {
			self::install_site();
		}
	}

	/**
	 * Deactivation hook: remove scheduled events. Data is kept until uninstall.
	 *
	 * @param bool $network_wide Whether network-deactivated.
	 */
	public static function deactivate( $network_wide = false ): void {
		if ( is_multisite() && $network_wide ) {
			$site_ids = get_sites(
				array(
					'fields' => 'ids',
					'number' => 500,
				)
			);
			foreach ( $site_ids as $site_id ) {
				switch_to_blog( (int) $site_id );
				Cron::unschedule();
				restore_current_blog();
			}
			return;
		}
		Cron::unschedule();
	}
}
