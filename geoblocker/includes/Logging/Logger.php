<?php
/**
 * Block log storage.
 *
 * @package GeoBlocker
 */

namespace GeoBlocker\Logging;

use GeoBlocker\Ip\IpUtils;
use GeoBlocker\Rules\Decision;
use GeoBlocker\Settings;

defined( 'ABSPATH' ) || exit;

/**
 * Writes and queries the {prefix}geoblocker_log table.
 *
 * Only the fields needed to audit a block are stored. Query strings are
 * stripped by default (they often contain personal data such as e-mails or
 * tokens), user agents are truncated and IPs can optionally be anonymised.
 */
final class Logger {

	public const TABLE_SUFFIX = 'geoblocker_log';

	/**
	 * Maximum number of rows kept regardless of retention (protects against floods).
	 */
	public const MAX_ROWS = 100000;

	/**
	 * Full table name for the current site.
	 */
	public static function table(): string {
		global $wpdb;
		return $wpdb->prefix . self::TABLE_SUFFIX;
	}

	/**
	 * Create or upgrade the table.
	 */
	public static function create_table(): void {
		global $wpdb;

		require_once ABSPATH . 'wp-admin/includes/upgrade.php';

		$table   = self::table();
		$charset = $wpdb->get_charset_collate();

		// dbDelta formatting rules: two spaces after PRIMARY KEY, one field per line.
		$sql = "CREATE TABLE {$table} (
  id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  created_at datetime NOT NULL,
  ip varchar(45) NOT NULL DEFAULT '',
  country_code char(2) NOT NULL DEFAULT '',
  continent_code char(2) NOT NULL DEFAULT '',
  request_url varchar(2048) NOT NULL DEFAULT '',
  user_agent varchar(255) NOT NULL DEFAULT '',
  reason varchar(32) NOT NULL DEFAULT '',
  blocked tinyint(1) unsigned NOT NULL DEFAULT 1,
  PRIMARY KEY  (id),
  KEY created_at (created_at),
  KEY ip (ip),
  KEY country_code (country_code),
  KEY reason (reason)
) {$charset};";

		dbDelta( $sql );
	}

	/**
	 * Drop the table (uninstall).
	 */
	public static function drop_table(): void {
		global $wpdb;
		$table = self::table();
		$wpdb->query( "DROP TABLE IF EXISTS `{$table}`" ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared, WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.DirectDatabaseQuery.SchemaChange -- table name is built from $wpdb->prefix and a constant.
	}

	/**
	 * Record a decision if logging is enabled.
	 *
	 * @param Decision $decision Decision.
	 */
	public static function log( Decision $decision ): void {
		global $wpdb;

		$settings = Settings::all();
		if ( empty( $settings['logging'] ) ) {
			return;
		}
		if ( ! $decision->blocked && ! ( $decision->lookup_failed() && ! empty( $settings['log_failures'] ) ) ) {
			return;
		}

		// Flood protection: with a persistent object cache, log the same IP/reason at most once per 30 seconds.
		if ( wp_using_ext_object_cache() && ! wp_cache_add( 'log_' . md5( $decision->ip . '|' . $decision->reason ), 1, 'geoblocker', 30 ) ) {
			return;
		}

		$ip = $decision->ip;
		if ( ! empty( $settings['log_anonymize_ip'] ) && '' !== $ip ) {
			$ip = IpUtils::anonymize( $ip );
		}

		$wpdb->insert( // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery
			self::table(),
			array(
				'created_at'     => current_time( 'mysql', true ),
				'ip'             => substr( $ip, 0, 45 ),
				'country_code'   => substr( $decision->country, 0, 2 ),
				'continent_code' => substr( $decision->continent, 0, 2 ),
				'request_url'    => self::request_url( ! empty( $settings['log_query_strings'] ) ),
				'user_agent'     => self::user_agent(),
				'reason'         => substr( $decision->reason, 0, 32 ),
				'blocked'        => $decision->blocked ? 1 : 0,
			),
			array( '%s', '%s', '%s', '%s', '%s', '%s', '%s', '%d' )
		);
	}

	/**
	 * Current request path (and optionally query string), without the host.
	 *
	 * @param bool $with_query Keep the query string.
	 */
	private static function request_url( bool $with_query ): string {
		$uri = isset( $_SERVER['REQUEST_URI'] ) ? esc_url_raw( wp_unslash( $_SERVER['REQUEST_URI'] ) ) : '';  // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized
		if ( ! $with_query ) {
			$uri = (string) strtok( $uri, '?#' );
		}
		return substr( $uri, 0, 2048 );
	}

	/**
	 * Truncated user agent.
	 */
	private static function user_agent(): string {
		$ua = isset( $_SERVER['HTTP_USER_AGENT'] ) ? sanitize_text_field( wp_unslash( $_SERVER['HTTP_USER_AGENT'] ) ) : ''; // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized
		return mb_substr( $ua, 0, 255 );
	}

	/**
	 * Query logs.
	 *
	 * @param array $args {
	 *     @type string $search   Free text (IP, URL, user agent).
	 *     @type string $country  Country code filter.
	 *     @type string $reason   Reason filter.
	 *     @type string $orderby  created_at|ip|country_code|reason.
	 *     @type string $order    ASC|DESC.
	 *     @type int    $per_page Rows per page.
	 *     @type int    $page     1-based page.
	 * }
	 * @return array{items:array<int,array<string,mixed>>,total:int}
	 */
	public static function query( array $args ): array {
		global $wpdb;

		$args = array_merge(
			array(
				'search'   => '',
				'country'  => '',
				'reason'   => '',
				'orderby'  => 'created_at',
				'order'    => 'DESC',
				'per_page' => 20,
				'page'     => 1,
			),
			$args
		);

		$where  = array( '1=1' );
		$params = array();

		if ( '' !== $args['search'] ) {
			$like     = '%' . $wpdb->esc_like( $args['search'] ) . '%';
			$where[]  = '(ip LIKE %s OR request_url LIKE %s OR user_agent LIKE %s)';
			$params[] = $like;
			$params[] = $like;
			$params[] = $like;
		}
		if ( '' !== $args['country'] ) {
			$where[]  = 'country_code = %s';
			$params[] = $args['country'];
		}
		if ( '' !== $args['reason'] ) {
			$where[]  = 'reason = %s';
			$params[] = $args['reason'];
		}

		// Whitelisted identifiers only – never interpolate user input.
		$orderby  = in_array( $args['orderby'], array( 'created_at', 'ip', 'country_code', 'continent_code', 'reason' ), true ) ? $args['orderby'] : 'created_at';
		$order    = 'ASC' === strtoupper( (string) $args['order'] ) ? 'ASC' : 'DESC';
		$per_page = max( 1, min( 200, (int) $args['per_page'] ) );
		$offset   = max( 0, ( (int) $args['page'] - 1 ) * $per_page );

		$table     = self::table();
		$where_sql = implode( ' AND ', $where );

		// phpcs:disable WordPress.DB.PreparedSQL.InterpolatedNotPrepared, WordPress.DB.PreparedSQL.NotPrepared, WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.PreparedSQLPlaceholders.UnfinishedPrepare -- $table and $where_sql only contain trusted identifiers and placeholders.
		$count_sql = "SELECT COUNT(*) FROM {$table} WHERE {$where_sql}";
		$total     = (int) ( $params ? $wpdb->get_var( $wpdb->prepare( $count_sql, $params ) ) : $wpdb->get_var( $count_sql ) );

		$rows_sql = "SELECT id, created_at, ip, country_code, continent_code, request_url, user_agent, reason, blocked FROM {$table} WHERE {$where_sql} ORDER BY {$orderby} {$order}, id {$order} LIMIT %d OFFSET %d";
		$items    = $wpdb->get_results( $wpdb->prepare( $rows_sql, array_merge( $params, array( $per_page, $offset ) ) ), ARRAY_A );
		// phpcs:enable

		return array(
			'items' => is_array( $items ) ? $items : array(),
			'total' => $total,
		);
	}

	/**
	 * Distinct country codes present in the log (for the filter dropdown).
	 *
	 * @return string[]
	 */
	public static function distinct_countries(): array {
		global $wpdb;
		$table = self::table();
		$codes = $wpdb->get_col( "SELECT DISTINCT country_code FROM {$table} WHERE country_code <> '' ORDER BY country_code ASC LIMIT 300" ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared, WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching
		return is_array( $codes ) ? $codes : array();
	}

	/**
	 * Total rows.
	 */
	public static function count(): int {
		global $wpdb;
		$table = self::table();
		return (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$table}" ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared, WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching
	}

	/**
	 * Delete every log entry.
	 */
	public static function clear(): void {
		global $wpdb;
		$table = self::table();
		$wpdb->query( "TRUNCATE TABLE {$table}" ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared, WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching
	}

	/**
	 * Apply retention and the hard row cap. Run daily by cron.
	 */
	public static function prune(): void {
		global $wpdb;
		$table = self::table();
		$days  = (int) Settings::get( 'log_retention' );

		// phpcs:disable WordPress.DB.PreparedSQL.InterpolatedNotPrepared, WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching
		if ( $days > 0 ) {
			$cutoff = gmdate( 'Y-m-d H:i:s', time() - $days * DAY_IN_SECONDS );
			$wpdb->query( $wpdb->prepare( "DELETE FROM {$table} WHERE created_at < %s", $cutoff ) );
		}

		// Hard cap: keep only the newest MAX_ROWS rows.
		$threshold = $wpdb->get_var( $wpdb->prepare( "SELECT id FROM {$table} ORDER BY id DESC LIMIT 1 OFFSET %d", self::MAX_ROWS ) );
		if ( null !== $threshold ) {
			$wpdb->query( $wpdb->prepare( "DELETE FROM {$table} WHERE id <= %d", (int) $threshold ) );
		}
		// phpcs:enable
	}
}
