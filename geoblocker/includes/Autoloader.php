<?php
/**
 * PSR-4 style autoloader for the GeoBlocker namespace.
 *
 * @package GeoBlocker
 */

namespace GeoBlocker;

defined( 'ABSPATH' ) || exit;

/**
 * Maps GeoBlocker\Sub\ClassName to includes/Sub/ClassName.php.
 */
final class Autoloader {

	private const PREFIX = 'GeoBlocker\\';

	/**
	 * Register the autoloader.
	 */
	public static function register(): void {
		spl_autoload_register( array( self::class, 'load' ) );
	}

	/**
	 * Load a class file if it belongs to this plugin.
	 *
	 * @param string $class_name Fully qualified class name.
	 */
	public static function load( string $class_name ): void {
		if ( 0 !== strpos( $class_name, self::PREFIX ) ) {
			return;
		}

		$relative = substr( $class_name, strlen( self::PREFIX ) );

		// Only allow safe characters in class names to prevent path traversal.
		if ( ! preg_match( '/^[A-Za-z0-9_\\\\]+$/', $relative ) ) {
			return;
		}

		$file = GEOBLOCKER_DIR . 'includes/' . str_replace( '\\', '/', $relative ) . '.php';

		if ( is_readable( $file ) ) {
			require_once $file;
		}
	}
}
