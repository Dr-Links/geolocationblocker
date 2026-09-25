<?php
/**
 * Tab: privacy.
 *
 * @package GeoBlocker
 *
 * @var array $settings Settings.
 */

use GeoBlocker\Privacy;

defined( 'ABSPATH' ) || exit;

$geoblocker_remote = 'local' !== $settings['provider'];
?>
<div class="geoblocker-card geoblocker-prose">
	<h2><?php esc_html_e( 'What visitor information GeoBlocker processes', 'geoblocker' ); ?></h2>
	<ul>
		<li><strong><?php esc_html_e( 'IP address:', 'geoblocker' ); ?></strong> <?php esc_html_e( 'read from the request to determine the visitor\'s country and continent. With the local database (default) this happens entirely on your server.', 'geoblocker' ); ?></li>
		<li><strong><?php esc_html_e( 'Country and continent:', 'geoblocker' ); ?></strong> <?php esc_html_e( 'derived from the IP address and compared with your rules.', 'geoblocker' ); ?></li>
		<li><strong><?php esc_html_e( 'Cache:', 'geoblocker' ); ?></strong> <?php esc_html_e( 'lookup results (country and continent only) are cached temporarily under a salted one-way hash of the IP address. The IP address itself is not stored.', 'geoblocker' ); ?></li>
		<li><strong><?php esc_html_e( 'Logs (optional, off by default):', 'geoblocker' ); ?></strong> <?php esc_html_e( 'only when logging is enabled, blocked visits are stored with date/time, IP address (optionally anonymised), country, continent, requested path (without query string by default), user agent (truncated) and reason. Logs are deleted automatically after the retention period you choose.', 'geoblocker' ); ?></li>
		<li><strong><?php esc_html_e( 'No cookies and no front-end scripts:', 'geoblocker' ); ?></strong> <?php esc_html_e( 'GeoBlocker does not set cookies or load JavaScript/CSS for visitors.', 'geoblocker' ); ?></li>
	</ul>

	<h3><?php esc_html_e( 'Current configuration', 'geoblocker' ); ?></h3>
	<ul>
		<li>
			<?php
			echo esc_html(
				$geoblocker_remote
					? __( 'An external geolocation provider is selected: visitor IP addresses are sent to that provider. Mention this in your privacy policy.', 'geoblocker' )
					: __( 'The local database is selected: visitor IP addresses are not sent to any third party.', 'geoblocker' )
			);
			?>
		</li>
		<li>
			<?php
			if ( empty( $settings['logging'] ) ) {
				esc_html_e( 'Logging is disabled: no visitor data is stored permanently.', 'geoblocker' );
			} elseif ( 0 === (int) $settings['log_retention'] ) {
				esc_html_e( 'Logging is enabled and logs are kept until you delete them. Consider setting an automatic retention period.', 'geoblocker' );
			} else {
				/* translators: %d: number of days. */
				echo esc_html( sprintf( __( 'Logging is enabled; entries are deleted automatically after %d days.', 'geoblocker' ), (int) $settings['log_retention'] ) );
			}
			?>
		</li>
	</ul>

	<h3><?php esc_html_e( 'Suggested privacy policy text', 'geoblocker' ); ?></h3>
	<p>
		<?php
		printf(
			/* translators: %s: link to the privacy policy guide. */
			esc_html__( 'GeoBlocker adds suggested text to the %s. You can copy it into your privacy policy:', 'geoblocker' ),
			'<a href="' . esc_url( admin_url( 'options-privacy.php?tab=policyguide' ) ) . '">' . esc_html__( 'Privacy Policy Guide', 'geoblocker' ) . '</a>'
		);
		?>
	</p>
	<blockquote class="geoblocker-quote"><?php echo wp_kses_post( Privacy::policy_text() ); ?></blockquote>
</div>
