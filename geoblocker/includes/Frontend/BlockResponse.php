<?php
/**
 * Sends the response for a blocked visitor.
 *
 * @package GeoBlocker
 */

namespace GeoBlocker\Frontend;

use GeoBlocker\Rules\Decision;
use GeoBlocker\Settings;

defined( 'ABSPATH' ) || exit;

/**
 * Builds and sends the blocked response and terminates the request.
 *
 * Every blocked response is marked as non-cacheable (headers + DONOTCACHEPAGE)
 * so page caches and CDNs never store a "blocked" page and serve it to allowed
 * visitors.
 */
final class BlockResponse {

	/**
	 * Send the response and exit.
	 *
	 * @param Decision $decision Decision.
	 */
	public function send( Decision $decision ): void {
		$settings = Settings::all();
		$action   = (string) $settings['action'];

		$this->prevent_caching();

		// REST and AJAX clients get a machine-readable 403.
		if ( $this->is_api_request() ) {
			$this->send_json();
		}

		switch ( $action ) {
			case Settings::ACTION_REDIRECT:
				$url = (string) $settings['redirect_url'];
				if ( '' !== $url ) {
					// Admin-configured destination, may be external by design.
					// phpcs:ignore WordPress.Security.SafeRedirect.wp_redirect_wp_redirect
					wp_redirect( esc_url_raw( $url ), (int) $settings['redirect_status'], 'GeoBlocker' );
					exit;
				}
				$this->send_forbidden();
				break;

			case Settings::ACTION_MESSAGE:
				$this->send_html(
					(string) $settings['page_title'],
					'<p>' . nl2br( esc_html( (string) $settings['message'] ) ) . '</p>',
					$decision
				);
				break;

			case Settings::ACTION_PAGE:
				$this->send_html( (string) $settings['page_title'], wp_kses_post( (string) $settings['page_content'] ), $decision );
				break;

			case Settings::ACTION_403:
			default:
				$this->send_forbidden();
		}
	}

	/**
	 * Tell page caches, proxies and CDNs not to store this response.
	 */
	private function prevent_caching(): void {
		if ( ! defined( 'DONOTCACHEPAGE' ) ) {
			define( 'DONOTCACHEPAGE', true ); // phpcs:ignore WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedConstantFound -- standard constant honoured by caching plugins.
		}
		if ( ! headers_sent() ) {
			nocache_headers();
			header( 'Cache-Control: no-store, no-cache, must-revalidate, max-age=0, private' );
			header( 'CDN-Cache-Control: no-store' );
			header( 'X-Robots-Tag: noindex, nofollow' );
		}
	}

	/**
	 * Whether this is a REST, AJAX or XML-RPC request.
	 */
	private function is_api_request(): bool {
		if ( wp_doing_ajax() || ( defined( 'XMLRPC_REQUEST' ) && XMLRPC_REQUEST ) ) {
			return true;
		}
		$uri = isset( $_SERVER['REQUEST_URI'] ) ? sanitize_text_field( wp_unslash( $_SERVER['REQUEST_URI'] ) ) : ''; // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized
		// rest_get_url_prefix() is available early; the REST server is not.
		return false !== strpos( $uri, '/' . rest_get_url_prefix() . '/' ) || isset( $_GET['rest_route'] ); // phpcs:ignore WordPress.Security.NonceVerification.Recommended
	}

	/**
	 * JSON 403.
	 */
	private function send_json(): void {
		status_header( 403 );
		if ( ! headers_sent() ) {
			header( 'Content-Type: application/json; charset=' . get_option( 'blog_charset', 'UTF-8' ) );
		}
		echo wp_json_encode(
			array(
				'code'    => 'geoblocker_forbidden',
				'message' => 'Access from your location is not permitted.',
				'data'    => array( 'status' => 403 ),
			)
		);
		exit;
	}

	/**
	 * Plain 403 Forbidden.
	 */
	private function send_forbidden(): void {
		status_header( 403 );
		if ( ! headers_sent() ) {
			header( 'Content-Type: text/plain; charset=UTF-8' );
		}
		echo '403 Forbidden';
		exit;
	}

	/**
	 * Standalone HTML page. The theme is not loaded, which keeps the response
	 * fast and prevents theme/plugin output from leaking content to blocked visitors.
	 *
	 * @param string   $title    Page title (plain text).
	 * @param string   $body     Safe HTML body (already escaped / kses-filtered).
	 * @param Decision $decision Decision (passed to the filter).
	 */
	private function send_html( string $title, string $body, Decision $decision ): void {
		status_header( 403 );
		if ( ! headers_sent() ) {
			header( 'Content-Type: text/html; charset=UTF-8' );
		}

		$lang = function_exists( 'get_bloginfo' ) ? get_bloginfo( 'language' ) : 'en';

		/**
		 * Filter the full HTML of the block page.
		 *
		 * @param string|null $html     Return a string to replace the template.
		 * @param string      $title    Page title.
		 * @param string      $body     Body HTML.
		 * @param Decision    $decision Blocking decision.
		 */
		$custom = apply_filters( 'geoblocker_block_page_html', null, $title, $body, $decision );
		if ( is_string( $custom ) ) {
			echo $custom; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- provided by a developer filter.
			exit;
		}

		?>
<!DOCTYPE html>
<html lang="<?php echo esc_attr( $lang ); ?>">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title><?php echo esc_html( $title ); ?></title>
<style>
.geoblocker-page{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f0f2f5;color:#1d2327;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Oxygen-Sans,Ubuntu,Cantarell,"Helvetica Neue",sans-serif;line-height:1.6}
.geoblocker-page__card{box-sizing:border-box;max-width:640px;width:calc(100% - 32px);margin:32px 16px;padding:40px;background:#fff;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.08)}
.geoblocker-page__card h1{margin-top:0;font-size:1.75rem;line-height:1.3}
.geoblocker-page__card img{max-width:100%;height:auto}
.geoblocker-page__card a{color:#2271b1}
</style>
</head>
<body class="geoblocker-page">
<main class="geoblocker-page__card" role="main">
		<?php echo $body; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- escaped/kses-filtered by the caller. ?>
</main>
</body>
</html>
		<?php
		exit;
	}
}
