<?php
/**
 * Plugin Name:       GeoBlocker
 * Plugin URI:        https://github.com/dr-links/geolocationblocker
 * Description:       Block website visitors by country and/or continent using a local GeoIP database (no visitor data sent to third parties by default), with whitelisting, trusted proxy / Cloudflare support, testing tools and privacy-friendly logging.
 * Version:           1.0.0
 * Requires at least: 6.0
 * Requires PHP:      8.1
 * Author:            Dr Links
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       geoblocker
 * Domain Path:       /languages
 *
 * @package GeoBlocker
 */

defined( 'ABSPATH' ) || exit;

define( 'GEOBLOCKER_VERSION', '1.0.0' );
define( 'GEOBLOCKER_DB_VERSION', '1.0.0' );
define( 'GEOBLOCKER_FILE', __FILE__ );
define( 'GEOBLOCKER_DIR', plugin_dir_path( __FILE__ ) );
define( 'GEOBLOCKER_URL', plugin_dir_url( __FILE__ ) );
define( 'GEOBLOCKER_BASENAME', plugin_basename( __FILE__ ) );
define( 'GEOBLOCKER_MIN_PHP', '8.1' );

/*
 * Refuse to load on unsupported PHP versions instead of causing a fatal error.
 */
if ( version_compare( PHP_VERSION, GEOBLOCKER_MIN_PHP, '<' ) ) {
	add_action(
		'admin_notices',
		static function () {
			echo '<div class="notice notice-error"><p>';
			echo esc_html(
				sprintf(
					/* translators: 1: required PHP version, 2: current PHP version. */
					__( 'GeoBlocker requires PHP %1$s or newer. Your server is running PHP %2$s, so the plugin has not been loaded.', 'geoblocker' ),
					GEOBLOCKER_MIN_PHP,
					PHP_VERSION
				)
			);
			echo '</p></div>';
		}
	);
	return;
}

require_once GEOBLOCKER_DIR . 'includes/Autoloader.php';
\GeoBlocker\Autoloader::register();

register_activation_hook( __FILE__, array( \GeoBlocker\Installer::class, 'activate' ) );
register_deactivation_hook( __FILE__, array( \GeoBlocker\Installer::class, 'deactivate' ) );

\GeoBlocker\Plugin::instance()->boot();
