<?php
/**
 * Loads the chat widget on eligible front-end pages.
 *
 * @package SignalpostConnector
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Theme- and builder-independent: assets are enqueued through standard
 * WordPress hooks and the widget renders into its own isolated container.
 * No remote request is made while rendering pages; only cached config is used.
 */
class Signalpost_Frontend {

	/**
	 * Register hooks.
	 */
	public static function init() {
		add_action( 'wp_enqueue_scripts', array( __CLASS__, 'enqueue' ), 20 );
		// Declare WP Consent API support so consent-aware sites do not block the plugin.
		add_filter( 'wp_consent_api_registered_' . plugin_basename( SIGNALPOST_CONNECTOR_FILE ), '__return_true' );
	}

	/**
	 * Current request path, without query string or fragment.
	 *
	 * @return string
	 */
	public static function current_path() {
		$uri  = isset( $_SERVER['REQUEST_URI'] ) ? wp_unslash( $_SERVER['REQUEST_URI'] ) : '/'; // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized -- parsed below.
		$path = wp_parse_url( (string) $uri, PHP_URL_PATH );
		$path = is_string( $path ) ? $path : '/';
		return '/' . ltrim( sanitize_text_field( rawurldecode( $path ) ), '/' );
	}

	/**
	 * Prefix match used for hidden/excluded paths (mirrors the central server).
	 *
	 * @param string $path     Path.
	 * @param array  $prefixes Prefixes.
	 * @return bool
	 */
	public static function path_matches( $path, $prefixes ) {
		$path = '/' . ltrim( strtolower( $path ), '/' );
		foreach ( (array) $prefixes as $prefix ) {
			$prefix = strtolower( (string) $prefix );
			if ( '' === $prefix ) {
				continue;
			}
			if ( '/' === $prefix || $path === $prefix || 0 === strpos( $path, rtrim( $prefix, '/' ) . '/' )
				|| ( '.php' === substr( $prefix, -4 ) && 0 === strpos( $path, $prefix ) ) ) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Whether the current request is a page-builder editor or preview frame.
	 *
	 * @return bool
	 */
	private static function in_builder_preview() {
		// phpcs:disable WordPress.Security.NonceVerification.Recommended -- read-only detection.
		$markers = array( 'elementor-preview', 'et_fb', 'fl_builder', 'brizy-edit-iframe', 'vc_editable', 'bricks', 'ct_builder', 'tve' );
		foreach ( $markers as $marker ) {
			if ( isset( $_GET[ $marker ] ) ) {
				return true;
			}
		}
		// phpcs:enable
		return is_customize_preview();
	}

	/**
	 * Enqueue the widget when connected, enabled and the page is eligible.
	 */
	public static function enqueue() {
		if ( is_admin() || wp_doing_ajax() || ( function_exists( 'wp_is_json_request' ) && wp_is_json_request() ) || is_feed() || self::in_builder_preview() ) {
			return;
		}
		if ( ! Signalpost_Connection::is_connected() ) {
			return; // Safe disconnected state: nothing is loaded.
		}
		$config = Signalpost_Store::config();
		if ( empty( $config['widget']['enabled'] ) || empty( $config['endpoints']['widget_script'] ) || empty( $config['website']['public_key'] ) ) {
			return;
		}
		$path = self::current_path();
		if ( self::path_matches( $path, isset( $config['widget']['hidden_paths'] ) ? $config['widget']['hidden_paths'] : array() ) ) {
			return;
		}
		$tracking = isset( $config['tracking'] ) && is_array( $config['tracking'] ) ? $config['tracking'] : array();

		$client = array(
			'apiBase'  => esc_url_raw( $config['endpoints']['api_base'] ),
			'siteKey'  => sanitize_key( $config['website']['public_key'] ),
			'styleUrl' => esc_url_raw( $config['endpoints']['widget_style'] ),
			'widget'   => $config['widget'],
			'tracking' => array(
				'analyticsEnabled' => ! empty( $tracking['analytics_enabled'] ),
				'legalBasis'       => isset( $tracking['legal_basis'] ) ? $tracking['legal_basis'] : 'consent',
				'consentSource'    => isset( $tracking['consent_source'] ) ? $tracking['consent_source'] : 'widget',
				'policyVersion'    => isset( $tracking['policy_version'] ) ? (string) $tracking['policy_version'] : '1',
				'excludedPaths'    => isset( $tracking['excluded_paths'] ) ? array_values( (array) $tracking['excluded_paths'] ) : array(),
				'recordTitles'     => ! empty( $tracking['record_page_titles'] ),
				'recordReferrer'   => ! empty( $tracking['record_referrer'] ),
				// The plugin also evaluates exclusions server-side; the widget and the central server check again.
				'pageExcluded'     => self::path_matches( $path, isset( $tracking['excluded_paths'] ) ? $tracking['excluded_paths'] : array() ),
			),
			'polling'  => isset( $config['polling'] ) ? $config['polling'] : array(),
			'locale'   => get_locale(),
		);
		/**
		 * Filter the client configuration passed to the widget. Never add secrets here:
		 * this array is printed into public HTML.
		 *
		 * @param array $client Client configuration.
		 */
		$client = apply_filters( 'signalpost_widget_config', $client );

		$args = version_compare( get_bloginfo( 'version' ), '6.3', '>=' ) ? array( 'in_footer' => true, 'strategy' => 'defer' ) : true;
		wp_enqueue_script( 'signalpost-widget', esc_url_raw( $config['endpoints']['widget_script'] ), array(), SIGNALPOST_CONNECTOR_VERSION, $args );
		wp_add_inline_script( 'signalpost-widget', 'window.SignalpostConfig = ' . wp_json_encode( $client, JSON_HEX_TAG | JSON_HEX_AMP | JSON_UNESCAPED_SLASHES ) . ';', 'before' );

		if ( 'wp_consent_api' === $client['tracking']['consentSource'] ) {
			wp_add_inline_script( 'signalpost-widget', self::consent_bridge(), 'after' );
		}

		/**
		 * Fires after the widget is enqueued. Extension point for future integrations
		 * (e.g. WooCommerce). Integrations must authenticate visitors themselves and
		 * must never expose order data based on a visitor or conversation identifier alone.
		 */
		do_action( 'signalpost_widget_enqueued', $client );
	}

	/**
	 * Bridges the WP Consent API "statistics" category to the widget.
	 *
	 * @return string
	 */
	private static function consent_bridge() {
		return '(function(){function s(){if(typeof window.wp_has_consent==="function"&&window.Signalpost){window.Signalpost.setAnalyticsConsent(!!window.wp_has_consent("statistics"),"wp_consent_api");}}'
			. 'document.addEventListener("wp_listen_for_consent_change",s);window.addEventListener("signalpost:ready",s);})();';
	}
}
