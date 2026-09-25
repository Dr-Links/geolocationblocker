<?php
/**
 * Tab: logs.
 *
 * @package GeoBlocker
 *
 * @var array $settings Settings.
 */

use GeoBlocker\Admin\Actions;
use GeoBlocker\Admin\AdminPage;
use GeoBlocker\Admin\LogsListTable;

defined( 'ABSPATH' ) || exit;

AdminPage::form_open( 'logging' );
?>
<div class="geoblocker-card">
	<h2><?php esc_html_e( '7. Logging', 'geoblocker' ); ?></h2>
	<?php
	AdminPage::toggle(
		'logging',
		(bool) $settings['logging'],
		__( 'Enable the blocked visitor log', 'geoblocker' ),
		__( 'Records date/time, IP address, country, continent, requested URL, user agent and blocking reason for each blocked visit. Nothing is stored while this is off.', 'geoblocker' )
	);
	?>
	<div class="geoblocker-grid">
		<div>
			<label for="geoblocker-log-retention"><strong><?php esc_html_e( 'Automatically delete logs after', 'geoblocker' ); ?></strong></label><br>
			<select id="geoblocker-log-retention" name="<?php echo esc_attr( AdminPage::name( 'log_retention' ) ); ?>">
				<?php
				foreach ( array(
					7   => __( '7 days', 'geoblocker' ),
					30  => __( '30 days', 'geoblocker' ),
					90  => __( '90 days', 'geoblocker' ),
					365 => __( '365 days', 'geoblocker' ),
					0   => __( 'Never', 'geoblocker' ),
				) as $geoblocker_days => $geoblocker_label ) :
					?>
					<option value="<?php echo esc_attr( (string) $geoblocker_days ); ?>" <?php selected( (int) $settings['log_retention'], $geoblocker_days ); ?>><?php echo esc_html( $geoblocker_label ); ?></option>
				<?php endforeach; ?>
			</select>
		</div>
	</div>
	<?php
	AdminPage::toggle( 'log_anonymize_ip', (bool) $settings['log_anonymize_ip'], __( 'Anonymise IP addresses in the log', 'geoblocker' ), __( 'Stores 203.0.113.0 instead of 203.0.113.42 (IPv6: last 80 bits removed). Recommended for GDPR data minimisation.', 'geoblocker' ) );
	AdminPage::toggle( 'log_query_strings', (bool) $settings['log_query_strings'], __( 'Include query strings in logged URLs', 'geoblocker' ), __( 'Off by default because query strings can contain personal data (e-mail addresses, tokens).', 'geoblocker' ) );
	AdminPage::toggle( 'log_failures', (bool) $settings['log_failures'], __( 'Also log failed location lookups', 'geoblocker' ), __( 'Helps diagnose geolocation problems. Failed lookups are logged whether the visitor was allowed or blocked.', 'geoblocker' ) );
	?>
</div>
<?php AdminPage::form_close(); ?>

<div class="geoblocker-card">
	<div class="geoblocker-card__head">
		<h2><?php esc_html_e( 'Blocked visitor log', 'geoblocker' ); ?></h2>
		<?php Actions::button( Actions::CLEAR_LOGS, __( 'Clear logs', 'geoblocker' ), 'button button-link-delete', array( 'data-geoblocker-confirm' => '1' ) ); ?>
	</div>
	<form method="get" action="<?php echo esc_url( admin_url( 'admin.php' ) ); ?>">
		<input type="hidden" name="page" value="<?php echo esc_attr( AdminPage::SLUG ); ?>">
		<input type="hidden" name="tab" value="logs">
		<?php
		$geoblocker_table = new LogsListTable();
		$geoblocker_table->prepare_items();
		$geoblocker_table->search_box( __( 'Search logs', 'geoblocker' ), 'geoblocker-log-search' );
		$geoblocker_table->display();
		?>
	</form>
</div>
