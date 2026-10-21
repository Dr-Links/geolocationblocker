<?php
/**
 * Settings → Signalpost Chat.
 *
 * @package SignalpostConnector
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Admin screen: connection, widget settings, tracking/consent, diagnostics.
 * Every action checks the manage_options capability and a nonce.
 */
class Signalpost_Admin {

	const PAGE       = 'signalpost-connector';
	const CAPABILITY = 'manage_options';

	/**
	 * Register hooks.
	 */
	public static function init() {
		add_action( 'admin_menu', array( __CLASS__, 'menu' ) );
		add_action( 'admin_enqueue_scripts', array( __CLASS__, 'assets' ) );
		foreach ( array( 'connect', 'disconnect', 'rotate', 'test', 'save_widget', 'save_tracking' ) as $action ) {
			add_action( 'admin_post_signalpost_' . $action, array( __CLASS__, 'handle_' . $action ) );
		}
		add_filter( 'plugin_action_links_' . plugin_basename( SIGNALPOST_CONNECTOR_FILE ), array( __CLASS__, 'action_links' ) );
	}

	/**
	 * Add the settings page.
	 */
	public static function menu() {
		add_options_page(
			__( 'Signalpost Chat', 'signalpost-connector' ),
			__( 'Signalpost Chat', 'signalpost-connector' ),
			self::CAPABILITY,
			self::PAGE,
			array( __CLASS__, 'render' )
		);
	}

	/**
	 * Settings link on the Plugins screen.
	 *
	 * @param array $links Links.
	 * @return array
	 */
	public static function action_links( $links ) {
		array_unshift( $links, '<a href="' . esc_url( self::url() ) . '">' . esc_html__( 'Settings', 'signalpost-connector' ) . '</a>' );
		return $links;
	}

	/**
	 * Enqueue admin CSS on our page only.
	 *
	 * @param string $hook Hook suffix.
	 */
	public static function assets( $hook ) {
		if ( 'settings_page_' . self::PAGE === $hook ) {
			wp_enqueue_style( 'signalpost-admin', SIGNALPOST_CONNECTOR_URL . 'assets/admin.css', array(), SIGNALPOST_CONNECTOR_VERSION );
		}
	}

	/**
	 * Settings page URL.
	 *
	 * @param array $args Query args.
	 * @return string
	 */
	private static function url( $args = array() ) {
		return add_query_arg( array_merge( array( 'page' => self::PAGE ), $args ), admin_url( 'options-general.php' ) );
	}

	/**
	 * Verify capability and nonce for an admin-post action.
	 *
	 * @param string $action Action name.
	 */
	private static function guard( $action ) {
		if ( ! current_user_can( self::CAPABILITY ) ) {
			wp_die( esc_html__( 'You do not have permission to do this.', 'signalpost-connector' ), 403 );
		}
		check_admin_referer( 'signalpost_' . $action );
	}

	/**
	 * Store a one-time notice for the current user and redirect back.
	 *
	 * @param string $type    success|error.
	 * @param string $message Message (plain text).
	 * @param string $tab     Tab to return to.
	 */
	private static function done( $type, $message, $tab = 'connection' ) {
		set_transient( 'signalpost_notice_' . get_current_user_id(), array( 'type' => $type, 'message' => $message ), 60 );
		wp_safe_redirect( self::url( array( 'tab' => $tab ) ) );
		exit;
	}

	/**
	 * Report a result.
	 *
	 * @param true|WP_Error $result  Result.
	 * @param string        $success Success message.
	 * @param string        $tab     Tab.
	 */
	private static function finish( $result, $success, $tab = 'connection' ) {
		if ( is_wp_error( $result ) ) {
			$message = $result->get_error_message();
			$data    = $result->get_error_data();
			if ( is_array( $data ) && isset( $data['fields'] ) ) {
				$message .= ' ' . implode( ' ', array_map( 'sanitize_text_field', (array) $data['fields'] ) );
			}
			self::done( 'error', $message, $tab );
		}
		self::done( 'success', $success, $tab );
	}

	/** Connect with a pairing code. */
	public static function handle_connect() {
		self::guard( 'connect' );
		$url  = isset( $_POST['central_url'] ) ? sanitize_text_field( wp_unslash( $_POST['central_url'] ) ) : '';
		$code = isset( $_POST['pairing_code'] ) ? sanitize_text_field( wp_unslash( $_POST['pairing_code'] ) ) : '';
		self::finish( Signalpost_Connection::pair( $url, $code ), __( 'Connected to Signalpost.', 'signalpost-connector' ) );
	}

	/** Disconnect (revokes the credential; central history is kept). */
	public static function handle_disconnect() {
		self::guard( 'disconnect' );
		Signalpost_Connection::disconnect();
		self::done( 'success', __( 'Disconnected. The credential was revoked. Conversations remain on the Signalpost server.', 'signalpost-connector' ) );
	}

	/** Rotate the credential now. */
	public static function handle_rotate() {
		self::guard( 'rotate' );
		self::finish( Signalpost_Connection::rotate(), __( 'Credential rotated.', 'signalpost-connector' ) );
	}

	/** Test the connection and refresh configuration. */
	public static function handle_test() {
		self::guard( 'test' );
		self::finish( Signalpost_Connection::refresh(), __( 'Connection OK. Settings refreshed.', 'signalpost-connector' ), 'diagnostics' );
	}

	/** Save widget settings to the central server. */
	public static function handle_save_widget() {
		self::guard( 'save_widget' );
		// phpcs:disable WordPress.Security.NonceVerification.Missing -- verified in guard().
		$text   = static function ( $key, $max ) {
			return isset( $_POST[ $key ] ) ? mb_substr( sanitize_text_field( wp_unslash( $_POST[ $key ] ) ), 0, $max ) : '';
		};
		$area   = static function ( $key, $max ) {
			return isset( $_POST[ $key ] ) ? mb_substr( sanitize_textarea_field( wp_unslash( $_POST[ $key ] ) ), 0, $max ) : '';
		};
		$choice = static function ( $key, $allowed, $fallback ) {
			$v = isset( $_POST[ $key ] ) ? sanitize_key( wp_unslash( $_POST[ $key ] ) ) : '';
			return in_array( $v, $allowed, true ) ? $v : $fallback;
		};
		$color  = isset( $_POST['primary_color'] ) ? sanitize_hex_color( wp_unslash( $_POST['primary_color'] ) ) : '';
		$widget = array(
			'enabled'         => ! empty( $_POST['enabled'] ),
			'brand_name'      => $text( 'brand_name', 40 ),
			'primary_color'   => $color ? $color : '#155254',
			'position'        => $choice( 'position', array( 'left', 'right' ), 'right' ),
			'offset_px'       => isset( $_POST['offset_px'] ) ? absint( $_POST['offset_px'] ) : 20,
			'launcher_label'  => $text( 'launcher_label', 30 ),
			'greeting_title'  => $text( 'greeting_title', 60 ),
			'welcome_message' => $area( 'welcome_message', 300 ),
			'prechat_name'    => $choice( 'prechat_name', array( 'off', 'optional', 'required' ), 'off' ),
			'prechat_email'   => $choice( 'prechat_email', array( 'off', 'optional', 'required' ), 'off' ),
			'prechat_phone'   => $choice( 'prechat_phone', array( 'off', 'optional', 'required' ), 'off' ),
			'prechat_notice'  => $area( 'prechat_notice', 300 ),
			'hidden_paths'    => self::paths_from_textarea( $area( 'hidden_paths', 10000 ) ),
		);
		// phpcs:enable
		self::finish( Signalpost_Connection::push_settings( array( 'widget' => $widget ) ), __( 'Widget settings saved.', 'signalpost-connector' ), 'widget' );
	}

	/** Save tracking exclusions and consent integration. */
	public static function handle_save_tracking() {
		self::guard( 'save_tracking' );
		// phpcs:disable WordPress.Security.NonceVerification.Missing -- verified in guard().
		$source   = isset( $_POST['consent_source'] ) ? sanitize_key( wp_unslash( $_POST['consent_source'] ) ) : 'widget';
		$excluded = isset( $_POST['excluded_paths'] ) ? sanitize_textarea_field( wp_unslash( $_POST['excluded_paths'] ) ) : '';
		// phpcs:enable
		$tracking = array(
			'consent_source' => in_array( $source, array( 'widget', 'wp_consent_api', 'custom' ), true ) ? $source : 'widget',
			'excluded_paths' => self::paths_from_textarea( $excluded ),
		);
		self::finish( Signalpost_Connection::push_settings( array( 'tracking' => $tracking ) ), __( 'Tracking settings saved.', 'signalpost-connector' ), 'tracking' );
	}

	/**
	 * Split a textarea into path prefixes.
	 *
	 * @param string $text Text.
	 * @return array
	 */
	private static function paths_from_textarea( $text ) {
		$lines = preg_split( '/[\r\n]+/', (string) $text );
		$out   = array();
		foreach ( (array) $lines as $line ) {
			$line = trim( $line );
			if ( '' !== $line ) {
				$out[] = $line;
			}
		}
		return array_slice( $out, 0, 50 );
	}

	/**
	 * Render the settings page.
	 */
	public static function render() {
		if ( ! current_user_can( self::CAPABILITY ) ) {
			return;
		}
		$conn   = Signalpost_Store::connection();
		$config = Signalpost_Store::config();
		// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- tab selection only.
		$tab  = isset( $_GET['tab'] ) ? sanitize_key( wp_unslash( $_GET['tab'] ) ) : 'connection';
		$tabs = array(
			'connection'  => __( 'Connection', 'signalpost-connector' ),
			'widget'      => __( 'Widget', 'signalpost-connector' ),
			'tracking'    => __( 'Tracking & consent', 'signalpost-connector' ),
			'diagnostics' => __( 'Diagnostics', 'signalpost-connector' ),
		);
		if ( ! isset( $tabs[ $tab ] ) ) {
			$tab = 'connection';
		}
		$notice = get_transient( 'signalpost_notice_' . get_current_user_id() );
		if ( $notice ) {
			delete_transient( 'signalpost_notice_' . get_current_user_id() );
		}
		$connected = Signalpost_Connection::is_connected();
		?>
		<div class="wrap signalpost-admin">
			<h1><?php esc_html_e( 'Signalpost Chat', 'signalpost-connector' ); ?></h1>
			<?php if ( is_array( $notice ) ) : ?>
				<div class="notice notice-<?php echo 'error' === $notice['type'] ? 'error' : 'success'; ?> is-dismissible"><p><?php echo esc_html( $notice['message'] ); ?></p></div>
			<?php endif; ?>
			<nav class="nav-tab-wrapper">
				<?php foreach ( $tabs as $key => $label ) : ?>
					<a href="<?php echo esc_url( self::url( array( 'tab' => $key ) ) ); ?>" class="nav-tab <?php echo $tab === $key ? 'nav-tab-active' : ''; ?>"><?php echo esc_html( $label ); ?></a>
				<?php endforeach; ?>
			</nav>
			<div class="signalpost-panel">
			<?php
			switch ( $tab ) {
				case 'widget':
					self::render_widget( $connected, $config );
					break;
				case 'tracking':
					self::render_tracking( $connected, $config );
					break;
				case 'diagnostics':
					self::render_diagnostics( $conn, $config );
					break;
				default:
					self::render_connection( $conn, $connected );
			}
			?>
			</div>
		</div>
		<?php
	}

	/**
	 * Hidden fields for an admin-post form.
	 *
	 * @param string $action Action.
	 */
	private static function form_fields( $action ) {
		echo '<input type="hidden" name="action" value="' . esc_attr( 'signalpost_' . $action ) . '">';
		wp_nonce_field( 'signalpost_' . $action );
	}

	/**
	 * Connection tab.
	 *
	 * @param array $conn      Connection.
	 * @param bool  $connected Connected.
	 */
	private static function render_connection( $conn, $connected ) {
		$status_labels = array(
			'connected'    => __( 'Connected', 'signalpost-connector' ),
			'revoked'      => __( 'Credential rejected — reconnect with a new pairing code', 'signalpost-connector' ),
			'disconnected' => __( 'Not connected', 'signalpost-connector' ),
		);
		$status        = isset( $status_labels[ $conn['status'] ] ) ? $conn['status'] : 'disconnected';
		?>
		<p><span class="signalpost-status signalpost-status-<?php echo esc_attr( $status ); ?>"><?php echo esc_html( $status_labels[ $status ] ); ?></span></p>
		<?php if ( $connected ) : ?>
			<table class="form-table" role="presentation">
				<tr><th scope="row"><?php esc_html_e( 'Signalpost server', 'signalpost-connector' ); ?></th><td><code><?php echo esc_html( $conn['central_url'] ); ?></code></td></tr>
				<tr><th scope="row"><?php esc_html_e( 'Website', 'signalpost-connector' ); ?></th><td><?php echo esc_html( $conn['site_name'] ); ?></td></tr>
				<tr><th scope="row"><?php esc_html_e( 'Credential', 'signalpost-connector' ); ?></th><td><code>spk_<?php echo esc_html( $conn['key_prefix'] ); ?>…</code> <span class="description"><?php esc_html_e( '(only the non-secret prefix is shown)', 'signalpost-connector' ); ?></span></td></tr>
				<tr><th scope="row"><?php esc_html_e( 'Last successful contact', 'signalpost-connector' ); ?></th><td><?php echo $conn['last_success_at'] ? esc_html( wp_date( get_option( 'date_format' ) . ' ' . get_option( 'time_format' ), (int) $conn['last_success_at'] ) ) : '—'; ?></td></tr>
			</table>
			<div class="signalpost-actions">
				<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>"><?php self::form_fields( 'test' ); ?><?php submit_button( __( 'Test connection', 'signalpost-connector' ), 'secondary', 'submit', false ); ?></form>
				<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>"><?php self::form_fields( 'rotate' ); ?><?php submit_button( __( 'Rotate credential', 'signalpost-connector' ), 'secondary', 'submit', false ); ?></form>
				<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" onsubmit="return confirm('<?php echo esc_js( __( 'Disconnect this site? The chat widget will disappear. Conversations stay on the Signalpost server.', 'signalpost-connector' ) ); ?>');"><?php self::form_fields( 'disconnect' ); ?><?php submit_button( __( 'Disconnect', 'signalpost-connector' ), 'delete', 'submit', false ); ?></form>
			</div>
		<?php else : ?>
			<ol class="signalpost-steps">
				<li><?php esc_html_e( 'In your Signalpost dashboard, add this website under “Websites & widget” using this exact address:', 'signalpost-connector' ); ?> <code><?php echo esc_html( untrailingslashit( home_url() ) ); ?></code></li>
				<li><?php esc_html_e( 'Click “Generate pairing code”.', 'signalpost-connector' ); ?></li>
				<li><?php esc_html_e( 'Enter the server address and the code below. The code works once and expires after 30 minutes.', 'signalpost-connector' ); ?></li>
			</ol>
			<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
				<?php self::form_fields( 'connect' ); ?>
				<table class="form-table" role="presentation">
					<tr><th scope="row"><label for="sp-central"><?php esc_html_e( 'Signalpost server address', 'signalpost-connector' ); ?></label></th>
						<td><input id="sp-central" name="central_url" type="url" class="regular-text" required placeholder="https://chat.example.com" value="<?php echo esc_attr( $conn['central_url'] ); ?>"></td></tr>
					<tr><th scope="row"><label for="sp-code"><?php esc_html_e( 'Pairing code', 'signalpost-connector' ); ?></label></th>
						<td><input id="sp-code" name="pairing_code" type="text" class="regular-text" required autocomplete="off" placeholder="ABCD-EFGH-JKLM-NPQR" pattern="[A-Za-z0-9\- ]{16,24}"></td></tr>
				</table>
				<?php submit_button( __( 'Connect', 'signalpost-connector' ) ); ?>
			</form>
		<?php endif; ?>
		<p class="description"><?php esc_html_e( 'Deactivating or deleting this plugin never deletes conversations stored on the Signalpost server. Delete central data from the Signalpost dashboard.', 'signalpost-connector' ); ?></p>
		<?php
	}

	/**
	 * Widget tab.
	 *
	 * @param bool  $connected Connected.
	 * @param array $config    Cached config.
	 */
	private static function render_widget( $connected, $config ) {
		if ( ! $connected || empty( $config['widget'] ) ) {
			echo '<p>' . esc_html__( 'Connect this site first.', 'signalpost-connector' ) . '</p>';
			return;
		}
		$w      = $config['widget'];
		$select = static function ( $name, $value, $options ) {
			echo '<select id="sp-' . esc_attr( $name ) . '" name="' . esc_attr( $name ) . '">';
			foreach ( $options as $key => $label ) {
				echo '<option value="' . esc_attr( $key ) . '" ' . selected( $value, $key, false ) . '>' . esc_html( $label ) . '</option>';
			}
			echo '</select>';
		};
		$asks   = array(
			'off'      => __( 'Don\'t ask', 'signalpost-connector' ),
			'optional' => __( 'Optional', 'signalpost-connector' ),
			'required' => __( 'Required', 'signalpost-connector' ),
		);
		?>
		<p class="description"><?php esc_html_e( 'These settings are stored on the Signalpost server and are also editable in the dashboard.', 'signalpost-connector' ); ?></p>
		<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
			<?php self::form_fields( 'save_widget' ); ?>
			<table class="form-table" role="presentation">
				<tr><th scope="row"><?php esc_html_e( 'Chat', 'signalpost-connector' ); ?></th><td><label><input type="checkbox" name="enabled" value="1" <?php checked( ! empty( $w['enabled'] ) ); ?>> <?php esc_html_e( 'Show the chat widget', 'signalpost-connector' ); ?></label></td></tr>
				<tr><th scope="row"><label for="sp-brand_name"><?php esc_html_e( 'Brand name', 'signalpost-connector' ); ?></label></th><td><input id="sp-brand_name" name="brand_name" class="regular-text" maxlength="40" value="<?php echo esc_attr( $w['brand_name'] ); ?>"></td></tr>
				<tr><th scope="row"><label for="sp-primary_color"><?php esc_html_e( 'Primary colour', 'signalpost-connector' ); ?></label></th><td><input id="sp-primary_color" name="primary_color" type="color" value="<?php echo esc_attr( $w['primary_color'] ); ?>"></td></tr>
				<tr><th scope="row"><label for="sp-position"><?php esc_html_e( 'Position', 'signalpost-connector' ); ?></label></th><td><?php $select( 'position', $w['position'], array( 'right' => __( 'Bottom right', 'signalpost-connector' ), 'left' => __( 'Bottom left', 'signalpost-connector' ) ) ); ?></td></tr>
				<tr><th scope="row"><label for="sp-offset_px"><?php esc_html_e( 'Distance from edge (px)', 'signalpost-connector' ); ?></label></th><td><input id="sp-offset_px" name="offset_px" type="number" min="0" max="80" value="<?php echo esc_attr( (string) $w['offset_px'] ); ?>"></td></tr>
				<tr><th scope="row"><label for="sp-launcher_label"><?php esc_html_e( 'Launcher label', 'signalpost-connector' ); ?></label></th><td><input id="sp-launcher_label" name="launcher_label" class="regular-text" maxlength="30" value="<?php echo esc_attr( $w['launcher_label'] ); ?>"></td></tr>
				<tr><th scope="row"><label for="sp-greeting_title"><?php esc_html_e( 'Greeting', 'signalpost-connector' ); ?></label></th><td><input id="sp-greeting_title" name="greeting_title" class="regular-text" maxlength="60" value="<?php echo esc_attr( $w['greeting_title'] ); ?>"></td></tr>
				<tr><th scope="row"><label for="sp-welcome_message"><?php esc_html_e( 'Welcome message', 'signalpost-connector' ); ?></label></th><td><textarea id="sp-welcome_message" name="welcome_message" rows="3" class="large-text" maxlength="300"><?php echo esc_textarea( $w['welcome_message'] ); ?></textarea></td></tr>
				<tr><th scope="row"><?php esc_html_e( 'Pre-chat form', 'signalpost-connector' ); ?></th><td>
					<p><label for="sp-prechat_name"><?php esc_html_e( 'Name', 'signalpost-connector' ); ?></label> <?php $select( 'prechat_name', $w['prechat_name'], $asks ); ?>
					<label for="sp-prechat_email"><?php esc_html_e( 'Email', 'signalpost-connector' ); ?></label> <?php $select( 'prechat_email', $w['prechat_email'], $asks ); ?>
					<label for="sp-prechat_phone"><?php esc_html_e( 'Phone', 'signalpost-connector' ); ?></label> <?php $select( 'prechat_phone', $w['prechat_phone'], $asks ); ?></p>
					<p><label for="sp-prechat_notice"><?php esc_html_e( 'Privacy notice on the form', 'signalpost-connector' ); ?></label><br><textarea id="sp-prechat_notice" name="prechat_notice" rows="2" class="large-text" maxlength="300"><?php echo esc_textarea( $w['prechat_notice'] ); ?></textarea></p>
				</td></tr>
				<tr><th scope="row"><label for="sp-hidden_paths"><?php esc_html_e( 'Hide widget on paths', 'signalpost-connector' ); ?></label></th><td><textarea id="sp-hidden_paths" name="hidden_paths" rows="4" class="large-text code"><?php echo esc_textarea( implode( "\n", (array) $w['hidden_paths'] ) ); ?></textarea><p class="description"><?php esc_html_e( 'One path per line, e.g. /checkout. Prefix match.', 'signalpost-connector' ); ?></p></td></tr>
			</table>
			<?php submit_button( __( 'Save widget settings', 'signalpost-connector' ) ); ?>
		</form>
		<?php
	}

	/**
	 * Tracking tab.
	 *
	 * @param bool  $connected Connected.
	 * @param array $config    Cached config.
	 */
	private static function render_tracking( $connected, $config ) {
		if ( ! $connected || empty( $config['tracking'] ) ) {
			echo '<p>' . esc_html__( 'Connect this site first.', 'signalpost-connector' ) . '</p>';
			return;
		}
		$t           = $config['tracking'];
		$has_consent = function_exists( 'wp_has_consent' );
		?>
		<table class="form-table" role="presentation">
			<tr><th scope="row"><?php esc_html_e( 'Active tracking mode', 'signalpost-connector' ); ?></th><td>
				<strong><?php echo ! empty( $t['analytics_enabled'] ) ? esc_html__( 'Optional analytics enabled (requires visitor permission)', 'signalpost-connector' ) : esc_html__( 'Essential chat only', 'signalpost-connector' ); ?></strong>
				<p class="description"><?php esc_html_e( 'The analytics policy, legal basis and retention are managed in the Signalpost dashboard so they apply consistently.', 'signalpost-connector' ); ?></p>
				<?php if ( ! empty( $t['analytics_enabled'] ) ) : ?>
					<p class="description"><?php echo esc_html( sprintf( /* translators: %s: legal basis */ __( 'Legal basis: %s', 'signalpost-connector' ), 'consent' === $t['legal_basis'] ? __( 'consent (opt-in)', 'signalpost-connector' ) : __( 'other documented basis (visitors can object)', 'signalpost-connector' ) ) ); ?></p>
				<?php endif; ?>
			</td></tr>
		</table>
		<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
			<?php self::form_fields( 'save_tracking' ); ?>
			<table class="form-table" role="presentation">
				<tr><th scope="row"><label for="sp-consent_source"><?php esc_html_e( 'Consent signal', 'signalpost-connector' ); ?></label></th><td>
					<select id="sp-consent_source" name="consent_source">
						<option value="widget" <?php selected( $t['consent_source'], 'widget' ); ?>><?php esc_html_e( 'Signalpost widget asks the visitor', 'signalpost-connector' ); ?></option>
						<option value="wp_consent_api" <?php selected( $t['consent_source'], 'wp_consent_api' ); ?>><?php esc_html_e( 'WP Consent API (your cookie banner, “statistics” category)', 'signalpost-connector' ); ?></option>
						<option value="custom" <?php selected( $t['consent_source'], 'custom' ); ?>><?php esc_html_e( 'Custom JavaScript call', 'signalpost-connector' ); ?></option>
					</select>
					<p class="description"><?php echo $has_consent ? esc_html__( 'WP Consent API detected.', 'signalpost-connector' ) : esc_html__( 'WP Consent API not detected. With that option selected, analytics stay off until a compatible consent plugin is active.', 'signalpost-connector' ); ?></p>
					<p class="description"><?php esc_html_e( 'Custom: call window.Signalpost.setAnalyticsConsent(true|false) from your consent tool.', 'signalpost-connector' ); ?></p>
				</td></tr>
				<tr><th scope="row"><label for="sp-excluded_paths"><?php esc_html_e( 'Never track these paths', 'signalpost-connector' ); ?></label></th><td>
					<textarea id="sp-excluded_paths" name="excluded_paths" rows="6" class="large-text code"><?php echo esc_textarea( implode( "\n", (array) $t['excluded_paths'] ) ); ?></textarea>
					<p class="description"><?php esc_html_e( 'One per line. Keep checkout, account, payment and login pages excluded. Query strings and fragments are never recorded.', 'signalpost-connector' ); ?></p>
				</td></tr>
			</table>
			<?php submit_button( __( 'Save tracking settings', 'signalpost-connector' ) ); ?>
		</form>
		<?php
	}

	/**
	 * Diagnostics tab. Shows no secrets.
	 *
	 * @param array $conn   Connection.
	 * @param array $config Config.
	 */
	private static function render_diagnostics( $conn, $config ) {
		$rows = array(
			__( 'Plugin version', 'signalpost-connector' )        => SIGNALPOST_CONNECTOR_VERSION,
			__( 'WordPress version', 'signalpost-connector' )     => get_bloginfo( 'version' ),
			__( 'PHP version', 'signalpost-connector' )           => PHP_VERSION,
			__( 'Site address', 'signalpost-connector' )          => untrailingslashit( home_url() ),
			__( 'Site uses HTTPS', 'signalpost-connector' )       => is_ssl() ? __( 'Yes', 'signalpost-connector' ) : __( 'No', 'signalpost-connector' ),
			__( 'Connection status', 'signalpost-connector' )     => $conn['status'],
			__( 'Signalpost server', 'signalpost-connector' )     => $conn['central_url'] ? $conn['central_url'] : '—',
			__( 'Credential prefix', 'signalpost-connector' )     => $conn['key_prefix'] ? 'spk_' . $conn['key_prefix'] . '…' : '—',
			__( 'Credential source', 'signalpost-connector' )     => defined( 'SIGNALPOST_CREDENTIAL' ) ? 'wp-config.php' : __( 'database option (not autoloaded)', 'signalpost-connector' ),
			__( 'Last error', 'signalpost-connector' )            => $conn['last_error'] ? $conn['last_error'] . ' (' . wp_date( 'Y-m-d H:i', (int) $conn['last_error_at'] ) . ')' : '—',
			__( 'Config cached', 'signalpost-connector' )         => ! empty( $config['fetched_at'] ) ? human_time_diff( (int) $config['fetched_at'] ) . ' ' . __( 'ago', 'signalpost-connector' ) : '—',
			__( 'Next background refresh', 'signalpost-connector' ) => wp_next_scheduled( Signalpost_Connection::CRON_HOOK ) ? wp_date( 'Y-m-d H:i', (int) wp_next_scheduled( Signalpost_Connection::CRON_HOOK ) ) : '—',
			__( 'WP-Cron disabled', 'signalpost-connector' )      => ( defined( 'DISABLE_WP_CRON' ) && DISABLE_WP_CRON ) ? __( 'Yes — ensure a system cron calls wp-cron.php', 'signalpost-connector' ) : __( 'No', 'signalpost-connector' ),
			__( 'WP Consent API', 'signalpost-connector' )        => function_exists( 'wp_has_consent' ) ? __( 'Available', 'signalpost-connector' ) : __( 'Not installed', 'signalpost-connector' ),
		);
		?>
		<table class="widefat striped signalpost-diag"><tbody>
			<?php foreach ( $rows as $label => $value ) : ?>
				<tr><th scope="row"><?php echo esc_html( $label ); ?></th><td><?php echo esc_html( (string) $value ); ?></td></tr>
			<?php endforeach; ?>
		</tbody></table>
		<?php if ( Signalpost_Connection::is_connected() ) : ?>
			<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>"><?php self::form_fields( 'test' ); ?><?php submit_button( __( 'Test connection now', 'signalpost-connector' ), 'secondary' ); ?></form>
		<?php endif; ?>
		<?php
	}
}
