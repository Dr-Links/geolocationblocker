# GeoBlocker – WordPress plugin

Block visitors by **country** and/or **continent** using a private, local GeoIP database, with whitelisting, Cloudflare / trusted-proxy support, an admin testing tool and privacy-friendly logs.

**Install:** download [`dist/geoblocker.zip`](dist/geoblocker.zip) → WordPress Admin → Plugins → Add New → Upload Plugin → Activate.
Then open **GeoBlocker → Geolocation → Download free database now**, choose your rules, and switch **GeoBlocker Enabled** on.

Requirements: WordPress 6.0+, PHP 8.1+ (zlib for database downloads). No Composer packages or PHP extensions such as `maxminddb` are needed.

Rebuild the ZIP after changes with `./build.sh`.

## Folder structure

```
geoblocker/
├── geoblocker.php                 Main plugin file (headers, constants, bootstrap)
├── uninstall.php                  Removes options, transients, tables, cron events, DB files (multisite aware)
├── readme.txt                     WordPress.org-style readme
├── assets/
│   ├── css/admin.css              Admin UI styles (admin screen only)
│   └── js/admin.js                Country picker, conditional panels, testing tool (vanilla JS)
├── languages/geoblocker.pot       Translation template
└── includes/
    ├── Autoloader.php             PSR-4 autoloader for the GeoBlocker namespace
    ├── Plugin.php                 Wires components; admin code loads only in wp-admin
    ├── Installer.php              Activation (dbDelta), upgrades, multisite site hooks, deactivation
    ├── Settings.php               Single autoloaded option, defaults, per-tab sanitization (Settings API)
    ├── Cron.php                   Daily log pruning, weekly DB / Cloudflare range refresh
    ├── Privacy.php                Suggested privacy-policy text
    ├── Security/Guard.php         Capability + nonce helpers
    ├── Rules/Evaluator.php        Blocking logic (disabled → IP whitelist → admin → geo → country/continent)
    ├── Rules/Decision.php         Decision value object + reason labels
    ├── Frontend/Blocker.php       Runs on plugins_loaded, exclusions, logging, enforcement
    ├── Frontend/BlockResponse.php Custom page / message / redirect / 403 / JSON, no-cache headers
    ├── Ip/IpDetector.php          Real client IP with trusted-proxy model (anti-spoofing)
    ├── Ip/IpUtils.php             IPv4/IPv6 validation, CIDR/range matching, anonymisation
    ├── Ip/CloudflareRanges.php    Built-in + refreshable Cloudflare edge ranges
    ├── Cache/GeoCache.php         Memory / object cache / transient caching of lookups
    ├── Logging/Logger.php         Log table, inserts, search/filter/pagination queries, retention
    ├── Geo/ProviderInterface.php  Provider abstraction (add your own via `geoblocker_providers`)
    ├── Geo/GeoLocator.php         Provider registry, Cloudflare header shortcut, caching
    ├── Geo/GeoResult.php          Lookup result value object
    ├── Geo/MaxMindReader.php      Dependency-free .mmdb reader (GeoLite2 / DB-IP format)
    ├── Geo/DatabaseUpdater.php    Downloads DB-IP Lite / GeoLite2, gzip + tar extraction, validation
    ├── Geo/Countries.php          ISO countries, continent map, translated names
    ├── Geo/Providers/             LocalDatabase (default), ipapi.co, IPinfo Lite (optional)
    └── Admin/                     Admin page, admin-post actions, AJAX tester, logs list table, views
```
