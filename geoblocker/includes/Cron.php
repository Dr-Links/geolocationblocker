<?php
/**
 * Scheduled maintenance tasks.
 *
 * @package GeoBlocker
 */

namespace GeoBlocker;

use GeoBlocker\Geo\DatabaseUpdater;
use GeoBlocker\Ip\CloudflareRanges;
use GeoBlocker\Logging\Logger;

defined( 'ABSPATH' ) || exit;

/**
 * Daily: prune logs. Weekly: refresh GeoIP database (if older than 30 days) and Cloudflare ranges.
 */
final class Cron {

	public const DAILY_HOOK  = 'geoblocker_daily_maintenance';
	public const WEEKLY_HOOK = 'geoblocker_weekly_maintenance';

	/**
	 * Register callbacks.
	 */
	public static function register(): void {
		add_action( self::DAILY_HOOK, array( self::class, 'daily' ) );
		add_action( self::WEEKLY_HOOK, array( self::class, 'weekly' ) );
	}

	/**
	 * Schedule events if missing.
	 */
	public static function schedule(): void {
		if ( ! wp_next_scheduled( self::DAILY_HOOK ) ) {
			wp_schedule_event( time() + HOUR_IN_SECONDS, 'daily', self::DAILY_HOOK );
		}
		if ( ! wp_next_scheduled( self::WEEKLY_HOOK ) ) {
			wp_schedule_event( time() + DAY_IN_SECONDS, 'weekly', self::WEEKLY_HOOK );
		}
	}

	/**
	 * Remove events.
	 */
	public static function unschedule(): void {
		wp_clear_scheduled_hook( self::DAILY_HOOK );
		wp_clear_scheduled_hook( self::WEEKLY_HOOK );
	}

	/**
	 * Daily task.
	 */
	public static function daily(): void {
		Logger::prune();
	}

	/**
	 * Weekly task.
	 */
	public static function weekly(): void {
		DatabaseUpdater::maybe_auto_update();

		if ( Settings::get( 'trust_cloudflare' ) ) {
			CloudflareRanges::refresh();
		}
	}
}
