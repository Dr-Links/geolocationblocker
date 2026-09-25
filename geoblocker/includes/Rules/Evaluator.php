<?php
/**
 * Blocking rule engine.
 *
 * @package GeoBlocker
 */

namespace GeoBlocker\Rules;

use GeoBlocker\Geo\GeoLocator;
use GeoBlocker\Geo\GeoResult;
use GeoBlocker\Ip\IpUtils;
use GeoBlocker\Security\Guard;
use GeoBlocker\Settings;

defined( 'ABSPATH' ) || exit;

/**
 * Evaluates the rules in this exact order:
 *
 * 1. Disabled                    → allow
 * 2. IP / CIDR / range whitelist → allow
 * 3. Logged-in admin bypass      → allow
 * 4. Private / reserved IP       → allow (cannot be geolocated)
 * 5. Geolocate (country + continent)
 *    - lookup failed             → allow or block (setting, default allow)
 * 6. Country whitelist           → allow
 * 7. Country blocked             → block
 * 8. Continent blocked           → block
 * 9. Otherwise                   → allow
 */
final class Evaluator {

	/**
	 * Evaluate an IP.
	 *
	 * @param string $ip   Normalised IP.
	 * @param array  $args {
	 *     Optional.
	 *     @type bool $ignore_enabled Evaluate even when GeoBlocker is disabled (admin tester).
	 *     @type bool $check_user     Apply the logged-in administrator bypass (live requests only).
	 *     @type bool $is_visitor     The IP is the current visitor's (allows Cloudflare header lookups).
	 * }
	 */
	public function evaluate( string $ip, array $args = array() ): Decision {
		$args     = array_merge(
			array(
				'ignore_enabled' => false,
				'check_user'     => true,
				'is_visitor'     => true,
			),
			$args
		);
		$settings = Settings::all();
		$ip       = IpUtils::normalize( $ip );

		// 1. Master switch.
		if ( empty( $settings['enabled'] ) && ! $args['ignore_enabled'] ) {
			return new Decision( false, Decision::REASON_DISABLED, $ip );
		}

		// 2. IP whitelist.
		if ( '' !== $ip && IpUtils::in_list( $ip, (array) $settings['whitelist_ips'] ) ) {
			return new Decision( false, Decision::REASON_IP_WHITELISTED, $ip, '', '', true );
		}

		// 3. Administrator bypass.
		if ( $args['check_user'] && ! empty( $settings['admin_bypass'] ) && Guard::current_user_is_admin() ) {
			return new Decision( false, Decision::REASON_ADMIN_BYPASS, $ip, '', '', true );
		}

		// 4. Local/private addresses have no location.
		if ( '' !== $ip && IpUtils::is_private_or_reserved( $ip ) ) {
			return new Decision( false, Decision::REASON_PRIVATE_IP, $ip );
		}

		// 5. Geolocate.
		$locator = GeoLocator::instance();
		$geo     = '' === $ip
			? GeoResult::failed( $locator->get_active_provider()->get_id(), 'The visitor IP address could not be determined.' )
			: ( $args['is_visitor'] ? $locator->lookup_visitor( $ip ) : $locator->lookup( $ip ) );

		if ( ! $geo->success ) {
			$block = 'block' === $settings['on_failure'];
			return new Decision(
				$block,
				$block ? Decision::REASON_LOOKUP_FAILED_BLOCK : Decision::REASON_LOOKUP_FAILED_ALLOW,
				$ip,
				'',
				'',
				false,
				$geo->provider,
				$geo->error,
				$geo->from_cache
			);
		}

		$country   = $geo->country_code;
		$continent = $geo->continent_code;
		$mode      = (string) $settings['mode'];
		$make      = static function ( bool $blocked, string $reason, bool $whitelisted = false ) use ( $ip, $country, $continent, $geo ): Decision {
			return new Decision( $blocked, $reason, $ip, $country, $continent, $whitelisted, $geo->provider, '', $geo->from_cache );
		};

		// 6. Country whitelist overrides country and continent blocks.
		if ( in_array( $country, (array) $settings['whitelist_countries'], true ) ) {
			return $make( false, Decision::REASON_COUNTRY_WHITELISTED, true );
		}

		// 7. Country block.
		if ( in_array( $mode, array( Settings::MODE_COUNTRIES, Settings::MODE_BOTH ), true )
			&& in_array( $country, (array) $settings['blocked_countries'], true ) ) {
			return $make( true, Decision::REASON_COUNTRY_BLOCKED );
		}

		// 8. Continent block.
		if ( '' !== $continent
			&& in_array( $mode, array( Settings::MODE_CONTINENTS, Settings::MODE_BOTH ), true )
			&& in_array( $continent, (array) $settings['blocked_continents'], true ) ) {
			return $make( true, Decision::REASON_CONTINENT_BLOCKED );
		}

		// 9. Allowed.
		return $make( false, Decision::REASON_NOT_BLOCKED );
	}
}
