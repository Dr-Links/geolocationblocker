/**
 * GeoBlocker admin UI.
 *
 * Vanilla JavaScript, no dependencies. Loaded only on the GeoBlocker admin
 * screen. All dynamic values are inserted with textContent (never innerHTML)
 * to rule out XSS from log data or API responses.
 */
( function () {
	'use strict';

	var config = window.geoblockerAdmin || {};
	var i18n = config.i18n || {};

	function t( key, fallback ) {
		return Object.prototype.hasOwnProperty.call( i18n, key ) ? i18n[ key ] : fallback;
	}

	function el( tag, className, text ) {
		var node = document.createElement( tag );
		if ( className ) {
			node.className = className;
		}
		if ( text !== undefined && text !== null ) {
			node.textContent = String( text );
		}
		return node;
	}

	function normalize( text ) {
		var value = String( text ).toLowerCase();
		if ( value.normalize ) {
			value = value.normalize( 'NFD' ).replace( /[̀-ͯ]/g, '' );
		}
		return value;
	}

	/* ------------------------------------------------------------------
	 * Searchable multi-country picker (enhances a <select multiple>).
	 * ------------------------------------------------------------------ */
	var pickerCount = 0;

	function CountryPicker( root ) {
		this.root = root;
		this.select = root.querySelector( 'select' );
		if ( ! this.select ) {
			return;
		}
		pickerCount++;
		this.id = 'geoblocker-picker-' + pickerCount;
		this.options = Array.prototype.map.call( this.select.options, function ( option ) {
			return { value: option.value, label: option.textContent, search: normalize( option.textContent ), option: option };
		} );
		this.activeIndex = -1;
		this.filtered = [];
		this.build();
		this.renderChips();
	}

	CountryPicker.prototype.build = function () {
		var self = this;

		this.select.hidden = true;
		this.select.setAttribute( 'aria-hidden', 'true' );
		this.select.tabIndex = -1;

		this.wrapper = el( 'div', 'geoblocker-picker' );
		this.chips = el( 'div', 'geoblocker-picker__chips' );
		this.chips.setAttribute( 'aria-live', 'polite' );

		var search = el( 'div', 'geoblocker-picker__search' );
		this.input = el( 'input', 'regular-text' );
		this.input.type = 'search';
		this.input.placeholder = t( 'searchCountries', 'Search countries…' );
		this.input.setAttribute( 'role', 'combobox' );
		this.input.setAttribute( 'aria-autocomplete', 'list' );
		this.input.setAttribute( 'aria-expanded', 'false' );
		this.input.setAttribute( 'aria-controls', this.id + '-list' );
		this.input.setAttribute( 'aria-label', t( 'searchCountries', 'Search countries…' ) );
		this.input.autocomplete = 'off';

		this.list = el( 'ul', 'geoblocker-picker__list' );
		this.list.id = this.id + '-list';
		this.list.setAttribute( 'role', 'listbox' );
		this.list.setAttribute( 'aria-multiselectable', 'true' );
		this.list.hidden = true;

		search.appendChild( this.input );
		search.appendChild( this.list );
		this.wrapper.appendChild( this.chips );
		this.wrapper.appendChild( search );
		this.root.appendChild( this.wrapper );

		this.input.addEventListener( 'input', function () {
			self.open();
		} );
		this.input.addEventListener( 'focus', function () {
			self.open();
		} );
		this.input.addEventListener( 'keydown', function ( event ) {
			self.onKeyDown( event );
		} );
		document.addEventListener( 'mousedown', function ( event ) {
			if ( ! self.wrapper.contains( event.target ) ) {
				self.close();
			}
		} );
		// Prevent the input blur from closing the list before a click registers.
		this.list.addEventListener( 'mousedown', function ( event ) {
			event.preventDefault();
		} );
	};

	CountryPicker.prototype.open = function () {
		var query = normalize( this.input.value.trim() );
		var self = this;

		this.filtered = this.options.filter( function ( item ) {
			return ! query || item.search.indexOf( query ) !== -1 || item.value.toLowerCase() === query;
		} );

		this.list.textContent = '';
		if ( ! this.filtered.length ) {
			this.list.appendChild( el( 'li', 'geoblocker-picker__none', t( 'noResults', 'No matching countries' ) ) );
		}

		this.filtered.forEach( function ( item, index ) {
			var li = el( 'li', 'geoblocker-picker__option' + ( item.option.selected ? ' is-selected' : '' ), item.label );
			li.id = self.id + '-opt-' + item.value;
			li.setAttribute( 'role', 'option' );
			li.setAttribute( 'aria-selected', item.option.selected ? 'true' : 'false' );
			li.addEventListener( 'click', function () {
				self.toggle( item );
				self.input.focus();
			} );
			li.addEventListener( 'mousemove', function () {
				self.setActive( index );
			} );
			self.list.appendChild( li );
		} );

		this.activeIndex = this.filtered.length ? 0 : -1;
		this.highlight();
		this.list.hidden = false;
		this.input.setAttribute( 'aria-expanded', 'true' );
	};

	CountryPicker.prototype.close = function () {
		this.list.hidden = true;
		this.input.setAttribute( 'aria-expanded', 'false' );
		this.input.removeAttribute( 'aria-activedescendant' );
	};

	CountryPicker.prototype.setActive = function ( index ) {
		this.activeIndex = index;
		this.highlight();
	};

	CountryPicker.prototype.highlight = function () {
		var items = this.list.querySelectorAll( '.geoblocker-picker__option' );
		var self = this;
		Array.prototype.forEach.call( items, function ( li, index ) {
			var active = index === self.activeIndex;
			li.classList.toggle( 'is-active', active );
			if ( active ) {
				self.input.setAttribute( 'aria-activedescendant', li.id );
				if ( li.scrollIntoView ) {
					li.scrollIntoView( { block: 'nearest' } );
				}
			}
		} );
	};

	CountryPicker.prototype.onKeyDown = function ( event ) {
		var max = this.filtered.length - 1;
		switch ( event.key ) {
			case 'ArrowDown':
				event.preventDefault();
				if ( this.list.hidden ) {
					this.open();
					return;
				}
				this.setActive( Math.min( max, this.activeIndex + 1 ) );
				break;
			case 'ArrowUp':
				event.preventDefault();
				this.setActive( Math.max( 0, this.activeIndex - 1 ) );
				break;
			case 'Enter':
				// Never submit the settings form from the search box.
				event.preventDefault();
				if ( ! this.list.hidden && this.activeIndex >= 0 && this.filtered[ this.activeIndex ] ) {
					this.toggle( this.filtered[ this.activeIndex ] );
				}
				break;
			case 'Escape':
				if ( ! this.list.hidden ) {
					event.preventDefault();
					this.close();
				}
				break;
			case 'Backspace':
				if ( '' === this.input.value ) {
					var selected = this.options.filter( function ( item ) {
						return item.option.selected;
					} );
					if ( selected.length ) {
						this.setSelected( selected[ selected.length - 1 ], false );
					}
				}
				break;
		}
	};

	CountryPicker.prototype.toggle = function ( item ) {
		this.setSelected( item, ! item.option.selected );
		var keepIndex = this.activeIndex;
		this.open();
		this.setActive( Math.min( keepIndex, this.filtered.length - 1 ) );
	};

	CountryPicker.prototype.setSelected = function ( item, state ) {
		item.option.selected = state;
		this.select.dispatchEvent( new Event( 'change', { bubbles: true } ) );
		this.renderChips();
	};

	CountryPicker.prototype.renderChips = function () {
		var self = this;
		var selected = this.options.filter( function ( item ) {
			return item.option.selected;
		} );

		this.chips.textContent = '';

		if ( ! selected.length ) {
			this.chips.appendChild( el( 'span', 'geoblocker-picker__empty', t( 'noneSelected', 'No countries selected.' ) ) );
			return;
		}

		selected
			.slice()
			.sort( function ( a, b ) {
				return a.label.localeCompare( b.label );
			} )
			.forEach( function ( item ) {
				var chip = el( 'span', 'geoblocker-chip' );
				chip.appendChild( el( 'span', '', item.label ) );
				var remove = el( 'button', 'geoblocker-chip__remove', '×' );
				remove.type = 'button';
				remove.setAttribute( 'aria-label', t( 'remove', 'Remove' ) + ' ' + item.label );
				remove.addEventListener( 'click', function () {
					self.setSelected( item, false );
					self.input.focus();
				} );
				chip.appendChild( remove );
				self.chips.appendChild( chip );
			} );

		var count = el( 'span', 'description', selected.length + ' ' + t( 'selected', 'selected' ) );
		this.chips.appendChild( count );

		if ( selected.length > 1 ) {
			var clear = el( 'button', 'button-link geoblocker-picker__clear', t( 'clearAll', 'Clear all' ) );
			clear.type = 'button';
			clear.addEventListener( 'click', function () {
				selected.forEach( function ( item ) {
					item.option.selected = false;
				} );
				self.renderChips();
				self.input.focus();
			} );
			this.chips.appendChild( clear );
		}
	};

	/* ------------------------------------------------------------------
	 * Conditional sections.
	 * ------------------------------------------------------------------ */
	function checkedValue( container ) {
		var checked = container ? container.querySelector( 'input[type="radio"]:checked' ) : null;
		return checked ? checked.value : '';
	}

	function initMode() {
		var mode = document.querySelector( '[data-geoblocker-mode]' );
		if ( ! mode ) {
			return;
		}
		function update() {
			var value = checkedValue( mode );
			var countries = document.querySelector( '[data-geoblocker-section="countries"]' );
			var continents = document.querySelector( '[data-geoblocker-section="continents"]' );
			if ( countries ) {
				countries.classList.toggle( 'is-inactive', 'continents' === value );
			}
			if ( continents ) {
				continents.classList.toggle( 'is-inactive', 'countries' === value );
			}
		}
		mode.addEventListener( 'change', update );
		update();
	}

	function initAction() {
		var action = document.querySelector( '[data-geoblocker-action]' );
		if ( ! action ) {
			return;
		}
		var panels = document.querySelectorAll( '[data-geoblocker-action-panel]' );
		function update() {
			var value = checkedValue( action );
			Array.prototype.forEach.call( panels, function ( panel ) {
				var targets = panel.getAttribute( 'data-geoblocker-action-panel' ).split( ' ' );
				panel.hidden = targets.indexOf( value ) === -1;
			} );
		}
		action.addEventListener( 'change', update );
		update();
	}

	function initProxyHeader() {
		var select = document.querySelector( '[data-geoblocker-proxy-header]' );
		var row = document.querySelector( '[data-geoblocker-custom-header]' );
		if ( ! select || ! row ) {
			return;
		}
		function update() {
			row.hidden = 'custom' !== select.value;
		}
		select.addEventListener( 'change', update );
		update();
	}

	function initConfirmAndBusy() {
		Array.prototype.forEach.call( document.querySelectorAll( 'form[data-geoblocker-confirm]' ), function ( form ) {
			form.addEventListener( 'submit', function ( event ) {
				// eslint-disable-next-line no-alert
				if ( ! window.confirm( t( 'confirmClear', 'Are you sure?' ) ) ) {
					event.preventDefault();
				}
			} );
		} );
		Array.prototype.forEach.call( document.querySelectorAll( 'form[data-geoblocker-busy]' ), function ( form ) {
			form.addEventListener( 'submit', function () {
				var button = form.querySelector( 'button[type="submit"]' );
				if ( button ) {
					button.disabled = true;
					button.textContent = form.getAttribute( 'data-geoblocker-busy' );
				}
			} );
		} );
	}

	/* ------------------------------------------------------------------
	 * Testing tool.
	 * ------------------------------------------------------------------ */
	function initTester() {
		var form = document.querySelector( '[data-geoblocker-tester]' );
		var output = document.querySelector( '[data-geoblocker-test-result]' );
		if ( ! form || ! output ) {
			return;
		}
		var input = form.querySelector( 'input' );
		var buttons = form.querySelectorAll( 'button' );
		var currentButton = form.querySelector( '[data-geoblocker-test-current]' );

		function setBusy( busy ) {
			Array.prototype.forEach.call( buttons, function ( button ) {
				button.disabled = busy;
			} );
			form.setAttribute( 'aria-busy', busy ? 'true' : 'false' );
		}

		function row( table, label, value ) {
			var tr = el( 'tr' );
			var th = el( 'th', '', label );
			th.scope = 'row';
			var td = el( 'td' );
			if ( value instanceof Node ) {
				td.appendChild( value );
			} else {
				td.textContent = value === '' || value === null || value === undefined ? '—' : String( value );
			}
			tr.appendChild( th );
			tr.appendChild( td );
			table.appendChild( tr );
		}

		function render( data ) {
			output.textContent = '';

			var verdict = el( 'div', 'geoblocker-verdict ' + ( data.blocked ? 'geoblocker-verdict--blocked' : 'geoblocker-verdict--allowed' ) );
			verdict.appendChild( el( 'span', 'dashicons ' + ( data.blocked ? 'dashicons-dismiss' : 'dashicons-yes-alt' ) ) );
			verdict.appendChild( el( 'span', '', ( data.blocked ? t( 'blocked', 'Blocked' ) : t( 'allowed', 'Allowed' ) ) + ' — ' + data.reasonLabel ) );
			output.appendChild( verdict );

			var table = el( 'table', 'widefat striped geoblocker-kv' );
			var body = el( 'tbody' );
			table.appendChild( body );

			var ipCode = el( 'code', '', data.ip );
			var ipWrap = el( 'span' );
			ipWrap.appendChild( ipCode );
			if ( data.ipSource ) {
				ipWrap.appendChild( document.createTextNode( ' (' + data.ipSource + ')' ) );
			}
			row( body, t( 'ip', 'IP address' ), ipWrap );
			row( body, t( 'country', 'Detected country' ), data.country ? data.countryName + ' (' + data.country + ')' : '' );
			row( body, t( 'continent', 'Detected continent' ), data.continent ? data.continentName + ' (' + data.continent + ')' : '' );
			row( body, t( 'result', 'Result' ), data.blocked ? t( 'blocked', 'Blocked' ) : t( 'allowed', 'Allowed' ) );
			row( body, t( 'reason', 'Reason' ), data.reasonLabel );
			row( body, t( 'whitelisted', 'Whitelisted' ), data.whitelisted ? t( 'yes', 'Yes' ) : t( 'no', 'No' ) );
			if ( data.provider ) {
				row( body, t( 'provider', 'Provider' ), data.provider + ( data.fromCache ? ' (' + t( 'cached', 'cached' ) + ')' : '' ) );
			}
			if ( data.geoError ) {
				row( body, t( 'geoError', 'Lookup error' ), data.geoError );
			}
			output.appendChild( table );

			if ( data.notes && data.notes.length ) {
				var list = el( 'ul', 'geoblocker-test-notes' );
				data.notes.forEach( function ( note ) {
					list.appendChild( el( 'li', '', note ) );
				} );
				output.appendChild( list );
			}
			output.hidden = false;
		}

		function renderError( message ) {
			output.textContent = '';
			var notice = el( 'div', 'notice notice-error inline' );
			notice.appendChild( el( 'p', '', message ) );
			output.appendChild( notice );
			output.hidden = false;
		}

		function run( ip ) {
			var body = new window.FormData();
			body.append( 'action', 'geoblocker_test_ip' );
			body.append( 'nonce', config.nonce || '' );
			body.append( 'ip', ip );

			setBusy( true );
			output.hidden = false;
			output.textContent = t( 'testing', 'Testing…' );

			window
				.fetch( config.ajaxUrl, { method: 'POST', credentials: 'same-origin', body: body } )
				.then( function ( response ) {
					return response.json().catch( function () {
						return { success: false, data: { message: t( 'requestFailed', 'The request failed.' ) } };
					} );
				} )
				.then( function ( json ) {
					if ( json && json.success ) {
						render( json.data );
					} else {
						renderError( ( json && json.data && json.data.message ) || t( 'requestFailed', 'The request failed.' ) );
					}
				} )
				.catch( function () {
					renderError( t( 'requestFailed', 'The request failed.' ) );
				} )
				.then( function () {
					setBusy( false );
				} );
		}

		form.addEventListener( 'submit', function ( event ) {
			event.preventDefault();
			var value = input.value.trim();
			if ( ! value ) {
				input.focus();
				return;
			}
			run( value );
		} );

		if ( currentButton ) {
			currentButton.addEventListener( 'click', function () {
				input.value = '';
				run( 'current' );
			} );
		}
	}

	function init() {
		Array.prototype.forEach.call( document.querySelectorAll( '[data-geoblocker-country-picker]' ), function ( root ) {
			new CountryPicker( root ); // eslint-disable-line no-new
		} );
		initMode();
		initAction();
		initProxyHeader();
		initConfirmAndBusy();
		initTester();
	}

	if ( 'loading' === document.readyState ) {
		document.addEventListener( 'DOMContentLoaded', init );
	} else {
		init();
	}
} )();
