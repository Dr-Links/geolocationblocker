<?php
/**
 * Page header: title, status bar and tabs.
 *
 * @package GeoBlocker
 *
 * @var string $tab      Current tab.
 * @var array  $settings Settings.
 */

use GeoBlocker\Admin\AdminPage;
use GeoBlocker\Admin\Notices;
use GeoBlocker\Ip\IpDetector;

defined( 'ABSPATH' ) || exit;

$geoblocker_status = AdminPage::provider_status();
$geoblocker_ip     = IpDetector::instance()->get_client_ip();
?>
<div class="wrap geoblocker-wrap">
	<h1 class="geoblocker-title">
		<span class="dashicons dashicons-shield-alt" aria-hidden="true"></span>
		<?php esc_html_e( 'GeoBlocker', 'geoblocker' ); ?>
	</h1>

	<div class="geoblocker-statusbar">
		<div class="geoblocker-status">
			<span class="geoblocker-status__label"><?php esc_html_e( 'Status', 'geoblocker' ); ?></span>
			<?php if ( ! empty( $settings['enabled'] ) ) : ?>
				<span class="geoblocker-pill geoblocker-pill--on"><?php esc_html_e( 'GeoBlocker Enabled', 'geoblocker' ); ?></span>
			<?php else : ?>
				<span class="geoblocker-pill geoblocker-pill--off"><?php esc_html_e( 'GeoBlocker Disabled', 'geoblocker' ); ?></span>
			<?php endif; ?>
		</div>
		<div class="geoblocker-status">
			<span class="geoblocker-status__label"><?php esc_html_e( 'Geolocation', 'geoblocker' ); ?></span>
			<span class="geoblocker-pill <?php echo $geoblocker_status['ok'] ? 'geoblocker-pill--on' : 'geoblocker-pill--warn'; ?>"><?php echo esc_html( $geoblocker_status['label'] ); ?></span>
		</div>
		<div class="geoblocker-status">
			<span class="geoblocker-status__label"><?php esc_html_e( 'Blocked', 'geoblocker' ); ?></span>
			<span class="geoblocker-status__value">
				<?php
				$geoblocker_countries  = in_array( $settings['mode'], array( 'countries', 'both' ), true ) ? count( (array) $settings['blocked_countries'] ) : 0;
				$geoblocker_continents = in_array( $settings['mode'], array( 'continents', 'both' ), true ) ? count( (array) $settings['blocked_continents'] ) : 0;
				echo esc_html(
					sprintf(
						/* translators: %d: number of countries. */
						_n( '%d country', '%d countries', $geoblocker_countries, 'geoblocker' ),
						$geoblocker_countries
					) . ', ' . sprintf(
						/* translators: %d: number of continents. */
						_n( '%d continent', '%d continents', $geoblocker_continents, 'geoblocker' ),
						$geoblocker_continents
					)
				);
				?>
			</span>
		</div>
		<div class="geoblocker-status">
			<span class="geoblocker-status__label"><?php esc_html_e( 'Your IP', 'geoblocker' ); ?></span>
			<code class="geoblocker-status__value"><?php echo esc_html( '' !== $geoblocker_ip ? $geoblocker_ip : __( 'unknown', 'geoblocker' ) ); ?></code>
		</div>
	</div>

	<?php
	settings_errors();
	Notices::render();
	?>

	<nav class="nav-tab-wrapper geoblocker-tabs" aria-label="<?php esc_attr_e( 'GeoBlocker sections', 'geoblocker' ); ?>">
		<?php foreach ( AdminPage::tabs() as $geoblocker_slug => $geoblocker_label ) : ?>
			<a href="<?php echo esc_url( AdminPage::url( $geoblocker_slug ) ); ?>" class="nav-tab <?php echo $tab === $geoblocker_slug ? 'nav-tab-active' : ''; ?>" <?php echo $tab === $geoblocker_slug ? 'aria-current="page"' : ''; ?>><?php echo esc_html( $geoblocker_label ); ?></a>
		<?php endforeach; ?>
	</nav>
