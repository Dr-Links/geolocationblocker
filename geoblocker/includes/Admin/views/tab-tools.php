<?php
/**
 * Tab: testing tool.
 *
 * @package GeoBlocker
 *
 * @var array $settings Settings.
 */

defined( 'ABSPATH' ) || exit;
?>
<div class="geoblocker-card">
	<h2><?php esc_html_e( 'Admin Testing Tool', 'geoblocker' ); ?></h2>
	<p class="description"><?php esc_html_e( 'Check how GeoBlocker would treat any IP address with your current (saved) settings. Testing never blocks you.', 'geoblocker' ); ?></p>

	<form class="geoblocker-tester" data-geoblocker-tester>
		<label for="geoblocker-test-ip"><?php esc_html_e( 'IP address', 'geoblocker' ); ?></label>
		<div class="geoblocker-tester__row">
			<input type="text" id="geoblocker-test-ip" class="regular-text code" placeholder="e.g. 8.8.8.8 or 2001:4860:4860::8888" autocomplete="off" inputmode="text">
			<button type="submit" class="button button-primary"><?php esc_html_e( 'Test IP', 'geoblocker' ); ?></button>
			<button type="button" class="button" data-geoblocker-test-current><?php esc_html_e( 'Test Current IP', 'geoblocker' ); ?></button>
		</div>
	</form>

	<div class="geoblocker-test-result" data-geoblocker-test-result aria-live="polite" hidden></div>
	<noscript><p><?php esc_html_e( 'The testing tool requires JavaScript.', 'geoblocker' ); ?></p></noscript>
</div>
