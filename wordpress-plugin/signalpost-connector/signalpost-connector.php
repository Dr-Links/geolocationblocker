<?php
/**
 * Plugin Name:       Signalpost Connector
 * Plugin URI:        https://github.com/dr-links/geolocationblocker
 * Description:       Connects this WordPress site to a Signalpost central live chat server and loads the chat widget. Theme- and page-builder-independent.
 * Version:           1.0.0
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * Author:            Signalpost
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       signalpost-connector
 * Domain Path:       /languages
 *
 * @package SignalpostConnector
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'SIGNALPOST_CONNECTOR_VERSION', '1.0.0' );
define( 'SIGNALPOST_CONNECTOR_FILE', __FILE__ );
define( 'SIGNALPOST_CONNECTOR_DIR', plugin_dir_path( __FILE__ ) );
define( 'SIGNALPOST_CONNECTOR_URL', plugin_dir_url( __FILE__ ) );

require_once SIGNALPOST_CONNECTOR_DIR . 'includes/class-signalpost-store.php';
require_once SIGNALPOST_CONNECTOR_DIR . 'includes/class-signalpost-api.php';
require_once SIGNALPOST_CONNECTOR_DIR . 'includes/class-signalpost-connection.php';
require_once SIGNALPOST_CONNECTOR_DIR . 'includes/class-signalpost-frontend.php';
require_once SIGNALPOST_CONNECTOR_DIR . 'includes/class-signalpost-admin.php';

register_activation_hook( __FILE__, array( 'Signalpost_Connection', 'activate' ) );
register_deactivation_hook( __FILE__, array( 'Signalpost_Connection', 'deactivate' ) );

add_action(
	'plugins_loaded',
	static function () {
		load_plugin_textdomain( 'signalpost-connector', false, dirname( plugin_basename( __FILE__ ) ) . '/languages' );
		Signalpost_Connection::init();
		Signalpost_Frontend::init();
		if ( is_admin() ) {
			Signalpost_Admin::init();
		}
	}
);
