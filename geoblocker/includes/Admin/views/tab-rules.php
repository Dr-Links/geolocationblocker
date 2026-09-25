<?php
/**
 * Tab: blocking rules.
 *
 * @package GeoBlocker
 *
 * @var array $settings Settings.
 */

use GeoBlocker\Admin\AdminPage;
use GeoBlocker\Geo\Countries;
use GeoBlocker\Settings;

defined( 'ABSPATH' ) || exit;

AdminPage::form_open( 'rules' );
?>
<div class="geoblocker-card">
	<h2><?php esc_html_e( '1. Enable / Disable', 'geoblocker' ); ?></h2>
	<?php
	AdminPage::toggle(
		'enabled',
		(bool) $settings['enabled'],
		__( 'GeoBlocker Enabled', 'geoblocker' ),
		__( 'Master switch. When off, no visitor is ever checked or blocked.', 'geoblocker' )
	);
	?>
</div>

<div class="geoblocker-card">
	<h2><?php esc_html_e( '2. Blocking Mode', 'geoblocker' ); ?></h2>
	<p class="description"><?php esc_html_e( 'All locations are allowed except the ones you select below.', 'geoblocker' ); ?></p>
	<fieldset class="geoblocker-choices" data-geoblocker-mode>
		<legend class="screen-reader-text"><?php esc_html_e( 'Blocking mode', 'geoblocker' ); ?></legend>
		<?php
		$geoblocker_modes = array(
			Settings::MODE_COUNTRIES  => array( __( 'Block selected countries', 'geoblocker' ), __( 'Only the country list is used.', 'geoblocker' ) ),
			Settings::MODE_CONTINENTS => array( __( 'Block selected continents', 'geoblocker' ), __( 'Only the continent list is used.', 'geoblocker' ) ),
			Settings::MODE_BOTH       => array( __( 'Block selected countries and continents', 'geoblocker' ), __( 'A visitor is blocked if their country OR their continent is selected.', 'geoblocker' ) ),
		);
		foreach ( $geoblocker_modes as $geoblocker_value => $geoblocker_mode ) :
			?>
			<label class="geoblocker-choice">
				<input type="radio" name="<?php echo esc_attr( AdminPage::name( 'mode' ) ); ?>" value="<?php echo esc_attr( $geoblocker_value ); ?>" <?php checked( $settings['mode'], $geoblocker_value ); ?>>
				<span class="geoblocker-choice__body">
					<strong><?php echo esc_html( $geoblocker_mode[0] ); ?></strong>
					<span><?php echo esc_html( $geoblocker_mode[1] ); ?></span>
				</span>
			</label>
		<?php endforeach; ?>
	</fieldset>
</div>

<div class="geoblocker-card" data-geoblocker-section="countries">
	<h2><?php esc_html_e( '3. Blocked Countries', 'geoblocker' ); ?></h2>
	<p class="description"><?php esc_html_e( 'Search and select every country you want to block. Click × to remove a country.', 'geoblocker' ); ?></p>
	<?php AdminPage::country_select( 'blocked_countries', (array) $settings['blocked_countries'], __( 'Blocked countries', 'geoblocker' ) ); ?>
	<p class="geoblocker-inactive-note"><?php esc_html_e( 'Country blocking is not active in the selected mode. Your selection is kept.', 'geoblocker' ); ?></p>
</div>

<div class="geoblocker-card" data-geoblocker-section="continents">
	<h2><?php esc_html_e( '4. Blocked Continents', 'geoblocker' ); ?></h2>
	<fieldset class="geoblocker-continents">
		<legend class="screen-reader-text"><?php esc_html_e( 'Blocked continents', 'geoblocker' ); ?></legend>
		<?php foreach ( Countries::continent_codes() as $geoblocker_code => $geoblocker_name ) : ?>
			<label class="geoblocker-continent">
				<input type="checkbox" name="<?php echo esc_attr( AdminPage::name( 'blocked_continents' ) ); ?>[]" value="<?php echo esc_attr( $geoblocker_code ); ?>" <?php checked( in_array( $geoblocker_code, (array) $settings['blocked_continents'], true ) ); ?>>
				<span><?php echo esc_html( $geoblocker_name ); ?></span>
			</label>
		<?php endforeach; ?>
	</fieldset>
	<p class="geoblocker-inactive-note"><?php esc_html_e( 'Continent blocking is not active in the selected mode. Your selection is kept.', 'geoblocker' ); ?></p>
</div>

<div class="geoblocker-card">
	<h2><?php esc_html_e( 'When location detection fails', 'geoblocker' ); ?></h2>
	<p class="description"><?php esc_html_e( 'Detection can fail for unknown IP ranges or when the geolocation service is unavailable. Allowing is the safe default: a failure never locks everyone out.', 'geoblocker' ); ?></p>
	<fieldset class="geoblocker-radio-list">
		<legend class="screen-reader-text"><?php esc_html_e( 'When location detection fails', 'geoblocker' ); ?></legend>
		<label><input type="radio" name="<?php echo esc_attr( AdminPage::name( 'on_failure' ) ); ?>" value="allow" <?php checked( $settings['on_failure'], 'allow' ); ?>> <?php esc_html_e( 'Allow visitor (recommended)', 'geoblocker' ); ?></label>
		<label><input type="radio" name="<?php echo esc_attr( AdminPage::name( 'on_failure' ) ); ?>" value="block" <?php checked( $settings['on_failure'], 'block' ); ?>> <?php esc_html_e( 'Block visitor', 'geoblocker' ); ?></label>
	</fieldset>
</div>
<?php
AdminPage::form_close();
