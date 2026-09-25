<?php
/**
 * Tab: block action.
 *
 * @package GeoBlocker
 *
 * @var array $settings Settings.
 */

use GeoBlocker\Admin\AdminPage;
use GeoBlocker\Settings;

defined( 'ABSPATH' ) || exit;

AdminPage::form_open( 'action' );
?>
<div class="geoblocker-card">
	<h2><?php esc_html_e( '5. Block Action', 'geoblocker' ); ?></h2>
	<p class="description"><?php esc_html_e( 'Choose what a blocked visitor sees. Blocked responses are always sent with no-cache headers so page caches and CDNs never store them.', 'geoblocker' ); ?></p>
	<fieldset class="geoblocker-choices" data-geoblocker-action>
		<legend class="screen-reader-text"><?php esc_html_e( 'Block action', 'geoblocker' ); ?></legend>
		<?php
		$geoblocker_actions = array(
			Settings::ACTION_PAGE     => array( __( 'Show a custom blocked page', 'geoblocker' ), __( 'A styled page with your own rich content (HTTP 403).', 'geoblocker' ) ),
			Settings::ACTION_MESSAGE  => array( __( 'Show a custom message', 'geoblocker' ), __( 'A simple plain-text message (HTTP 403).', 'geoblocker' ) ),
			Settings::ACTION_REDIRECT => array( __( 'Redirect to another URL', 'geoblocker' ), __( 'Send blocked visitors to another page or website.', 'geoblocker' ) ),
			Settings::ACTION_403      => array( __( 'Return HTTP 403 Forbidden', 'geoblocker' ), __( 'A minimal "403 Forbidden" response. Fastest option.', 'geoblocker' ) ),
		);
		foreach ( $geoblocker_actions as $geoblocker_value => $geoblocker_action ) :
			?>
			<label class="geoblocker-choice">
				<input type="radio" name="<?php echo esc_attr( AdminPage::name( 'action' ) ); ?>" value="<?php echo esc_attr( $geoblocker_value ); ?>" <?php checked( $settings['action'], $geoblocker_value ); ?>>
				<span class="geoblocker-choice__body">
					<strong><?php echo esc_html( $geoblocker_action[0] ); ?></strong>
					<span><?php echo esc_html( $geoblocker_action[1] ); ?></span>
				</span>
			</label>
		<?php endforeach; ?>
	</fieldset>
</div>

<div class="geoblocker-card" data-geoblocker-action-panel="page message">
	<h2><?php esc_html_e( 'Page title', 'geoblocker' ); ?></h2>
	<p>
		<label class="screen-reader-text" for="geoblocker-page-title"><?php esc_html_e( 'Page title', 'geoblocker' ); ?></label>
		<input type="text" id="geoblocker-page-title" class="regular-text" name="<?php echo esc_attr( AdminPage::name( 'page_title' ) ); ?>" value="<?php echo esc_attr( (string) $settings['page_title'] ); ?>" maxlength="200">
	</p>
	<p class="description"><?php esc_html_e( 'Shown in the browser tab for the blocked page and custom message.', 'geoblocker' ); ?></p>
</div>

<div class="geoblocker-card" data-geoblocker-action-panel="page">
	<h2><?php esc_html_e( 'Custom blocked page content', 'geoblocker' ); ?></h2>
	<p class="description"><?php esc_html_e( 'Safe HTML is allowed (headings, links, images, lists, formatting). Scripts, forms and inline event handlers are removed automatically.', 'geoblocker' ); ?></p>
	<?php
	wp_editor(
		(string) $settings['page_content'],
		'geoblocker_page_content',
		array(
			'textarea_name' => AdminPage::name( 'page_content' ),
			'textarea_rows' => 12,
			'media_buttons' => current_user_can( 'upload_files' ),
			'teeny'         => false,
		)
	);
	?>
</div>

<div class="geoblocker-card" data-geoblocker-action-panel="message">
	<h2><?php esc_html_e( 'Custom message', 'geoblocker' ); ?></h2>
	<p>
		<label class="screen-reader-text" for="geoblocker-message"><?php esc_html_e( 'Custom message', 'geoblocker' ); ?></label>
		<textarea id="geoblocker-message" class="large-text" rows="5" name="<?php echo esc_attr( AdminPage::name( 'message' ) ); ?>"><?php echo esc_textarea( (string) $settings['message'] ); ?></textarea>
	</p>
	<p class="description"><?php esc_html_e( 'Plain text only. Line breaks are preserved.', 'geoblocker' ); ?></p>
</div>

<div class="geoblocker-card" data-geoblocker-action-panel="redirect">
	<h2><?php esc_html_e( 'Redirect', 'geoblocker' ); ?></h2>
	<table class="form-table" role="presentation">
		<tr>
			<th scope="row"><label for="geoblocker-redirect-url"><?php esc_html_e( 'Redirect URL', 'geoblocker' ); ?></label></th>
			<td>
				<input type="url" id="geoblocker-redirect-url" class="regular-text" placeholder="https://" name="<?php echo esc_attr( AdminPage::name( 'redirect_url' ) ); ?>" value="<?php echo esc_attr( (string) $settings['redirect_url'] ); ?>">
				<p class="description"><?php esc_html_e( 'If the URL is on this website, that page is automatically excluded from blocking to prevent redirect loops.', 'geoblocker' ); ?></p>
			</td>
		</tr>
		<tr>
			<th scope="row"><label for="geoblocker-redirect-status"><?php esc_html_e( 'Redirect type', 'geoblocker' ); ?></label></th>
			<td>
				<select id="geoblocker-redirect-status" name="<?php echo esc_attr( AdminPage::name( 'redirect_status' ) ); ?>">
					<option value="302" <?php selected( (int) $settings['redirect_status'], 302 ); ?>><?php esc_html_e( '302 – Temporary (recommended)', 'geoblocker' ); ?></option>
					<option value="307" <?php selected( (int) $settings['redirect_status'], 307 ); ?>><?php esc_html_e( '307 – Temporary, keep method', 'geoblocker' ); ?></option>
					<option value="303" <?php selected( (int) $settings['redirect_status'], 303 ); ?>><?php esc_html_e( '303 – See other', 'geoblocker' ); ?></option>
					<option value="301" <?php selected( (int) $settings['redirect_status'], 301 ); ?>><?php esc_html_e( '301 – Permanent (browsers cache it)', 'geoblocker' ); ?></option>
				</select>
			</td>
		</tr>
	</table>
</div>
<?php
AdminPage::form_close();
