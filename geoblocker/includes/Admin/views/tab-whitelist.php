<?php
/**
 * Tab: whitelist.
 *
 * @package GeoBlocker
 *
 * @var array $settings Settings.
 */

use GeoBlocker\Admin\AdminPage;

defined( 'ABSPATH' ) || exit;

AdminPage::form_open( 'whitelist' );
?>
<div class="geoblocker-card">
	<h2><?php esc_html_e( '6. Whitelist', 'geoblocker' ); ?></h2>
	<p class="description"><?php esc_html_e( 'Whitelisted visitors always bypass geographical blocking.', 'geoblocker' ); ?></p>

	<h3><label for="geoblocker-whitelist-ips"><?php esc_html_e( 'IP addresses and ranges', 'geoblocker' ); ?></label></h3>
	<textarea id="geoblocker-whitelist-ips" class="large-text code" rows="8" name="<?php echo esc_attr( AdminPage::name( 'whitelist_ips' ) ); ?>" placeholder="203.0.113.10&#10;198.51.100.0/24&#10;2001:db8::/32&#10;192.0.2.1-192.0.2.50"><?php echo esc_textarea( implode( "\n", (array) $settings['whitelist_ips'] ) ); ?></textarea>
	<p class="description"><?php esc_html_e( 'One entry per line: single IPs, CIDR ranges (e.g. 198.51.100.0/24) or start-end ranges. IPv4 and IPv6 are supported. Lines starting with # are ignored.', 'geoblocker' ); ?></p>

	<h3><?php esc_html_e( 'Whitelisted countries', 'geoblocker' ); ?></h3>
	<p class="description"><?php esc_html_e( 'Visitors from these countries are never blocked, even if their continent is blocked (e.g. block Europe but allow France).', 'geoblocker' ); ?></p>
	<?php AdminPage::country_select( 'whitelist_countries', (array) $settings['whitelist_countries'], __( 'Whitelisted countries', 'geoblocker' ) ); ?>
</div>

<div class="geoblocker-card">
	<h2><?php esc_html_e( 'Administrators & dashboard access', 'geoblocker' ); ?></h2>
	<?php
	AdminPage::toggle(
		'admin_bypass',
		(bool) $settings['admin_bypass'],
		__( 'Logged-in administrators bypass blocking', 'geoblocker' ),
		__( 'Users who can manage options (and network super admins) are never blocked while logged in.', 'geoblocker' )
	);
	AdminPage::toggle(
		'exclude_admin_login',
		(bool) $settings['exclude_admin_login'],
		__( 'Never block wp-admin and the login page', 'geoblocker' ),
		__( 'Strongly recommended: guarantees you can always log in, even if you travel to a blocked country. Disable only if you also want to block logins from blocked locations.', 'geoblocker' )
	);
	?>
</div>
<?php
AdminPage::form_close();
