<?php
/**
 * Logs table (WP_List_Table).
 *
 * @package GeoBlocker
 */

namespace GeoBlocker\Admin;

use GeoBlocker\Geo\Countries;
use GeoBlocker\Logging\Logger;
use GeoBlocker\Rules\Decision;

defined( 'ABSPATH' ) || exit;

if ( ! class_exists( 'WP_List_Table' ) ) {
	require_once ABSPATH . 'wp-admin/includes/class-wp-list-table.php';
}

/**
 * Paginated, searchable, filterable list of log entries.
 */
final class LogsListTable extends \WP_List_Table {

	/**
	 * Constructor.
	 */
	public function __construct() {
		parent::__construct(
			array(
				'singular' => 'geoblocker-log',
				'plural'   => 'geoblocker-logs',
				'ajax'     => false,
			)
		);
	}

	/**
	 * Columns.
	 *
	 * @return array<string,string>
	 */
	public function get_columns() {
		return array(
			'created_at'   => __( 'Date / time', 'geoblocker' ),
			'ip'           => __( 'IP address', 'geoblocker' ),
			'country_code' => __( 'Country', 'geoblocker' ),
			'continent'    => __( 'Continent', 'geoblocker' ),
			'request_url'  => __( 'Requested URL', 'geoblocker' ),
			'user_agent'   => __( 'User agent', 'geoblocker' ),
			'reason'       => __( 'Reason', 'geoblocker' ),
		);
	}

	/**
	 * Sortable columns.
	 *
	 * @return array<string,array{0:string,1:bool}>
	 */
	protected function get_sortable_columns() {
		return array(
			'created_at'   => array( 'created_at', true ),
			'ip'           => array( 'ip', false ),
			'country_code' => array( 'country_code', false ),
			'reason'       => array( 'reason', false ),
		);
	}

	/**
	 * Read a sanitized GET parameter.
	 *
	 * @param string $key Key.
	 */
	private function param( string $key ): string {
		// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- read-only filtering of a list.
		return isset( $_GET[ $key ] ) ? sanitize_text_field( wp_unslash( $_GET[ $key ] ) ) : '';
	}

	/**
	 * Load items.
	 */
	public function prepare_items() {
		$per_page = $this->get_items_per_page( 'geoblocker_logs_per_page', 20 );
		$country  = strtoupper( $this->param( 'country' ) );
		$reason   = sanitize_key( $this->param( 'reason' ) );

		$result = Logger::query(
			array(
				'search'   => $this->param( 's' ),
				'country'  => Countries::is_valid( $country ) ? $country : '',
				'reason'   => array_key_exists( $reason, Decision::reason_labels() ) ? $reason : '',
				'orderby'  => sanitize_key( $this->param( 'orderby' ) ),
				'order'    => $this->param( 'order' ),
				'per_page' => $per_page,
				'page'     => $this->get_pagenum(),
			)
		);

		$this->items           = $result['items'];
		$this->_column_headers = array( $this->get_columns(), array(), $this->get_sortable_columns(), 'created_at' );

		$this->set_pagination_args(
			array(
				'total_items' => $result['total'],
				'per_page'    => $per_page,
				'total_pages' => (int) ceil( $result['total'] / $per_page ),
			)
		);
	}

	/**
	 * Filter dropdowns.
	 *
	 * @param string $which top|bottom.
	 */
	protected function extra_tablenav( $which ) {
		if ( 'top' !== $which ) {
			return;
		}
		$country = strtoupper( $this->param( 'country' ) );
		$reason  = sanitize_key( $this->param( 'reason' ) );
		?>
		<div class="alignleft actions">
			<label class="screen-reader-text" for="geoblocker-filter-country"><?php esc_html_e( 'Filter by country', 'geoblocker' ); ?></label>
			<select name="country" id="geoblocker-filter-country">
				<option value=""><?php esc_html_e( 'All countries', 'geoblocker' ); ?></option>
				<?php foreach ( Logger::distinct_countries() as $code ) : ?>
					<option value="<?php echo esc_attr( $code ); ?>" <?php selected( $country, $code ); ?>><?php echo esc_html( Countries::country_name( $code ) ); ?></option>
				<?php endforeach; ?>
			</select>
			<label class="screen-reader-text" for="geoblocker-filter-reason"><?php esc_html_e( 'Filter by reason', 'geoblocker' ); ?></label>
			<select name="reason" id="geoblocker-filter-reason">
				<option value=""><?php esc_html_e( 'All reasons', 'geoblocker' ); ?></option>
				<?php
				foreach ( array( Decision::REASON_COUNTRY_BLOCKED, Decision::REASON_CONTINENT_BLOCKED, Decision::REASON_LOOKUP_FAILED_BLOCK, Decision::REASON_LOOKUP_FAILED_ALLOW ) as $code ) :
					$labels = Decision::reason_labels();
					?>
					<option value="<?php echo esc_attr( $code ); ?>" <?php selected( $reason, $code ); ?>><?php echo esc_html( $labels[ $code ] ); ?></option>
				<?php endforeach; ?>
			</select>
			<?php submit_button( __( 'Filter', 'geoblocker' ), '', 'filter_action', false ); ?>
		</div>
		<?php
	}

	/**
	 * Empty state.
	 */
	public function no_items() {
		esc_html_e( 'No log entries found.', 'geoblocker' );
	}

	/**
	 * Default column output (everything escaped).
	 *
	 * @param array<string,mixed> $item        Row.
	 * @param string              $column_name Column.
	 * @return string
	 */
	protected function column_default( $item, $column_name ) {
		switch ( $column_name ) {
			case 'created_at':
				$timestamp = strtotime( (string) $item['created_at'] . ' UTC' );
				return esc_html( $timestamp ? wp_date( get_option( 'date_format' ) . ' ' . get_option( 'time_format' ), $timestamp ) : (string) $item['created_at'] );

			case 'ip':
				return '<code>' . esc_html( (string) $item['ip'] ) . '</code>';

			case 'country_code':
				$code = (string) $item['country_code'];
				return '' === $code ? '&mdash;' : esc_html( Countries::country_name( $code ) . ' (' . $code . ')' );

			case 'continent':
				$code = (string) $item['continent_code'];
				return '' === $code ? '&mdash;' : esc_html( Countries::continent_name( $code ) );

			case 'request_url':
				return '<span class="geoblocker-truncate" title="' . esc_attr( (string) $item['request_url'] ) . '">' . esc_html( (string) $item['request_url'] ) . '</span>';

			case 'user_agent':
				return '<span class="geoblocker-truncate" title="' . esc_attr( (string) $item['user_agent'] ) . '">' . esc_html( (string) $item['user_agent'] ) . '</span>';

			case 'reason':
				$labels = Decision::reason_labels();
				$class  = ! empty( $item['blocked'] ) ? 'geoblocker-badge--blocked' : 'geoblocker-badge--allowed';
				return '<span class="geoblocker-badge ' . esc_attr( $class ) . '">' . esc_html( $labels[ (string) $item['reason'] ] ?? (string) $item['reason'] ) . '</span>';
		}
		return '';
	}
}
