<?php
/**
 * Tab: geolocation provider.
 *
 * @package GeoBlocker
 *
 * @var array $settings Settings.
 */

use GeoBlocker\Admin\Actions;
use GeoBlocker\Admin\AdminPage;
use GeoBlocker\Geo\DatabaseUpdater;
use GeoBlocker\Geo\GeoLocator;

defined( 'ABSPATH' ) || exit;

$geoblocker_info      = DatabaseUpdater::info();
$geoblocker_path      = DatabaseUpdater::get_active_path();
$geoblocker_has_db    = '' !== $geoblocker_path && is_readable( $geoblocker_path );
$geoblocker_providers = GeoLocator::instance()->get_providers();
$geoblocker_secret    = static function ( string $key, string $label, string $help ) use ( $settings ): void {
	$geoblocker_id  = 'geoblocker-' . str_replace( '_', '-', $key );
	$geoblocker_set = '' !== (string) $settings[ $key ];
	?>
	<tr>
		<th scope="row"><label for="<?php echo esc_attr( $geoblocker_id ); ?>"><?php echo esc_html( $label ); ?></label></th>
		<td>
			<input type="password" id="<?php echo esc_attr( $geoblocker_id ); ?>" class="regular-text" autocomplete="new-password" name="<?php echo esc_attr( AdminPage::name( $key ) ); ?>" value="" placeholder="<?php echo esc_attr( $geoblocker_set ? __( '•••••••• (saved – leave empty to keep)', 'geoblocker' ) : '' ); ?>">
			<?php if ( $geoblocker_set ) : ?>
				<label class="geoblocker-inline-check"><input type="checkbox" name="<?php echo esc_attr( AdminPage::name( $key . '_clear' ) ); ?>" value="1"> <?php esc_html_e( 'Remove saved key', 'geoblocker' ); ?></label>
			<?php endif; ?>
			<p class="description">
			<?php
			echo wp_kses(
				$help,
				array(
					'a' => array(
						'href'   => array(),
						'target' => array(),
						'rel'    => array(),
					),
				)
			);
			?>
									</p>
		</td>
	</tr>
	<?php
};
?>
<div class="geoblocker-card">
	<h2><?php esc_html_e( 'Local GeoIP database', 'geoblocker' ); ?></h2>
	<?php if ( $geoblocker_has_db ) : ?>
		<p><span class="geoblocker-pill geoblocker-pill--on"><?php esc_html_e( 'Installed', 'geoblocker' ); ?></span></p>
		<table class="widefat striped geoblocker-kv">
			<tbody>
				<tr><th scope="row"><?php esc_html_e( 'Database', 'geoblocker' ); ?></th><td><?php echo esc_html( 'custom' === $settings['local_db_source'] ? __( 'Custom file', 'geoblocker' ) : (string) ( $geoblocker_info['type'] ?? '' ) ); ?></td></tr>
				<?php if ( 'custom' !== $settings['local_db_source'] && ! empty( $geoblocker_info['updated'] ) ) : ?>
					<tr><th scope="row"><?php esc_html_e( 'Last updated', 'geoblocker' ); ?></th><td><?php echo esc_html( wp_date( get_option( 'date_format' ) . ' ' . get_option( 'time_format' ), (int) $geoblocker_info['updated'] ) ); ?></td></tr>
					<tr><th scope="row"><?php esc_html_e( 'Size', 'geoblocker' ); ?></th><td><?php echo esc_html( size_format( (int) ( $geoblocker_info['size'] ?? 0 ) ) ); ?></td></tr>
				<?php endif; ?>
			</tbody>
		</table>
	<?php else : ?>
		<p><span class="geoblocker-pill geoblocker-pill--warn"><?php esc_html_e( 'Not installed', 'geoblocker' ); ?></span></p>
		<p><?php esc_html_e( 'Download the free database once; afterwards it is updated automatically every month. Lookups then happen entirely on your server: visitor IP addresses are never sent to a third party.', 'geoblocker' ); ?></p>
	<?php endif; ?>

	<?php if ( ! empty( $geoblocker_info['last_error'] ) ) : ?>
		<div class="notice notice-error inline"><p><?php echo esc_html( sprintf( /* translators: %s: error message. */ __( 'Last update failed: %s', 'geoblocker' ), (string) $geoblocker_info['last_error'] ) ); ?></p></div>
	<?php endif; ?>

	<div class="geoblocker-button-row">
		<?php
		if ( 'custom' !== $settings['local_db_source'] ) {
			Actions::button( Actions::DOWNLOAD_DB, $geoblocker_has_db ? __( 'Update database now', 'geoblocker' ) : __( 'Download free database now', 'geoblocker' ), 'button button-primary', array( 'data-geoblocker-busy' => __( 'Downloading… this can take a minute', 'geoblocker' ) ) );
		}
		Actions::button( Actions::CLEAR_CACHE, __( 'Clear geolocation cache', 'geoblocker' ) );
		?>
	</div>
	<p class="description">
		<?php
		echo wp_kses(
			__( 'The default database is <a href="https://db-ip.com" target="_blank" rel="noopener noreferrer">IP Geolocation by DB-IP</a> (free, no account required, licensed under CC BY 4.0).', 'geoblocker' ),
			array(
				'a' => array(
					'href'   => array(),
					'target' => array(),
					'rel'    => array(),
				),
			)
		);
		?>
	</p>
</div>

<?php AdminPage::form_open( 'geolocation' ); ?>
<div class="geoblocker-card">
	<h2><?php esc_html_e( 'Geolocation provider', 'geoblocker' ); ?></h2>
	<fieldset class="geoblocker-radio-list">
		<legend class="screen-reader-text"><?php esc_html_e( 'Geolocation provider', 'geoblocker' ); ?></legend>
		<?php foreach ( $geoblocker_providers as $geoblocker_id => $geoblocker_provider ) : ?>
			<label>
				<input type="radio" name="<?php echo esc_attr( AdminPage::name( 'provider' ) ); ?>" value="<?php echo esc_attr( $geoblocker_id ); ?>" <?php checked( $settings['provider'], $geoblocker_id ); ?>>
				<?php echo esc_html( $geoblocker_provider->get_label() ); ?>
				<?php if ( $geoblocker_provider->is_remote() ) : ?>
					<span class="geoblocker-tag"><?php esc_html_e( 'sends visitor IPs to a third party', 'geoblocker' ); ?></span>
				<?php endif; ?>
			</label>
		<?php endforeach; ?>
	</fieldset>

	<?php
	AdminPage::toggle(
		'use_cloudflare_country',
		(bool) $settings['use_cloudflare_country'],
		__( "Use Cloudflare's country header when available", 'geoblocker' ),
		__( 'If your site is behind Cloudflare (and "Trust Cloudflare" is enabled on the Proxy & CDN tab), the free CF-IPCountry header is used and no lookup is needed at all. The header is ignored for requests that do not come from a verified Cloudflare server.', 'geoblocker' )
	);
	?>
</div>

<div class="geoblocker-card">
	<h2><?php esc_html_e( 'Local database source', 'geoblocker' ); ?></h2>
	<table class="form-table" role="presentation">
		<tr>
			<th scope="row"><?php esc_html_e( 'Source', 'geoblocker' ); ?></th>
			<td>
				<fieldset class="geoblocker-radio-list" data-geoblocker-dbsource>
					<label><input type="radio" name="<?php echo esc_attr( AdminPage::name( 'local_db_source' ) ); ?>" value="dbip" <?php checked( $settings['local_db_source'], 'dbip' ); ?>> <?php esc_html_e( 'DB-IP IP to Country Lite (free, no account needed)', 'geoblocker' ); ?></label>
					<label><input type="radio" name="<?php echo esc_attr( AdminPage::name( 'local_db_source' ) ); ?>" value="maxmind" <?php checked( $settings['local_db_source'], 'maxmind' ); ?>> <?php esc_html_e( 'MaxMind GeoLite2 Country (free account and license key)', 'geoblocker' ); ?></label>
					<label><input type="radio" name="<?php echo esc_attr( AdminPage::name( 'local_db_source' ) ); ?>" value="custom" <?php checked( $settings['local_db_source'], 'custom' ); ?>> <?php esc_html_e( 'Custom .mmdb file already on the server', 'geoblocker' ); ?></label>
				</fieldset>
			</td>
		</tr>
		<?php
		$geoblocker_secret(
			'maxmind_license_key',
			__( 'MaxMind license key', 'geoblocker' ),
			__( 'Only needed for the MaxMind source. Create a free account at <a href="https://www.maxmind.com/en/geolite2/signup" target="_blank" rel="noopener noreferrer">maxmind.com</a>. The key is stored on the server and never shown on your website.', 'geoblocker' )
		);
		?>
		<tr>
			<th scope="row"><label for="geoblocker-custom-db-path"><?php esc_html_e( 'Custom database path', 'geoblocker' ); ?></label></th>
			<td>
				<input type="text" id="geoblocker-custom-db-path" class="large-text code" name="<?php echo esc_attr( AdminPage::name( 'custom_db_path' ) ); ?>" value="<?php echo esc_attr( (string) $settings['custom_db_path'] ); ?>" placeholder="/var/lib/GeoIP/GeoLite2-Country.mmdb">
				<p class="description"><?php esc_html_e( 'Absolute server path to a MaxMind-format (.mmdb) country or city database, e.g. one kept up to date by geoipupdate.', 'geoblocker' ); ?></p>
			</td>
		</tr>
		<tr>
			<th scope="row"><?php esc_html_e( 'Automatic updates', 'geoblocker' ); ?></th>
			<td>
				<?php AdminPage::toggle( 'auto_update_db', (bool) $settings['auto_update_db'], __( 'Update the downloaded database automatically (monthly)', 'geoblocker' ) ); ?>
			</td>
		</tr>
	</table>
</div>

<div class="geoblocker-card">
	<h2><?php esc_html_e( 'External API providers (optional)', 'geoblocker' ); ?></h2>
	<p class="description"><?php esc_html_e( 'Only used when an external provider is selected above. Results are cached to minimise requests. Keys are only used server-side.', 'geoblocker' ); ?></p>
	<table class="form-table" role="presentation">
		<?php
		$geoblocker_secret(
			'ipapi_key',
			__( 'ipapi.co API key', 'geoblocker' ),
			__( 'Optional. Without a key the limited free tier is used.', 'geoblocker' )
		);
		$geoblocker_secret(
			'ipinfo_token',
			__( 'IPinfo token', 'geoblocker' ),
			__( 'Required for IPinfo Lite. Get a free token at <a href="https://ipinfo.io/signup" target="_blank" rel="noopener noreferrer">ipinfo.io</a>.', 'geoblocker' )
		);
		?>
		<tr>
			<th scope="row"><label for="geoblocker-cache-ttl"><?php esc_html_e( 'Cache lookups for', 'geoblocker' ); ?></label></th>
			<td>
				<select id="geoblocker-cache-ttl" name="<?php echo esc_attr( AdminPage::name( 'cache_ttl' ) ); ?>">
					<?php
					foreach ( array(
						HOUR_IN_SECONDS     => __( '1 hour', 'geoblocker' ),
						DAY_IN_SECONDS      => __( '1 day', 'geoblocker' ),
						7 * DAY_IN_SECONDS  => __( '7 days', 'geoblocker' ),
						30 * DAY_IN_SECONDS => __( '30 days', 'geoblocker' ),
					) as $geoblocker_seconds => $geoblocker_label ) :
						?>
						<option value="<?php echo esc_attr( (string) $geoblocker_seconds ); ?>" <?php selected( (int) $settings['cache_ttl'], $geoblocker_seconds ); ?>><?php echo esc_html( $geoblocker_label ); ?></option>
					<?php endforeach; ?>
				</select>
				<p class="description"><?php esc_html_e( 'Applies to external providers (and to all providers when a persistent object cache such as Redis is available).', 'geoblocker' ); ?></p>
			</td>
		</tr>
	</table>
</div>
<?php
AdminPage::form_close();
