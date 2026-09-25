<?php
/**
 * Dependency-free reader for MaxMind DB (.mmdb) files.
 *
 * Implements the MaxMind DB File Format Specification 2.0
 * (https://maxmind.github.io/MaxMind-DB/). Works with GeoLite2/GeoIP2 and
 * DB-IP Lite databases. The file is read with fseek()/fread() so it is never
 * loaded fully into memory.
 *
 * @package GeoBlocker
 */

namespace GeoBlocker\Geo;

defined( 'ABSPATH' ) || exit;

/**
 * Minimal MMDB reader.
 */
final class MaxMindReader {

	private const METADATA_MARKER    = "\xAB\xCD\xEFMaxMind.com";
	private const METADATA_MAX_BYTES = 131072;
	private const DATA_SEPARATOR     = 16;

	/**
	 * File handle.
	 *
	 * @var resource|null
	 */
	private $handle;

	/**
	 * Parsed metadata.
	 *
	 * @var array<string,mixed>
	 */
	private array $metadata = array();

	private int $node_count      = 0;
	private int $record_size     = 0;
	private int $ip_version      = 0;
	private int $node_byte_size  = 0;
	private int $search_tree_len = 0;
	private int $ipv4_start      = -1;
	private int $file_size       = 0;

	/**
	 * Base offset for data-section pointers during the current decode.
	 */
	private int $pointer_base = 0;

	/**
	 * Open a database.
	 *
	 * @param string $file Absolute path to the .mmdb file.
	 * @throws \RuntimeException When the file is missing or invalid.
	 */
	public function __construct( string $file ) {
		if ( ! is_readable( $file ) ) {
			throw new \RuntimeException( 'The GeoIP database file is not readable.' );
		}

		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fopen -- binary random access is required.
		$handle = fopen( $file, 'rb' );
		if ( false === $handle ) {
			throw new \RuntimeException( 'The GeoIP database file could not be opened.' );
		}
		$this->handle    = $handle;
		$this->file_size = (int) filesize( $file );

		$this->read_metadata();
	}

	/**
	 * Close the file handle.
	 */
	public function __destruct() {
		$this->close();
	}

	/**
	 * Close the database.
	 */
	public function close(): void {
		if ( is_resource( $this->handle ) ) {
			fclose( $this->handle ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fclose
		}
		$this->handle = null;
	}

	/**
	 * Database metadata.
	 *
	 * @return array<string,mixed>
	 */
	public function metadata(): array {
		return $this->metadata;
	}

	/**
	 * Look up an IP address. Returns the record, or null when not found.
	 *
	 * @param string $ip IP address.
	 * @return mixed
	 * @throws \InvalidArgumentException When the IP is invalid or not supported by the database.
	 * @throws \RuntimeException When the database is corrupt.
	 */
	public function get( string $ip ) {
		$packed = @inet_pton( $ip ); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
		if ( false === $packed ) {
			throw new \InvalidArgumentException( 'Invalid IP address.' );
		}

		$bit_count = strlen( $packed ) * 8;

		if ( 16 === strlen( $packed ) && 4 === $this->ip_version ) {
			throw new \InvalidArgumentException( 'This database only contains IPv4 data.' );
		}

		$node = ( 4 === strlen( $packed ) && 6 === $this->ip_version ) ? $this->ipv4_start_node() : 0;

		for ( $i = 0; $i < $bit_count && $node < $this->node_count; $i++ ) {
			$bit  = 1 & ( ord( $packed[ $i >> 3 ] ) >> ( 7 - ( $i % 8 ) ) );
			$node = $this->read_node( $node, $bit );
		}

		if ( $node === $this->node_count ) {
			return null; // Empty record.
		}

		if ( $node > $this->node_count ) {
			$resolved = ( $node - $this->node_count ) + $this->search_tree_len;
			if ( $resolved >= $this->file_size ) {
				throw new \RuntimeException( 'The GeoIP database search tree is corrupt.' );
			}
			$this->pointer_base = $this->search_tree_len + self::DATA_SEPARATOR;
			list( $record )     = $this->decode( $resolved );
			return $record;
		}

		throw new \RuntimeException( 'Invalid node in the GeoIP database search tree.' );
	}

	/**
	 * Node where IPv4 addresses start in an IPv6 tree (::/96).
	 */
	private function ipv4_start_node(): int {
		if ( $this->ipv4_start >= 0 ) {
			return $this->ipv4_start;
		}
		$node = 0;
		for ( $i = 0; $i < 96 && $node < $this->node_count; $i++ ) {
			$node = $this->read_node( $node, 0 );
		}
		$this->ipv4_start = $node;
		return $node;
	}

	/**
	 * Read one record (left or right) of a search tree node.
	 *
	 * @param int $node  Node number.
	 * @param int $index 0 = left, 1 = right.
	 * @throws \RuntimeException On unsupported record sizes.
	 */
	private function read_node( int $node, int $index ): int {
		$base = $node * $this->node_byte_size;

		switch ( $this->record_size ) {
			case 24:
				$bytes = $this->read( $base + $index * 3, 3 );
				return ( ord( $bytes[0] ) << 16 ) | ( ord( $bytes[1] ) << 8 ) | ord( $bytes[2] );

			case 28:
				$bytes = $this->read( $base + 3 * $index, 4 );
				if ( 0 === $index ) {
					$middle = ( 0xF0 & ord( $bytes[3] ) ) >> 4;
					return ( $middle << 24 ) | ( ord( $bytes[0] ) << 16 ) | ( ord( $bytes[1] ) << 8 ) | ord( $bytes[2] );
				}
				$middle = 0x0F & ord( $bytes[0] );
				return ( $middle << 24 ) | ( ord( $bytes[1] ) << 16 ) | ( ord( $bytes[2] ) << 8 ) | ord( $bytes[3] );

			case 32:
				$bytes = $this->read( $base + $index * 4, 4 );
				$value = unpack( 'N', $bytes );
				return (int) $value[1];
		}

		throw new \RuntimeException( 'Unsupported record size in GeoIP database.' );
	}

	/**
	 * Locate and parse the metadata section.
	 *
	 * @throws \RuntimeException When the metadata is missing or invalid.
	 */
	private function read_metadata(): void {
		if ( $this->file_size <= 0 ) {
			throw new \RuntimeException( 'The GeoIP database file is empty.' );
		}

		// Metadata sits at the very end of the file and is usually a few hundred
		// bytes, so try a small read first and only fall back to the maximum size.
		$pos    = false;
		$length = 0;
		foreach ( array( 8192, self::METADATA_MAX_BYTES ) as $size ) {
			$length = min( $size, $this->file_size );
			$tail   = $this->read( $this->file_size - $length, $length );
			$pos    = strrpos( $tail, self::METADATA_MARKER );
			if ( false !== $pos || $length === $this->file_size ) {
				break;
			}
		}
		if ( false === $pos ) {
			throw new \RuntimeException( 'The file is not a valid MaxMind DB (.mmdb) database.' );
		}

		$start              = $this->file_size - $length + $pos + strlen( self::METADATA_MARKER );
		$this->pointer_base = $start;
		list( $metadata )   = $this->decode( $start );

		if ( ! is_array( $metadata ) || ! isset( $metadata['node_count'], $metadata['record_size'], $metadata['ip_version'] ) ) {
			throw new \RuntimeException( 'The GeoIP database metadata is incomplete.' );
		}

		$this->metadata        = $metadata;
		$this->node_count      = (int) $metadata['node_count'];
		$this->record_size     = (int) $metadata['record_size'];
		$this->ip_version      = (int) $metadata['ip_version'];
		$this->node_byte_size  = intdiv( $this->record_size * 2, 8 );
		$this->search_tree_len = $this->node_count * $this->node_byte_size;

		if ( ! in_array( $this->record_size, array( 24, 28, 32 ), true ) || ! in_array( $this->ip_version, array( 4, 6 ), true ) ) {
			throw new \RuntimeException( 'Unsupported GeoIP database format.' );
		}
		if ( $this->search_tree_len + self::DATA_SEPARATOR > $this->file_size ) {
			throw new \RuntimeException( 'The GeoIP database file is truncated.' );
		}
	}

	/**
	 * Decode a data field at the given absolute offset.
	 *
	 * @param int $offset Absolute file offset.
	 * @return array{0:mixed,1:int} Value and the offset following it.
	 * @throws \RuntimeException On invalid data.
	 */
	private function decode( int $offset ): array {
		$ctrl = ord( $this->read( $offset, 1 ) );
		++$offset;
		$type = $ctrl >> 5;

		// Pointer.
		if ( 1 === $type ) {
			list( $pointer, $offset ) = $this->decode_pointer( $ctrl, $offset );
			list( $value )            = $this->decode( $pointer );
			return array( $value, $offset );
		}

		// Extended type.
		if ( 0 === $type ) {
			$type = 7 + ord( $this->read( $offset, 1 ) );
			++$offset;
			if ( $type < 8 ) {
				throw new \RuntimeException( 'Invalid extended type in GeoIP database.' );
			}
		}

		list( $size, $offset ) = $this->decode_size( $ctrl, $offset );

		switch ( $type ) {
			case 2: // UTF-8 string.
				return array( 0 === $size ? '' : $this->read( $offset, $size ), $offset + $size );

			case 3: // Double.
				$value = unpack( 'E', $this->read( $offset, 8 ) );
				return array( (float) $value[1], $offset + 8 );

			case 4: // Bytes.
				return array( 0 === $size ? '' : $this->read( $offset, $size ), $offset + $size );

			case 5: // Uint16.
			case 6: // Uint32.
			case 9: // Uint64.
			case 10: // Uint128.
				return array( $this->decode_uint( $offset, $size ), $offset + $size );

			case 7: // Map.
				$map = array();
				for ( $i = 0; $i < $size; $i++ ) {
					list( $key, $offset )   = $this->decode( $offset );
					list( $value, $offset ) = $this->decode( $offset );
					$map[ (string) $key ]   = $value;
				}
				return array( $map, $offset );

			case 8: // Int32.
				$value = $this->decode_uint( $offset, $size );
				if ( 4 === $size && $value >= 0x80000000 ) {
					$value -= 0x100000000;
				}
				return array( (int) $value, $offset + $size );

			case 11: // Array.
				$list = array();
				for ( $i = 0; $i < $size; $i++ ) {
					list( $value, $offset ) = $this->decode( $offset );
					$list[]                 = $value;
				}
				return array( $list, $offset );

			case 14: // Boolean (value stored in size).
				return array( 0 !== $size, $offset );

			case 15: // Float.
				$value = unpack( 'G', $this->read( $offset, 4 ) );
				return array( (float) $value[1], $offset + 4 );
		}

		throw new \RuntimeException( 'Unknown data type in GeoIP database.' );
	}

	/**
	 * Decode a pointer.
	 *
	 * @param int $ctrl   Control byte.
	 * @param int $offset Offset after the control byte.
	 * @return array{0:int,1:int} Absolute pointer target and next offset.
	 */
	private function decode_pointer( int $ctrl, int $offset ): array {
		$size  = ( ( $ctrl >> 3 ) & 0x3 ) + 1;
		$bytes = $this->read( $offset, $size );
		$value = 0;

		switch ( $size ) {
			case 1:
				$value = ( ( $ctrl & 0x7 ) << 8 ) | ord( $bytes[0] );
				break;
			case 2:
				$value = 2048 + ( ( ( $ctrl & 0x7 ) << 16 ) | ( ord( $bytes[0] ) << 8 ) | ord( $bytes[1] ) );
				break;
			case 3:
				$value = 526336 + ( ( ( $ctrl & 0x7 ) << 24 ) | ( ord( $bytes[0] ) << 16 ) | ( ord( $bytes[1] ) << 8 ) | ord( $bytes[2] ) );
				break;
			case 4:
				$unpacked = unpack( 'N', $bytes );
				$value    = (int) $unpacked[1];
				break;
		}

		return array( $this->pointer_base + $value, $offset + $size );
	}

	/**
	 * Decode the payload size.
	 *
	 * @param int $ctrl   Control byte.
	 * @param int $offset Current offset.
	 * @return array{0:int,1:int}
	 */
	private function decode_size( int $ctrl, int $offset ): array {
		$size = $ctrl & 0x1F;
		if ( $size < 29 ) {
			return array( $size, $offset );
		}

		$extra = $size - 28;
		$bytes = $this->read( $offset, $extra );
		$value = 0;
		for ( $i = 0; $i < $extra; $i++ ) {
			$value = ( $value << 8 ) | ord( $bytes[ $i ] );
		}

		if ( 29 === $size ) {
			$size = 29 + $value;
		} elseif ( 30 === $size ) {
			$size = 285 + $value;
		} else {
			$size = 65821 + $value;
		}

		return array( $size, $offset + $extra );
	}

	/**
	 * Decode an unsigned big-endian integer. Values too large for PHP_INT
	 * are returned as a float approximation (never needed for country data).
	 *
	 * @param int $offset Offset.
	 * @param int $size   Byte length.
	 * @return int|float
	 */
	private function decode_uint( int $offset, int $size ) {
		if ( 0 === $size ) {
			return 0;
		}
		$bytes = $this->read( $offset, $size );
		$value = 0;
		for ( $i = 0; $i < $size; $i++ ) {
			$byte = ord( $bytes[ $i ] );
			if ( is_int( $value ) && $value > ( PHP_INT_MAX >> 8 ) ) {
				$value = (float) $value;
			}
			$value = is_float( $value ) ? $value * 256 + $byte : ( $value << 8 ) | $byte;
		}
		return $value;
	}

	/**
	 * Read bytes at an absolute offset.
	 *
	 * @param int $offset Offset.
	 * @param int $length Length.
	 * @throws \RuntimeException On short reads.
	 */
	private function read( int $offset, int $length ): string {
		if ( $length <= 0 ) {
			return '';
		}
		if ( ! is_resource( $this->handle ) || $offset < 0 || $offset + $length > $this->file_size ) {
			throw new \RuntimeException( 'Attempted to read beyond the end of the GeoIP database.' );
		}
		fseek( $this->handle, $offset );
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fread
		$data = fread( $this->handle, $length );
		if ( false === $data || strlen( $data ) !== $length ) {
			throw new \RuntimeException( 'Unexpected end of the GeoIP database file.' );
		}
		return $data;
	}
}
