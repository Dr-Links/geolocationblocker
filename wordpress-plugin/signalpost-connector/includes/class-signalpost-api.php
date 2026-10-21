<?php
/**
 * HTTP client for the Signalpost central server.
 *
 * @package SignalpostConnector
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Server-to-server calls using the WordPress HTTP API. TLS verification is
 * always on. Error results carry a short code, never response bodies or secrets.
 */
class Signalpost_API {

	/**
	 * Validate and normalise a central server URL.
	 *
	 * @param string $url Input.
	 * @return string|WP_Error
	 */
	public static function normalize_central_url( $url ) {
		$url = esc_url_raw( trim( (string) $url ), array( 'https', 'http' ) );
		$url = untrailingslashit( $url );
		$parts = wp_parse_url( $url );
		if ( empty( $parts['scheme'] ) || empty( $parts['host'] ) || isset( $parts['query'] ) || isset( $parts['user'] ) ) {
			return new WP_Error( 'invalid_url', __( 'Enter the Signalpost address, for example https://chat.example.com', 'signalpost-connector' ) );
		}
		if ( 'https' !== $parts['scheme'] && ! self::allow_http( $parts['host'] ) ) {
			return new WP_Error( 'https_required', __( 'The Signalpost address must use HTTPS.', 'signalpost-connector' ) );
		}
		return $url;
	}

	/**
	 * Plain HTTP is allowed only for local development hosts or with an explicit constant.
	 *
	 * @param string $host Host.
	 * @return bool
	 */
	public static function allow_http( $host ) {
		if ( defined( 'SIGNALPOST_ALLOW_HTTP' ) && SIGNALPOST_ALLOW_HTTP ) {
			return true;
		}
		return in_array( $host, array( 'localhost', '127.0.0.1' ), true ) || (bool) preg_match( '/\.(test|localhost)$/', $host );
	}

	/**
	 * Perform a request.
	 *
	 * @param string     $method     HTTP method.
	 * @param string     $central    Central base URL.
	 * @param string     $path       Path below /api/v1.
	 * @param array|null $body       JSON body.
	 * @param string     $credential Bearer credential, or '' for unauthenticated calls.
	 * @return array|WP_Error Decoded "data" on success.
	 */
	public static function request( $method, $central, $path, $body = null, $credential = '' ) {
		$headers = array(
			'Accept'     => 'application/json',
			'User-Agent' => 'SignalpostConnector/' . SIGNALPOST_CONNECTOR_VERSION . '; WordPress/' . get_bloginfo( 'version' ),
		);
		if ( '' !== $credential ) {
			$headers['Authorization'] = 'Bearer ' . $credential;
		}
		$args = array(
			'method'      => $method,
			'timeout'     => 10,
			'redirection' => 0,
			'sslverify'   => true,
			'headers'     => $headers,
		);
		if ( null !== $body ) {
			$args['headers']['Content-Type'] = 'application/json';
			$args['body']                    = wp_json_encode( $body );
		}
		$response = wp_remote_request( $central . '/api/v1' . $path, $args );
		if ( is_wp_error( $response ) ) {
			return new WP_Error( 'unreachable', __( 'Could not reach the Signalpost server. Check the address and that the server is online.', 'signalpost-connector' ) );
		}
		$code    = (int) wp_remote_retrieve_response_code( $response );
		$decoded = json_decode( wp_remote_retrieve_body( $response ), true );
		if ( $code >= 200 && $code < 300 && is_array( $decoded ) && ! empty( $decoded['ok'] ) ) {
			return is_array( $decoded['data'] ) ? $decoded['data'] : array();
		}
		$error_code = is_array( $decoded ) && isset( $decoded['error']['code'] ) ? sanitize_key( $decoded['error']['code'] ) : 'http_' . $code;
		$message    = is_array( $decoded ) && isset( $decoded['error']['message'] ) ? sanitize_text_field( $decoded['error']['message'] ) : __( 'Unexpected response from the Signalpost server.', 'signalpost-connector' );
		return new WP_Error( $error_code, $message, array( 'status' => $code ) );
	}
}
