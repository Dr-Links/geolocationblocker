<?php
/**
 * Tab: proxy / CDN / Cloudflare.
 *
 * @package GeoBlocker
 *
 * @var array $settings Settings.
 */

use GeoBlocker\Admin\Actions;
use GeoBlocker\Admin\AdminPage;
use GeoBlocker\Ip\CloudflareRanges;
use GeoBlocker\Ip\IpDetector;
use GeoBlocker\Settings;

defined( 'ABSPATH' ) || exit;

$geoblocker_details    = IpDetector::instance()->details();
$geoblocker_headers    = array(
	'REMOTE_ADDR'           => 'REMOTE_ADDR',
	'HTTP_CF_CONNECTING_IP' => 'CF-Connecting-IP',
	'HTTP_CF_IPCOUNTRY'     => 'CF-IPCountry',
	'HTTP_X_FORWARDED_FOR'  => 'X-Forwarded-For',
	'HTTP_X_REAL_IP'        => 'X-Real-IP',
	'HTTP_TRUE_CLIENT_IP'   => 'True-Client-IP',
	'HTTP_FASTLY_CLIENT_IP' => 'Fastly-Client-IP',
);
$geoblocker_cf_updated = CloudflareRanges::last_updated();
?>
<div class="geoblocker-card">
	<h2><?php esc_html_e( 'How your IP is seen right now', 'geoblocker' ); ?></h2>
	<p class="description"><?php esc_html_e( 'Use this to configure the settings below. If "Detected visitor IP" shows your server, load balancer or CDN instead of your own public IP, you need to trust that proxy.', 'geoblocker' ); ?></p>
	<table class="widefat striped geoblocker-kv">
		<tbody>
			<tr>
				<th scope="row"><?php esc_html_e( 'Detected visitor IP', 'geoblocker' ); ?></th>
				<td><code><?php echo esc_html( '' !== $geoblocker_details['ip'] ? $geoblocker_details['ip'] : '—' ); ?></code> <span class="description"><?php echo esc_html( sprintf( /* translators: %s: header name. */ __( '(from %s)', 'geoblocker' ), $geoblocker_details['source'] ) ); ?></span></td>
			</tr>
			<?php
			foreach ( $geoblocker_headers as $geoblocker_key => $geoblocker_label ) :
				if ( empty( $_SERVER[ $geoblocker_key ] ) || ! is_string( $_SERVER[ $geoblocker_key ] ) ) {
					continue;
				}
				?>
				<tr>
					<th scope="row"><?php echo esc_html( $geoblocker_label ); ?></th>
					<td><code><?php echo esc_html( substr( sanitize_text_field( wp_unslash( $_SERVER[ $geoblocker_key ] ) ), 0, 300 ) ); // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized ?></code></td>
				</tr>
			<?php endforeach; ?>
		</tbody>
	</table>
</div>

<?php AdminPage::form_open( 'proxy' ); ?>
<div class="geoblocker-card">
	<h2><?php esc_html_e( 'Cloudflare', 'geoblocker' ); ?></h2>
	<?php
	AdminPage::toggle(
		'trust_cloudflare',
		(bool) $settings['trust_cloudflare'],
		__( 'My site is behind Cloudflare – trust Cloudflare', 'geoblocker' ),
		__( 'CF-Connecting-IP (and CF-IPCountry) are only trusted when the connection really comes from one of Cloudflare\'s published IP ranges, so they cannot be spoofed by visitors.', 'geoblocker' )
	);
	?>
	<p class="description">
		<?php
		echo esc_html(
			$geoblocker_cf_updated
				/* translators: %s: date. */
				? sprintf( __( 'Cloudflare IP list last refreshed: %s. It is refreshed weekly while this option is on.', 'geoblocker' ), wp_date( get_option( 'date_format' ), $geoblocker_cf_updated ) )
				: __( 'Using the Cloudflare IP list built into the plugin.', 'geoblocker' )
		);
		?>
	</p>
</div>

<div class="geoblocker-card">
	<h2><?php esc_html_e( 'Other reverse proxies, load balancers and CDNs', 'geoblocker' ); ?></h2>
	<table class="form-table" role="presentation">
		<tr>
			<th scope="row"><label for="geoblocker-trusted-proxies"><?php esc_html_e( 'Trusted proxy IPs / ranges', 'geoblocker' ); ?></label></th>
			<td>
				<textarea id="geoblocker-trusted-proxies" class="large-text code" rows="6" name="<?php echo esc_attr( AdminPage::name( 'trusted_proxies' ) ); ?>" placeholder="10.0.0.0/8&#10;192.0.2.15"><?php echo esc_textarea( implode( "\n", (array) $settings['trusted_proxies'] ) ); ?></textarea>
				<p class="description"><?php esc_html_e( 'One IP, CIDR range or start-end range per line. The forwarding header below is ONLY read when the request comes directly from one of these addresses. Leave empty if you do not use a proxy.', 'geoblocker' ); ?></p>
			</td>
		</tr>
		<tr>
			<th scope="row"><label for="geoblocker-proxy-header"><?php esc_html_e( 'Client IP header', 'geoblocker' ); ?></label></th>
			<td>
				<select id="geoblocker-proxy-header" name="<?php echo esc_attr( AdminPage::name( 'proxy_header' ) ); ?>" data-geoblocker-proxy-header>
					<?php
					$geoblocker_labels = array(
						'x_forwarded_for'  => 'X-Forwarded-For',
						'x_real_ip'        => 'X-Real-IP',
						'true_client_ip'   => 'True-Client-IP (Akamai, Cloudflare Enterprise)',
						'fastly_client_ip' => 'Fastly-Client-IP',
						'x_client_ip'      => 'X-Client-IP',
						'custom'           => __( 'Custom header…', 'geoblocker' ),
					);
					foreach ( array_keys( Settings::proxy_header_choices() ) as $geoblocker_choice ) :
						?>
						<option value="<?php echo esc_attr( $geoblocker_choice ); ?>" <?php selected( $settings['proxy_header'], $geoblocker_choice ); ?>><?php echo esc_html( $geoblocker_labels[ $geoblocker_choice ] ?? $geoblocker_choice ); ?></option>
					<?php endforeach; ?>
				</select>
				<p class="description"><?php esc_html_e( 'For X-Forwarded-For, the address list is read from right to left and trusted proxies are skipped, so spoofed values added by the visitor are ignored.', 'geoblocker' ); ?></p>
			</td>
		</tr>
		<tr data-geoblocker-custom-header>
			<th scope="row"><label for="geoblocker-proxy-custom-header"><?php esc_html_e( 'Custom header name', 'geoblocker' ); ?></label></th>
			<td>
				<input type="text" id="geoblocker-proxy-custom-header" class="regular-text code" name="<?php echo esc_attr( AdminPage::name( 'proxy_custom_header' ) ); ?>" value="<?php echo esc_attr( str_replace( '_', '-', (string) $settings['proxy_custom_header'] ) ); ?>" placeholder="X-Client-Address">
			</td>
		</tr>
	</table>
</div>
<?php AdminPage::form_close(); ?>

<div class="geoblocker-card">
	<h2><?php esc_html_e( 'Maintenance', 'geoblocker' ); ?></h2>
	<?php Actions::button( Actions::REFRESH_CF, __( 'Refresh Cloudflare IP list now', 'geoblocker' ) ); ?>
</div>
