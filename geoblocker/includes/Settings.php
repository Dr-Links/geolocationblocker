<?php
/**
 * Settings storage, defaults and sanitization.
 *
 * All settings live in a single autoloaded option so that reading them on the
 * front end never costs an extra database query.
 *
 * @package GeoBlocker
 */

namespace GeoBlocker;

use GeoBlocker\Geo\Countries;
use GeoBlocker\Ip\IpUtils;

defined( 'ABSPATH' ) || exit;

/**
 * Settings manager.
 */
final class Settings {

	public const OPTION = 'geoblocker_settings';
	public const GROUP  = 'geoblocker_settings_group';

	public const MODE_COUNTRIES  = 'countries';
	public const MODE_CONTINENTS = 'continents';
	public const MODE_BOTH       = 'both';

	public const ACTION_PAGE     = 'page';
	public const ACTION_REDIRECT = 'redirect';
	public const ACTION_403      = 'forbidden';
	public const ACTION_MESSAGE  = 'message';

	public const RETENTION_CHOICES = array( 7, 30, 90, 365, 0 );

	/**
	 * Fields owned by each admin tab. Saving one tab never touches another tab's values.
	 */
	private const TAB_FIELDS = array(
		'rules'       => array( 'enabled', 'mode', 'blocked_countries', 'blocked_continents', 'on_failure' ),
		'action'      => array( 'action', 'redirect_url', 'redirect_status', 'page_title', 'page_content', 'message' ),
		'whitelist'   => array( 'whitelist_ips', 'whitelist_countries', 'admin_bypass', 'exclude_admin_login' ),
		'geolocation' => array( 'provider', 'use_cloudflare_country', 'local_db_source', 'maxmind_license_key', 'custom_db_path', 'ipapi_key', 'ipinfo_token', 'cache_ttl', 'auto_update_db' ),
		'proxy'       => array( 'trust_cloudflare', 'trusted_proxies', 'proxy_header', 'proxy_custom_header' ),
		'logging'     => array( 'logging', 'log_retention', 'log_anonymize_ip', 'log_query_strings', 'log_failures' ),
	);

	/**
	 * Per-request cache of the merged settings.
	 *
	 * @var array<string,mixed>|null
	 */
	private static ?array $cache = null;

	/**
	 * Default settings.
	 *
	 * @return array<string,mixed>
	 */
	public static function defaults(): array {
		return array(
			// Rules.
			'enabled'                => false,
			'mode'                   => self::MODE_COUNTRIES,
			'blocked_countries'      => array(),
			'blocked_continents'     => array(),
			'on_failure'             => 'allow',
			// Block action.
			'action'                 => self::ACTION_PAGE,
			'redirect_url'           => '',
			'redirect_status'        => 302,
			'page_title'             => 'Access restricted',
			'page_content'           => '<h1>Access restricted</h1><p>Sorry, this website is not available in your region.</p>',
			'message'                => 'Sorry, this website is not available in your region.',
			// Whitelist.
			'whitelist_ips'          => array(),
			'whitelist_countries'    => array(),
			'admin_bypass'           => true,
			'exclude_admin_login'    => true,
			// Geolocation.
			'provider'               => 'local',
			'use_cloudflare_country' => true,
			'local_db_source'        => 'dbip',
			'maxmind_license_key'    => '',
			'custom_db_path'         => '',
			'ipapi_key'              => '',
			'ipinfo_token'           => '',
			'cache_ttl'              => 7 * DAY_IN_SECONDS,
			'auto_update_db'         => true,
			// Proxy.
			'trust_cloudflare'       => false,
			'trusted_proxies'        => array(),
			'proxy_header'           => 'x_forwarded_for',
			'proxy_custom_header'    => '',
			// Logging.
			'logging'                => false,
			'log_retention'          => 30,
			'log_anonymize_ip'       => false,
			'log_query_strings'      => false,
			'log_failures'           => true,
		);
	}

	/**
	 * Get all settings merged with defaults.
	 *
	 * @return array<string,mixed>
	 */
	public static function all(): array {
		if ( null === self::$cache ) {
			$stored      = get_option( self::OPTION, array() );
			self::$cache = array_merge( self::defaults(), is_array( $stored ) ? $stored : array() );
		}
		return self::$cache;
	}

	/**
	 * Get a single setting.
	 *
	 * @param string $key Setting key.
	 * @return mixed
	 */
	public static function get( string $key ) {
		$all = self::all();
		return $all[ $key ] ?? null;
	}

	/**
	 * Reset the per-request cache (used after saving).
	 */
	public static function flush_cache(): void {
		self::$cache = null;
	}

	/**
	 * Register the setting with the Settings API.
	 */
	public static function register(): void {
		register_setting(
			self::GROUP,
			self::OPTION,
			array(
				'type'              => 'array',
				'sanitize_callback' => array( self::class, 'sanitize' ),
				'default'           => self::defaults(),
				'show_in_rest'      => false,
			)
		);

		// options.php checks manage_options by default; honour the geoblocker_capability filter.
		add_filter( 'option_page_capability_' . self::GROUP, array( Security\Guard::class, 'capability' ) );

		add_action( 'update_option_' . self::OPTION, array( self::class, 'flush_cache' ) );
		add_action( 'add_option_' . self::OPTION, array( self::class, 'flush_cache' ) );
	}

	/**
	 * Tab identifiers that own settings fields.
	 *
	 * @return string[]
	 */
	public static function tabs_with_fields(): array {
		return array_keys( self::TAB_FIELDS );
	}

	/**
	 * Sanitize callback for register_setting().
	 *
	 * Only fields that belong to the submitted tab are updated; all others are
	 * preserved from the stored value.
	 *
	 * @param mixed $input Raw submitted value.
	 * @return array<string,mixed>
	 */
	public static function sanitize( $input ): array {
		$current = self::all();

		if ( ! is_array( $input ) ) {
			return $current;
		}

		// Defence in depth: options.php already checks this capability, but the
		// sanitize callback can also be reached via update_option() elsewhere.
		if ( ! Security\Guard::current_user_can_manage() ) {
			return $current;
		}

		$tab = isset( $input['_tab'] ) ? sanitize_key( $input['_tab'] ) : '';

		// Programmatic full updates (no tab marker) sanitize every known field.
		$fields = isset( self::TAB_FIELDS[ $tab ] ) ? self::TAB_FIELDS[ $tab ] : array_keys( self::defaults() );

		$output = $current;
		foreach ( $fields as $field ) {
			$output[ $field ] = self::sanitize_field( $field, $input, $current );
		}

		// Remove anything that is not a known setting.
		$output = array_intersect_key( $output, self::defaults() );

		self::flush_cache();

		return $output;
	}

	/**
	 * Sanitize a single field.
	 *
	 * @param string              $field   Field key.
	 * @param array<string,mixed> $input   Raw input.
	 * @param array<string,mixed> $current Current stored settings.
	 * @return mixed
	 */
	private static function sanitize_field( string $field, array $input, array $current ) {
		$raw = $input[ $field ] ?? null;

		switch ( $field ) {
			// Booleans (checkbox / toggle: absent means off).
			case 'enabled':
			case 'admin_bypass':
			case 'exclude_admin_login':
			case 'use_cloudflare_country':
			case 'auto_update_db':
			case 'trust_cloudflare':
			case 'logging':
			case 'log_anonymize_ip':
			case 'log_query_strings':
			case 'log_failures':
				return ! empty( $raw ) && '0' !== $raw;

			case 'mode':
				return self::one_of( $raw, array( self::MODE_COUNTRIES, self::MODE_CONTINENTS, self::MODE_BOTH ), self::MODE_COUNTRIES );

			case 'on_failure':
				return self::one_of( $raw, array( 'allow', 'block' ), 'allow' );

			case 'blocked_countries':
			case 'whitelist_countries':
				return self::sanitize_country_codes( $raw );

			case 'blocked_continents':
				$raw = is_array( $raw ) ? array_map( 'strtoupper', array_map( 'sanitize_text_field', $raw ) ) : array();
				return array_values( array_intersect( array_keys( Countries::continent_codes() ), $raw ) );

			case 'action':
				return self::one_of( $raw, array( self::ACTION_PAGE, self::ACTION_REDIRECT, self::ACTION_403, self::ACTION_MESSAGE ), self::ACTION_PAGE );

			case 'redirect_url':
				$url = esc_url_raw( trim( (string) $raw ), array( 'http', 'https' ) );
				if ( '' === $url && 'redirect' === ( $input['action'] ?? '' ) ) {
					add_settings_error( self::OPTION, 'geoblocker_redirect_url', __( 'Please enter a valid redirect URL (http or https). Blocked visitors will receive a 403 response until one is set.', 'geoblocker' ) );
				}
				return $url;

			case 'redirect_status':
				return in_array( (int) $raw, array( 301, 302, 303, 307 ), true ) ? (int) $raw : 302;

			case 'page_title':
				$title = sanitize_text_field( (string) $raw );
				return '' !== $title ? $title : self::defaults()['page_title'];

			case 'page_content':
				// Same rules as post content for users who can edit posts; scripts, forms and event handlers are removed.
				return wp_kses_post( (string) $raw );

			case 'message':
				return sanitize_textarea_field( (string) $raw );

			case 'whitelist_ips':
			case 'trusted_proxies':
				$result = IpUtils::parse_list( is_array( $raw ) ? implode( "\n", $raw ) : (string) $raw );
				if ( ! empty( $result['invalid'] ) ) {
					add_settings_error(
						self::OPTION,
						'geoblocker_' . $field,
						sprintf(
							/* translators: %s: comma separated list of invalid entries. */
							__( 'These entries are not valid IP addresses, CIDR ranges or IP ranges and were ignored: %s', 'geoblocker' ),
							implode( ', ', array_map( 'sanitize_text_field', array_slice( $result['invalid'], 0, 20 ) ) )
						)
					);
				}
				return $result['valid'];

			case 'provider':
				$providers = Geo\GeoLocator::instance()->get_registered_provider_ids();
				return self::one_of( $raw, $providers, 'local' );

			case 'local_db_source':
				return self::one_of( $raw, array( 'dbip', 'maxmind', 'custom' ), 'dbip' );

			case 'maxmind_license_key':
			case 'ipapi_key':
			case 'ipinfo_token':
				// Secret fields: an empty submission keeps the stored secret unless "clear" was ticked.
				if ( ! empty( $input[ $field . '_clear' ] ) ) {
					return '';
				}
				$secret = preg_replace( '/[^A-Za-z0-9_\-]/', '', (string) $raw );
				return '' === $secret ? (string) ( $current[ $field ] ?? '' ) : $secret;

			case 'custom_db_path':
				$path = trim( sanitize_text_field( (string) $raw ) );
				if ( '' === $path ) {
					return '';
				}
				$path = wp_normalize_path( $path );
				if ( ! preg_match( '/\.mmdb$/i', $path ) || false !== strpos( $path, '..' ) ) {
					add_settings_error( self::OPTION, 'geoblocker_custom_db_path', __( 'The custom database path must be an absolute path to a .mmdb file.', 'geoblocker' ) );
					return (string) ( $current['custom_db_path'] ?? '' );
				}
				return $path;

			case 'cache_ttl':
				$ttl = absint( $raw );
				return min( max( $ttl, HOUR_IN_SECONDS ), 30 * DAY_IN_SECONDS );

			case 'proxy_header':
				return self::one_of( $raw, array_keys( self::proxy_header_choices() ), 'x_forwarded_for' );

			case 'proxy_custom_header':
				$header = strtoupper( preg_replace( '/[^A-Za-z0-9_\-]/', '', (string) $raw ) );
				return substr( str_replace( '-', '_', $header ), 0, 64 );

			case 'log_retention':
				$days = absint( $raw );
				return in_array( $days, self::RETENTION_CHOICES, true ) ? $days : 30;
		}

		return self::defaults()[ $field ] ?? null;
	}

	/**
	 * Proxy header choices (key => $_SERVER key).
	 *
	 * @return array<string,string>
	 */
	public static function proxy_header_choices(): array {
		return array(
			'x_forwarded_for'  => 'HTTP_X_FORWARDED_FOR',
			'x_real_ip'        => 'HTTP_X_REAL_IP',
			'true_client_ip'   => 'HTTP_TRUE_CLIENT_IP',
			'fastly_client_ip' => 'HTTP_FASTLY_CLIENT_IP',
			'x_client_ip'      => 'HTTP_X_CLIENT_IP',
			'custom'           => '',
		);
	}

	/**
	 * Return $value if it is in $allowed, otherwise $fallback.
	 *
	 * @param mixed    $value    Raw value.
	 * @param string[] $allowed  Allowed values.
	 * @param string   $fallback Default.
	 */
	private static function one_of( $value, array $allowed, string $fallback ): string {
		$value = is_scalar( $value ) ? sanitize_key( (string) $value ) : '';
		return in_array( $value, $allowed, true ) ? $value : $fallback;
	}

	/**
	 * Sanitize a list of ISO country codes.
	 *
	 * @param mixed $raw Raw value.
	 * @return string[]
	 */
	private static function sanitize_country_codes( $raw ): array {
		if ( is_string( $raw ) ) {
			$raw = explode( ',', $raw );
		}
		if ( ! is_array( $raw ) ) {
			return array();
		}
		$valid = Countries::continent_map();
		$codes = array();
		foreach ( $raw as $code ) {
			$code = strtoupper( sanitize_text_field( (string) $code ) );
			if ( isset( $valid[ $code ] ) ) {
				$codes[ $code ] = $code;
			}
		}
		return array_values( $codes );
	}
}
