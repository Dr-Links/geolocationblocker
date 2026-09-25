<?php
/**
 * IP address helpers: validation, normalisation, CIDR and range matching.
 *
 * @package GeoBlocker
 */

namespace GeoBlocker\Ip;

defined( 'ABSPATH' ) || exit;

/**
 * Stateless IP utilities (IPv4 and IPv6).
 */
final class IpUtils {

	/**
	 * Validate an IP address.
	 *
	 * @param string $ip Candidate.
	 */
	public static function is_valid( string $ip ): bool {
		return false !== filter_var( $ip, FILTER_VALIDATE_IP );
	}

	/**
	 * Normalise an IP: trim, strip IPv6 brackets/zone, convert IPv4-mapped IPv6
	 * to plain IPv4 and return the canonical textual form. Returns '' if invalid.
	 *
	 * @param string $ip Raw IP.
	 */
	public static function normalize( string $ip ): string {
		$ip = trim( $ip );

		// Bracketed IPv6, optionally followed by a port.
		if ( '' !== $ip && '[' === $ip[0] ) {
			$end = strpos( $ip, ']' );
			$ip  = false === $end ? '' : substr( $ip, 1, $end - 1 );
		} elseif ( substr_count( $ip, ':' ) === 1 && false !== strpos( $ip, '.' ) ) {
			// IPv4 with a port number appended.
			$ip = substr( $ip, 0, strpos( $ip, ':' ) );
		}

		// Remove IPv6 zone index (fe80::1%eth0).
		$percent = strpos( $ip, '%' );
		if ( false !== $percent ) {
			$ip = substr( $ip, 0, $percent );
		}

		if ( ! self::is_valid( $ip ) ) {
			return '';
		}

		$packed = inet_pton( $ip );
		if ( false === $packed ) {
			return '';
		}

		// IPv4-mapped IPv6 (::ffff:a.b.c.d).
		if ( 16 === strlen( $packed ) && 0 === strncmp( $packed, str_repeat( "\0", 10 ) . "\xff\xff", 12 ) ) {
			$packed = substr( $packed, 12 );
		}

		$text = inet_ntop( $packed );
		return false === $text ? '' : $text;
	}

	/**
	 * Whether the IP is private, loopback, link-local or otherwise reserved
	 * (i.e. cannot be geolocated).
	 *
	 * @param string $ip Normalised IP.
	 */
	public static function is_private_or_reserved( string $ip ): bool {
		if ( ! self::is_valid( $ip ) ) {
			return true;
		}
		return false === filter_var( $ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE );
	}

	/**
	 * Check whether an IP matches a single entry (IP, CIDR or "start-end" range).
	 *
	 * @param string $ip    Normalised IP.
	 * @param string $entry Entry from a list.
	 */
	public static function matches( string $ip, string $entry ): bool {
		$ip_bin = @inet_pton( $ip ); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged -- invalid input returns false.
		if ( false === $ip_bin ) {
			return false;
		}

		if ( false !== strpos( $entry, '/' ) ) {
			return self::in_cidr( $ip_bin, $entry );
		}

		if ( false !== strpos( $entry, '-' ) ) {
			list( $start, $end ) = array_map( 'trim', explode( '-', $entry, 2 ) );
			$start_bin           = @inet_pton( $start ); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
			$end_bin             = @inet_pton( $end ); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
			if ( false === $start_bin || false === $end_bin || strlen( $start_bin ) !== strlen( $ip_bin ) || strlen( $end_bin ) !== strlen( $ip_bin ) ) {
				return false;
			}
			return strcmp( $ip_bin, $start_bin ) >= 0 && strcmp( $ip_bin, $end_bin ) <= 0;
		}

		$entry_bin = @inet_pton( $entry ); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
		return false !== $entry_bin && $entry_bin === $ip_bin;
	}

	/**
	 * Check whether an IP matches any entry in a list.
	 *
	 * @param string   $ip      Normalised IP.
	 * @param string[] $entries List entries.
	 */
	public static function in_list( string $ip, array $entries ): bool {
		if ( '' === $ip || empty( $entries ) ) {
			return false;
		}
		foreach ( $entries as $entry ) {
			if ( self::matches( $ip, (string) $entry ) ) {
				return true;
			}
		}
		return false;
	}

	/**
	 * CIDR match on a packed address.
	 *
	 * @param string $ip_bin Packed IP (inet_pton).
	 * @param string $cidr   CIDR notation.
	 */
	private static function in_cidr( string $ip_bin, string $cidr ): bool {
		list( $subnet, $bits ) = array_pad( explode( '/', $cidr, 2 ), 2, '' );
		$subnet_bin            = @inet_pton( trim( $subnet ) ); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
		if ( false === $subnet_bin || strlen( $subnet_bin ) !== strlen( $ip_bin ) || ! ctype_digit( trim( $bits ) ) ) {
			return false;
		}

		$bits     = (int) $bits;
		$max_bits = strlen( $ip_bin ) * 8;
		if ( $bits < 0 || $bits > $max_bits ) {
			return false;
		}

		$full_bytes = intdiv( $bits, 8 );
		if ( 0 !== strncmp( $ip_bin, $subnet_bin, $full_bytes ) ) {
			return false;
		}

		$remaining = $bits % 8;
		if ( 0 === $remaining ) {
			return true;
		}

		$mask = ( 0xFF << ( 8 - $remaining ) ) & 0xFF;
		return ( ord( $ip_bin[ $full_bytes ] ) & $mask ) === ( ord( $subnet_bin[ $full_bytes ] ) & $mask );
	}

	/**
	 * Validate a single list entry (IP, CIDR or range) and return its canonical form, or '' if invalid.
	 *
	 * @param string $entry Raw entry.
	 */
	public static function canonical_entry( string $entry ): string {
		$entry = trim( $entry );
		if ( '' === $entry ) {
			return '';
		}

		if ( false !== strpos( $entry, '/' ) ) {
			list( $subnet, $bits ) = array_map( 'trim', explode( '/', $entry, 2 ) );
			$subnet                = self::normalize( $subnet );
			if ( '' === $subnet || ! ctype_digit( $bits ) ) {
				return '';
			}
			$max = false !== strpos( $subnet, ':' ) ? 128 : 32;
			if ( (int) $bits > $max ) {
				return '';
			}
			return $subnet . '/' . (int) $bits;
		}

		if ( false !== strpos( $entry, '-' ) ) {
			list( $start, $end ) = array_map( 'trim', explode( '-', $entry, 2 ) );
			$start               = self::normalize( $start );
			$end                 = self::normalize( $end );
			if ( '' === $start || '' === $end || strlen( (string) inet_pton( $start ) ) !== strlen( (string) inet_pton( $end ) ) ) {
				return '';
			}
			if ( strcmp( (string) inet_pton( $start ), (string) inet_pton( $end ) ) > 0 ) {
				return '';
			}
			return $start . '-' . $end;
		}

		return self::normalize( $entry );
	}

	/**
	 * Parse a textarea (one entry per line, commas also accepted, "#" comments allowed).
	 *
	 * @param string $text Raw text.
	 * @return array{valid:string[],invalid:string[]}
	 */
	public static function parse_list( string $text ): array {
		$valid   = array();
		$invalid = array();

		$lines = preg_split( '/[\r\n,]+/', $text );
		foreach ( (array) $lines as $line ) {
			$hash = strpos( $line, '#' );
			if ( false !== $hash ) {
				$line = substr( $line, 0, $hash );
			}
			$line = trim( $line );
			if ( '' === $line ) {
				continue;
			}
			$canonical = self::canonical_entry( $line );
			if ( '' === $canonical ) {
				$invalid[] = $line;
			} else {
				$valid[ $canonical ] = $canonical;
			}
			if ( count( $valid ) >= 5000 ) {
				break;
			}
		}

		return array(
			'valid'   => array_values( $valid ),
			'invalid' => $invalid,
		);
	}

	/**
	 * Anonymise an IP for storage: zero the last octet (IPv4) or last 80 bits (IPv6).
	 *
	 * @param string $ip Normalised IP.
	 */
	public static function anonymize( string $ip ): string {
		if ( function_exists( 'wp_privacy_anonymize_ip' ) ) {
			return wp_privacy_anonymize_ip( $ip );
		}
		$packed = @inet_pton( $ip ); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
		if ( false === $packed ) {
			return '';
		}
		$packed = 4 === strlen( $packed ) ? substr( $packed, 0, 3 ) . "\0" : substr( $packed, 0, 6 ) . str_repeat( "\0", 10 );
		return (string) inet_ntop( $packed );
	}
}
