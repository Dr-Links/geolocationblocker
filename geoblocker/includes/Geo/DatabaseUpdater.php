<?php
/**
 * Downloads and installs the local GeoIP database.
 *
 * @package GeoBlocker
 */

namespace GeoBlocker\Geo;

use GeoBlocker\Settings;

defined( 'ABSPATH' ) || exit;

/**
 * Supports:
 * - DB-IP "IP to Country Lite" (free, no account, CC BY 4.0) – default.
 * - MaxMind GeoLite2 Country (free account + license key).
 * - Any custom .mmdb file already on the server.
 *
 * Downloads happen server-side only; visitor data is never transmitted.
 */
final class DatabaseUpdater {

	public const OPTION   = 'geoblocker_geoip_db';
	public const FILENAME = 'geoblocker-country.mmdb';

	/**
	 * Stored database information.
	 *
	 * @return array<string,mixed>
	 */
	public static function info(): array {
		$info = get_option( self::OPTION, array() );
		return is_array( $info ) ? $info : array();
	}

	/**
	 * Path of the database currently used for lookups ('' if none).
	 */
	public static function get_active_path(): string {
		$settings = Settings::all();
		if ( 'custom' === $settings['local_db_source'] ) {
			return (string) $settings['custom_db_path'];
		}
		$info = self::info();
		return isset( $info['path'] ) ? (string) $info['path'] : '';
	}

	/**
	 * Directory for downloaded databases.
	 */
	public static function storage_dir(): string {
		$uploads = wp_upload_dir( null, false );
		return trailingslashit( wp_normalize_path( $uploads['basedir'] ) ) . 'geoblocker';
	}

	/**
	 * Download and install the database for the configured source.
	 *
	 * @param string|null $source Source override ('dbip' or 'maxmind').
	 * @return true|\WP_Error
	 */
	public static function update( ?string $source = null ) {
		$source = $source ?? (string) Settings::get( 'local_db_source' );

		if ( 'custom' === $source ) {
			return self::validate_file( (string) Settings::get( 'custom_db_path' ) );
		}

		if ( function_exists( 'set_time_limit' ) ) {
			@set_time_limit( 300 ); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
		}

		require_once ABSPATH . 'wp-admin/includes/file.php';

		$dir = self::prepare_dir();
		if ( is_wp_error( $dir ) ) {
			return self::record_error( $dir );
		}

		$target = $dir . '/' . self::FILENAME;
		$temp   = $dir . '/' . wp_generate_password( 12, false ) . '.tmp';

		if ( 'maxmind' === $source ) {
			$result = self::download_maxmind( $temp );
		} else {
			$result = self::download_dbip( $temp );
		}

		if ( is_wp_error( $result ) ) {
			wp_delete_file( $temp );
			return self::record_error( $result );
		}

		$valid = self::validate_file( $temp );
		if ( is_wp_error( $valid ) ) {
			wp_delete_file( $temp );
			return self::record_error( $valid );
		}

		// Atomic replace so concurrent requests never read a half-written file.
		if ( ! @rename( $temp, $target ) ) { // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged, WordPress.WP.AlternativeFunctions.rename_rename
			wp_delete_file( $temp );
			return self::record_error( new \WP_Error( 'geoblocker_db_move', __( 'The database was downloaded but could not be moved into place. Check the uploads folder permissions.', 'geoblocker' ) ) );
		}

		$meta = array();
		try {
			$reader = new MaxMindReader( $target );
			$meta   = $reader->metadata();
			$reader->close();
		} catch ( \Throwable $e ) {
			$meta = array();
		}

		update_option(
			self::OPTION,
			array(
				'path'         => $target,
				'source'       => $source,
				'updated'      => time(),
				'build_epoch'  => isset( $meta['build_epoch'] ) ? (int) $meta['build_epoch'] : 0,
				'type'         => isset( $meta['database_type'] ) ? sanitize_text_field( (string) $meta['database_type'] ) : '',
				'size'         => (int) filesize( $target ),
				'last_error'   => '',
				'last_attempt' => time(),
			),
			true
		);

		// Cached results from the previous database may be stale.
		GeoLocator::instance()->cache()->flush();

		return true;
	}

	/**
	 * Run from cron: refresh the database when it is older than 30 days.
	 */
	public static function maybe_auto_update(): void {
		$settings = Settings::all();
		if ( empty( $settings['auto_update_db'] ) || 'custom' === $settings['local_db_source'] || 'local' !== $settings['provider'] ) {
			return;
		}

		$info = self::info();
		// Only auto-update once an administrator has installed a database.
		if ( empty( $info['path'] ) ) {
			return;
		}

		$age          = time() - (int) ( $info['updated'] ?? 0 );
		$last_attempt = time() - (int) ( $info['last_attempt'] ?? 0 );
		if ( $age > 30 * DAY_IN_SECONDS && $last_attempt > DAY_IN_SECONDS ) {
			self::update();
		}
	}

	/**
	 * Validate that a file is a usable country database.
	 *
	 * @param string $file Path.
	 * @return true|\WP_Error
	 */
	public static function validate_file( string $file ) {
		if ( '' === $file || ! is_readable( $file ) ) {
			return new \WP_Error( 'geoblocker_db_missing', __( 'The GeoIP database file does not exist or is not readable.', 'geoblocker' ) );
		}
		try {
			$reader = new MaxMindReader( $file );
			$meta   = $reader->metadata();
			// A lookup exercises the tree and data section.
			$reader->get( 6 === (int) ( $meta['ip_version'] ?? 4 ) ? '2001:4860:4860::8888' : '8.8.8.8' );
			$reader->close();
		} catch ( \Throwable $e ) {
			return new \WP_Error( 'geoblocker_db_invalid', sprintf( /* translators: %s: error message. */ __( 'The GeoIP database is not valid: %s', 'geoblocker' ), $e->getMessage() ) );
		}
		return true;
	}

	/**
	 * Create the storage directory and protect it from direct browsing.
	 *
	 * @return string|\WP_Error
	 */
	private static function prepare_dir() {
		$dir = self::storage_dir();
		if ( ! wp_mkdir_p( $dir ) ) {
			return new \WP_Error( 'geoblocker_db_dir', __( 'Could not create the GeoIP folder in wp-content/uploads. Check the folder permissions.', 'geoblocker' ) );
		}
		// phpcs:disable WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents -- small static files.
		if ( ! file_exists( $dir . '/index.php' ) ) {
			@file_put_contents( $dir . '/index.php', "<?php\n// Silence is golden.\n" ); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
		}
		if ( ! file_exists( $dir . '/.htaccess' ) ) {
			@file_put_contents( $dir . '/.htaccess', "<IfModule mod_authz_core.c>\nRequire all denied\n</IfModule>\n<IfModule !mod_authz_core.c>\nDeny from all\n</IfModule>\n" ); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
		}
		// phpcs:enable
		return $dir;
	}

	/**
	 * Download DB-IP Country Lite (current month, falling back to last month).
	 *
	 * @param string $target Output file.
	 * @return true|\WP_Error
	 */
	private static function download_dbip( string $target ) {
		$last_error = null;
		foreach ( array( 0, 1 ) as $months_ago ) {
			$month = gmdate( 'Y-m', strtotime( gmdate( 'Y-m-01' ) . " -{$months_ago} month" ) );
			$url   = 'https://download.db-ip.com/free/dbip-country-lite-' . $month . '.mmdb.gz';

			$download = download_url( $url, 300 );
			if ( is_wp_error( $download ) ) {
				$last_error = $download;
				continue;
			}

			$result = self::gunzip( $download, $target );
			wp_delete_file( $download );
			return $result;
		}

		return $last_error ?? new \WP_Error( 'geoblocker_dbip', __( 'Could not download the DB-IP database.', 'geoblocker' ) );
	}

	/**
	 * Download MaxMind GeoLite2 Country (tar.gz) with the stored license key.
	 *
	 * @param string $target Output file.
	 * @return true|\WP_Error
	 */
	private static function download_maxmind( string $target ) {
		$key = (string) Settings::get( 'maxmind_license_key' );
		if ( '' === $key ) {
			return new \WP_Error( 'geoblocker_maxmind_key', __( 'Enter your free MaxMind license key first.', 'geoblocker' ) );
		}

		$url = add_query_arg(
			array(
				'edition_id'  => 'GeoLite2-Country',
				'license_key' => rawurlencode( $key ),
				'suffix'      => 'tar.gz',
			),
			'https://download.maxmind.com/app/geoip_download'
		);

		$download = download_url( $url, 300 );
		if ( is_wp_error( $download ) ) {
			// Never echo the URL: it contains the license key.
			return new \WP_Error( 'geoblocker_maxmind_download', __( 'Could not download the MaxMind database. Check that your license key is correct and active.', 'geoblocker' ) );
		}

		$result = self::extract_mmdb_from_tar_gz( $download, $target );
		wp_delete_file( $download );
		return $result;
	}

	/**
	 * Stream-decompress a .gz file.
	 *
	 * @param string $source Gzip file.
	 * @param string $target Output file.
	 * @return true|\WP_Error
	 */
	private static function gunzip( string $source, string $target ) {
		if ( ! function_exists( 'gzopen' ) ) {
			return new \WP_Error( 'geoblocker_zlib', __( 'The PHP zlib extension is required to install the GeoIP database.', 'geoblocker' ) );
		}

		$in = gzopen( $source, 'rb' );
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fopen
		$out = fopen( $target, 'wb' );
		if ( ! $in || ! $out ) {
			return new \WP_Error( 'geoblocker_gunzip', __( 'Could not decompress the GeoIP database.', 'geoblocker' ) );
		}

		while ( ! gzeof( $in ) ) {
			$chunk = gzread( $in, 1048576 );
			if ( false === $chunk ) {
				break;
			}
			fwrite( $out, $chunk ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fwrite
		}
		gzclose( $in );
		fclose( $out ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fclose

		return true;
	}

	/**
	 * Extract the first *.mmdb member of a .tar.gz archive without requiring
	 * the Phar extension.
	 *
	 * @param string $source Archive path.
	 * @param string $target Output file.
	 * @return true|\WP_Error
	 */
	private static function extract_mmdb_from_tar_gz( string $source, string $target ) {
		if ( ! function_exists( 'gzopen' ) ) {
			return new \WP_Error( 'geoblocker_zlib', __( 'The PHP zlib extension is required to install the GeoIP database.', 'geoblocker' ) );
		}

		$in = gzopen( $source, 'rb' );
		if ( ! $in ) {
			return new \WP_Error( 'geoblocker_tar', __( 'Could not open the downloaded archive.', 'geoblocker' ) );
		}

		$error = new \WP_Error( 'geoblocker_tar_nommdb', __( 'No .mmdb file was found in the downloaded archive.', 'geoblocker' ) );

		while ( ! gzeof( $in ) ) {
			$header = gzread( $in, 512 );
			if ( false === $header || strlen( $header ) < 512 || '' === trim( $header, "\0" ) ) {
				break;
			}

			$name   = rtrim( substr( $header, 0, 100 ), "\0" );
			$prefix = rtrim( substr( $header, 345, 155 ), "\0" );
			$size   = octdec( trim( substr( $header, 124, 12 ), "\0 " ) );
			$type   = substr( $header, 156, 1 );
			$path   = '' !== $prefix ? $prefix . '/' . $name : $name;
			$padded = (int) ( ceil( $size / 512 ) * 512 );

			if ( ( '0' === $type || "\0" === $type ) && preg_match( '/\.mmdb$/i', $path ) ) {
				// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fopen
				$out       = fopen( $target, 'wb' );
				$remaining = (int) $size;
				while ( $out && $remaining > 0 ) {
					$chunk = gzread( $in, min( 1048576, $remaining ) );
					if ( false === $chunk || '' === $chunk ) {
						break;
					}
					fwrite( $out, $chunk ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fwrite
					$remaining -= strlen( $chunk );
				}
				if ( $out ) {
					fclose( $out ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fclose
				}
				gzclose( $in );
				return 0 === $remaining ? true : new \WP_Error( 'geoblocker_tar_short', __( 'The downloaded archive is incomplete.', 'geoblocker' ) );
			}

			// Skip this member's data.
			$skip = $padded;
			while ( $skip > 0 ) {
				$chunk = gzread( $in, min( 1048576, $skip ) );
				if ( false === $chunk || '' === $chunk ) {
					break 2;
				}
				$skip -= strlen( $chunk );
			}
		}

		gzclose( $in );
		return $error;
	}

	/**
	 * Store an error for display in the admin and return it.
	 *
	 * @param \WP_Error $error Error.
	 * @return \WP_Error
	 */
	private static function record_error( \WP_Error $error ): \WP_Error {
		$info                 = self::info();
		$info['last_error']   = $error->get_error_message();
		$info['last_attempt'] = time();
		update_option( self::OPTION, $info, true );
		return $error;
	}

	/**
	 * Delete downloaded databases (uninstall).
	 */
	public static function delete_files(): void {
		$dir = self::storage_dir();
		if ( ! is_dir( $dir ) ) {
			return;
		}
		foreach ( array( self::FILENAME, 'index.php', '.htaccess' ) as $file ) {
			if ( file_exists( $dir . '/' . $file ) ) {
				wp_delete_file( $dir . '/' . $file );
			}
		}
		foreach ( (array) glob( $dir . '/*.tmp' ) as $tmp ) {
			wp_delete_file( (string) $tmp );
		}
		@rmdir( $dir ); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged, WordPress.WP.AlternativeFunctions.file_system_operations_rmdir
	}
}
