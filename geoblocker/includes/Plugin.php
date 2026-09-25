<?php
/**
 * Main plugin orchestrator.
 *
 * @package GeoBlocker
 */

namespace GeoBlocker;

use GeoBlocker\Admin\AdminPage;
use GeoBlocker\Admin\Ajax;
use GeoBlocker\Admin\Actions;
use GeoBlocker\Frontend\Blocker;

defined( 'ABSPATH' ) || exit;

/**
 * Wires up the plugin components. Admin code is only loaded in wp-admin.
 */
final class Plugin {

	/**
	 * Singleton instance.
	 *
	 * @var Plugin|null
	 */
	private static ?Plugin $instance = null;

	/**
	 * Whether boot() already ran.
	 *
	 * @var bool
	 */
	private bool $booted = false;

	/**
	 * Shared instance.
	 */
	public static function instance(): Plugin {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	/**
	 * Register hooks.
	 */
	public function boot(): void {
		if ( $this->booted ) {
			return;
		}
		$this->booted = true;

		// Front-end enforcement (runs on every request, very cheap when disabled).
		Blocker::register();

		Cron::register();

		add_action( 'init', array( $this, 'load_textdomain' ) );

		// Multisite: new/deleted sites.
		add_action( 'wp_initialize_site', array( Installer::class, 'on_new_site' ), 200 );
		add_filter( 'wpmu_drop_tables', array( Installer::class, 'on_delete_site_tables' ) );

		if ( is_admin() ) {
			add_action( 'admin_init', array( Installer::class, 'maybe_upgrade' ), 5 );
			add_action( 'admin_init', array( Settings::class, 'register' ) );
			Privacy::register();

			( new AdminPage() )->register();
			Actions::register();
			Ajax::register();

			add_filter( 'plugin_action_links_' . GEOBLOCKER_BASENAME, array( $this, 'action_links' ) );
		}
	}

	/**
	 * Load translations.
	 */
	public function load_textdomain(): void {
		load_plugin_textdomain( 'geoblocker', false, dirname( GEOBLOCKER_BASENAME ) . '/languages' );
	}

	/**
	 * Add a Settings link on the Plugins screen.
	 *
	 * @param string[] $links Links.
	 * @return string[]
	 */
	public function action_links( $links ): array {
		$url = admin_url( 'admin.php?page=' . AdminPage::SLUG );
		array_unshift( $links, '<a href="' . esc_url( $url ) . '">' . esc_html__( 'Settings', 'geoblocker' ) . '</a>' );
		return (array) $links;
	}
}
