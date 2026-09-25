<?php
/**
 * Admin menu, settings screen and assets.
 *
 * @package GeoBlocker
 */

namespace GeoBlocker\Admin;

use GeoBlocker\Geo\DatabaseUpdater;
use GeoBlocker\Geo\GeoLocator;
use GeoBlocker\Security\Guard;
use GeoBlocker\Settings;

defined( 'ABSPATH' ) || exit;

/**
 * The GeoBlocker admin screen.
 */
final class AdminPage {

	public const SLUG = 'geoblocker';

	/**
	 * Screen hook suffix.
	 *
	 * @var string
	 */
	private string $hook = '';

	/**
	 * Register hooks.
	 */
	public function register(): void {
		add_action( 'admin_menu', array( $this, 'add_menu' ) );
		add_action( 'admin_enqueue_scripts', array( $this, 'enqueue' ) );
		add_action( 'admin_notices', array( $this, 'global_notices' ) );
	}

	/**
	 * Tabs: slug => label.
	 *
	 * @return array<string,string>
	 */
	public static function tabs(): array {
		return array(
			'rules'       => __( 'Blocking Rules', 'geoblocker' ),
			'action'      => __( 'Block Action', 'geoblocker' ),
			'whitelist'   => __( 'Whitelist', 'geoblocker' ),
			'geolocation' => __( 'Geolocation', 'geoblocker' ),
			'proxy'       => __( 'Proxy & CDN', 'geoblocker' ),
			'tools'       => __( 'Test Tool', 'geoblocker' ),
			'logs'        => __( 'Logs', 'geoblocker' ),
			'privacy'     => __( 'Privacy', 'geoblocker' ),
		);
	}

	/**
	 * URL of a tab.
	 *
	 * @param string $tab  Tab slug.
	 * @param array  $args Extra query args.
	 */
	public static function url( string $tab = 'rules', array $args = array() ): string {
		return add_query_arg(
			array_merge(
				array(
					'page' => self::SLUG,
					'tab'  => $tab,
				),
				$args
			),
			admin_url( 'admin.php' )
		);
	}

	/**
	 * Current tab.
	 */
	public static function current_tab(): string {
		$tab = isset( $_GET['tab'] ) ? sanitize_key( wp_unslash( $_GET['tab'] ) ) : 'rules'; // phpcs:ignore WordPress.Security.NonceVerification.Recommended -- navigation only.
		return array_key_exists( $tab, self::tabs() ) ? $tab : 'rules';
	}

	/**
	 * Add the top-level menu.
	 */
	public function add_menu(): void {
		$this->hook = (string) add_menu_page(
			__( 'GeoBlocker', 'geoblocker' ),
			__( 'GeoBlocker', 'geoblocker' ),
			Guard::capability(),
			self::SLUG,
			array( $this, 'render' ),
			'dashicons-shield-alt',
			81
		);
	}

	/**
	 * Enqueue assets only on the GeoBlocker screen.
	 *
	 * @param string $hook_suffix Current admin page.
	 */
	public function enqueue( $hook_suffix ): void {
		if ( '' === $this->hook || $hook_suffix !== $this->hook ) {
			return;
		}

		$css_ver = GEOBLOCKER_VERSION . '-' . (string) filemtime( GEOBLOCKER_DIR . 'assets/css/admin.css' );
		$js_ver  = GEOBLOCKER_VERSION . '-' . (string) filemtime( GEOBLOCKER_DIR . 'assets/js/admin.js' );

		wp_enqueue_style( 'geoblocker-admin', GEOBLOCKER_URL . 'assets/css/admin.css', array(), $css_ver );
		wp_enqueue_script( 'geoblocker-admin', GEOBLOCKER_URL . 'assets/js/admin.js', array(), $js_ver, true );

		// Only non-sensitive data is exposed to JavaScript (never API keys).
		wp_add_inline_script(
			'geoblocker-admin',
			'window.geoblockerAdmin = ' . wp_json_encode(
				array(
					'ajaxUrl' => admin_url( 'admin-ajax.php' ),
					'nonce'   => wp_create_nonce( Ajax::NONCE ),
					'i18n'    => array(
						'searchCountries' => __( 'Search countries…', 'geoblocker' ),
						'noResults'       => __( 'No matching countries', 'geoblocker' ),
						'remove'          => __( 'Remove', 'geoblocker' ),
						'noneSelected'    => __( 'No countries selected.', 'geoblocker' ),
						'clearAll'        => __( 'Clear all', 'geoblocker' ),
						'testing'         => __( 'Testing…', 'geoblocker' ),
						'requestFailed'   => __( 'The request failed. Please try again.', 'geoblocker' ),
						'confirmClear'    => __( 'Delete all log entries? This cannot be undone.', 'geoblocker' ),
						'blocked'         => __( 'Blocked', 'geoblocker' ),
						'allowed'         => __( 'Allowed', 'geoblocker' ),
						'yes'             => __( 'Yes', 'geoblocker' ),
						'no'              => __( 'No', 'geoblocker' ),
						'ip'              => __( 'IP address', 'geoblocker' ),
						'country'         => __( 'Detected country', 'geoblocker' ),
						'continent'       => __( 'Detected continent', 'geoblocker' ),
						'result'          => __( 'Result', 'geoblocker' ),
						'reason'          => __( 'Reason', 'geoblocker' ),
						'whitelisted'     => __( 'Whitelisted', 'geoblocker' ),
						'provider'        => __( 'Provider', 'geoblocker' ),
						'geoError'        => __( 'Lookup error', 'geoblocker' ),
						'cached'          => __( 'cached', 'geoblocker' ),
						'selected'        => __( 'selected', 'geoblocker' ),
					),
				)
			) . ';',
			'before'
		);

		if ( 'action' === self::current_tab() ) {
			wp_enqueue_editor();
		}
	}

	/**
	 * Warnings shown on the Plugins screen and the GeoBlocker screen.
	 */
	public function global_notices(): void {
		if ( ! Guard::current_user_can_manage() ) {
			return;
		}
		$screen = get_current_screen();
		if ( ! $screen || ! in_array( $screen->id, array( 'plugins', $this->hook ), true ) ) {
			return;
		}

		$settings = Settings::all();
		if ( empty( $settings['enabled'] ) ) {
			return;
		}

		$provider = GeoLocator::instance()->get_active_provider();
		if ( ! $provider->is_available() ) {
			echo '<div class="notice notice-warning"><p><strong>' . esc_html__( 'GeoBlocker:', 'geoblocker' ) . '</strong> ';
			if ( 'local' === $provider->get_id() ) {
				esc_html_e( 'Blocking is enabled but no GeoIP database is installed yet, so visitor locations cannot be detected.', 'geoblocker' );
			} else {
				esc_html_e( 'Blocking is enabled but the selected geolocation provider is not configured.', 'geoblocker' );
			}
			echo ' <a href="' . esc_url( self::url( 'geolocation' ) ) . '">' . esc_html__( 'Configure geolocation', 'geoblocker' ) . '</a></p></div>';
		}
	}

	/**
	 * Render the page.
	 */
	public function render(): void {
		if ( ! Guard::current_user_can_manage() ) {
			wp_die( esc_html__( 'You do not have permission to access this page.', 'geoblocker' ) );
		}

		$tab      = self::current_tab();
		$settings = Settings::all();
		$view     = GEOBLOCKER_DIR . 'includes/Admin/views/tab-' . $tab . '.php';

		include GEOBLOCKER_DIR . 'includes/Admin/views/header.php';

		if ( is_readable( $view ) ) {
			include $view;
		}

		echo '</div>'; // .wrap opened in header.php.
	}

	/**
	 * Output the opening of a settings form for a tab.
	 *
	 * @param string $tab Tab slug.
	 */
	public static function form_open( string $tab ): void {
		echo '<form method="post" action="' . esc_url( admin_url( 'options.php' ) ) . '" class="geoblocker-form" novalidate>';
		settings_fields( Settings::GROUP );
		echo '<input type="hidden" name="' . esc_attr( Settings::OPTION ) . '[_tab]" value="' . esc_attr( $tab ) . '">';
	}

	/**
	 * Output the save button and close the form.
	 */
	public static function form_close(): void {
		echo '<div class="geoblocker-actions">';
		submit_button( __( 'Save Settings', 'geoblocker' ), 'primary large', 'submit', false );
		echo '</div></form>';
	}

	/**
	 * Field name helper.
	 *
	 * @param string $key Setting key.
	 */
	public static function name( string $key ): string {
		return Settings::OPTION . '[' . $key . ']';
	}

	/**
	 * Toggle switch markup.
	 *
	 * @param string $key         Setting key.
	 * @param bool   $checked     State.
	 * @param string $label       Label.
	 * @param string $description Help text.
	 */
	public static function toggle( string $key, bool $checked, string $label, string $description = '' ): void {
		$id = 'geoblocker-' . str_replace( '_', '-', $key );
		?>
		<div class="geoblocker-toggle-row">
			<label class="geoblocker-toggle" for="<?php echo esc_attr( $id ); ?>">
				<input type="checkbox" id="<?php echo esc_attr( $id ); ?>" name="<?php echo esc_attr( self::name( $key ) ); ?>" value="1" <?php checked( $checked ); ?>>
				<span class="geoblocker-toggle__track" aria-hidden="true"><span class="geoblocker-toggle__thumb"></span></span>
				<span class="geoblocker-toggle__label"><?php echo esc_html( $label ); ?></span>
			</label>
			<?php if ( '' !== $description ) : ?>
				<p class="description"><?php echo esc_html( $description ); ?></p>
			<?php endif; ?>
		</div>
		<?php
	}

	/**
	 * Searchable multi-country selector (progressively enhanced <select multiple>).
	 *
	 * @param string   $key      Setting key.
	 * @param string[] $selected Selected codes.
	 * @param string   $label    Accessible label.
	 */
	public static function country_select( string $key, array $selected, string $label ): void {
		$id = 'geoblocker-' . str_replace( '_', '-', $key );
		?>
		<div class="geoblocker-country-picker" data-geoblocker-country-picker>
			<label class="screen-reader-text" for="<?php echo esc_attr( $id ); ?>"><?php echo esc_html( $label ); ?></label>
			<select id="<?php echo esc_attr( $id ); ?>" name="<?php echo esc_attr( self::name( $key ) ); ?>[]" multiple size="10" class="geoblocker-country-select">
				<?php foreach ( \GeoBlocker\Geo\Countries::names() as $code => $name ) : ?>
					<option value="<?php echo esc_attr( $code ); ?>" <?php selected( in_array( $code, $selected, true ) ); ?>><?php echo esc_html( $name . ' (' . $code . ')' ); ?></option>
				<?php endforeach; ?>
			</select>
		</div>
		<?php
	}

	/**
	 * Human readable database status for the header and geolocation tab.
	 *
	 * @return array{ok:bool,label:string}
	 */
	public static function provider_status(): array {
		$provider = GeoLocator::instance()->get_active_provider();
		if ( ! $provider->is_available() ) {
			return array(
				'ok'    => false,
				'label' => 'local' === $provider->get_id() ? __( 'No GeoIP database installed', 'geoblocker' ) : __( 'Provider not configured', 'geoblocker' ),
			);
		}
		if ( 'local' === $provider->get_id() ) {
			$info = DatabaseUpdater::info();
			$date = ! empty( $info['updated'] ) && 'custom' !== Settings::get( 'local_db_source' ) ? wp_date( get_option( 'date_format' ), (int) $info['updated'] ) : '';
			return array(
				'ok'    => true,
				/* translators: %s: date. */
				'label' => '' !== $date ? sprintf( __( 'Local database (updated %s)', 'geoblocker' ), $date ) : __( 'Local database', 'geoblocker' ),
			);
		}
		return array(
			'ok'    => true,
			'label' => $provider->get_label(),
		);
	}
}
