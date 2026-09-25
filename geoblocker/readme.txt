=== GeoBlocker ===
Contributors: drlinks
Tags: geoblocking, country block, geolocation, security, firewall
Requires at least: 6.0
Tested up to: 6.8
Requires PHP: 8.1
Stable tag: 1.0.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Block visitors by country and/or continent using a private, local GeoIP database. Includes whitelisting, Cloudflare and trusted-proxy support, a testing tool and privacy-friendly logs.

== Description ==

GeoBlocker lets administrators restrict access to their website based on the visitor's location.

**Blocking**

* Block specific countries, entire continents, or both at the same time.
* Every location is allowed except the ones you block.
* Choose what blocked visitors see: a custom page (rich editor), a plain-text message, a redirect, or a bare HTTP 403.
* Choose what happens when a location cannot be detected (allow by default – a failure never locks everyone out).

**Whitelist**

* Single IPs, CIDR ranges (IPv4 and IPv6) and start–end ranges.
* Whitelisted countries (e.g. block Europe but allow France).
* Logged-in administrators bypass blocking.
* wp-admin and the login page can never be blocked (on by default), so you cannot lock yourself out.

**Private & fast geolocation**

* Uses a local MaxMind-format (.mmdb) database read directly by the plugin – no PHP extensions or Composer packages needed.
* One click installs the free DB-IP "IP to Country Lite" database (no account needed). MaxMind GeoLite2 (free license key) or any custom .mmdb file are also supported. Databases update automatically each month.
* Visitor IP addresses are never sent to third parties with the local database.
* Optional external providers (ipapi.co, IPinfo Lite) with server-side keys and result caching.
* Pluggable provider architecture: register your own provider with the `geoblocker_providers` filter.
* Behind Cloudflare, the free `CF-IPCountry` header is used automatically (only for verified Cloudflare requests).

**Proxy, CDN and Cloudflare support**

* Forwarding headers are only trusted when the request comes from a proxy you trust – visitors cannot spoof their IP with a fake `X-Forwarded-For`.
* Built-in Cloudflare IP ranges (refreshed weekly).
* Configurable trusted proxy ranges and header (X-Forwarded-For, X-Real-IP, True-Client-IP, Fastly-Client-IP or custom).
* X-Forwarded-For chains are evaluated right-to-left, skipping trusted hops.

**Admin testing tool**

Enter any IP (or click "Test Current IP") to see the detected country and continent, whether it would be blocked, why, and whether it is whitelisted.

**Logs (optional)**

Date/time, IP (optionally anonymised), country, continent, requested path, user agent and reason. Search, filters, pagination, one-click clearing and automatic deletion after 7, 30, 90 or 365 days (or never). Query strings are not stored by default.

**Performance**

* The check runs on `plugins_loaded`, before the theme, WooCommerce or Elementor render anything.
* No front-end JavaScript or CSS, no cookies.
* Settings are autoloaded: no extra database query when a visitor is allowed.
* A local database lookup takes well under a millisecond; results are cached in memory and in your persistent object cache (Redis/Memcached) when available. External provider results are cached in transients.
* Blocked responses are sent with `no-store` headers and `DONOTCACHEPAGE`, so page caches never store a block page.

== Installation ==

1. In WordPress go to **Plugins → Add New → Upload Plugin** and upload `geoblocker.zip`, then activate it.
2. Open **GeoBlocker → Geolocation** and click **Download free database now**.
3. If your site is behind Cloudflare, a load balancer or a reverse proxy, configure **GeoBlocker → Proxy & CDN** (check "How your IP is seen right now").
4. Choose countries/continents under **Blocking Rules**, choose the **Block Action**, then switch **GeoBlocker Enabled** on.
5. Use the **Test Tool** to verify your configuration.

== Frequently Asked Questions ==

= I locked myself out. What do I do? =

By default wp-admin and the login page are never blocked and logged-in administrators bypass blocking. If you disabled those options, add `define( 'GEOBLOCKER_DISABLED', true );` to `wp-config.php`, log in, fix the settings, then remove the line.

= Does it work with page caching plugins and CDNs? =

Blocked responses are never cached. However, a full-page cache (WP Rocket, LiteSpeed Cache, W3 Total Cache, Cloudflare APO, Varnish…) can serve cached pages **without running PHP**, so a visitor from a blocked location could receive a cached copy of a page. For strict blocking either:

* exclude visitors from caching by country (e.g. vary the cache by the `CF-IPCountry` header, supported by LiteSpeed and Cloudflare rules), or
* use your CDN's firewall for the same countries (e.g. Cloudflare WAF custom rule on `ip.src.country`), keeping GeoBlocker as the origin-level safeguard.

Uncached requests (logged-in users, WooCommerce cart/checkout/account pages, REST/AJAX requests and cache misses) are always checked.

= Which data is sent to third parties? =

None with the default local database. The database download itself contacts db-ip.com or maxmind.com from your server without any visitor data. If you select an external API provider, visitor IP addresses are sent to that provider.

= How do I add my own geolocation provider? =

Implement `GeoBlocker\Geo\ProviderInterface` and register it:

`add_filter( 'geoblocker_providers', function ( $providers ) { $providers['my_api'] = new My_Api_Provider(); return $providers; } );`

= Developer hooks =

* `geoblocker_providers` – register providers.
* `geoblocker_client_ip` – filter the detected visitor IP.
* `geoblocker_should_check_request` – skip checks for specific requests.
* `geoblocker_decision` – alter the final decision.
* `geoblocker_before_block` – action fired before a visitor is blocked.
* `geoblocker_block_page_html` – replace the block page template.
* `geoblocker_geo_result` – alter a lookup result before caching.
* `geoblocker_capability` – capability required to manage the plugin (default `manage_options`).

= Multisite =

Each site has its own settings and log table. Network activation creates the table on every site and on new sites automatically.

== Privacy ==

GeoBlocker processes the visitor's IP address to determine their country and continent. With the local database this happens on your server only. Lookup results (country/continent only) are cached temporarily under a salted hash. IP addresses are stored only when logging is enabled, may be anonymised, and are deleted automatically after the configured retention period. Suggested privacy policy text is added to **Settings → Privacy → Policy Guide**.

== Third-party data ==

* IP Geolocation by DB-IP (https://db-ip.com) – licensed under Creative Commons Attribution 4.0.
* MaxMind GeoLite2 (optional) – subject to the MaxMind GeoLite2 EULA.
* Cloudflare IP ranges – https://www.cloudflare.com/ips/

== Changelog ==

= 1.0.0 =
* Initial release.
