# Signalpost Connector (WordPress plugin)

* Slug: **`signalpost-connector`** · Main file: `signalpost-connector/signalpost-connector.php`
* Requires WordPress 6.0+, PHP 7.4+. Tested with WordPress 6.8.3 (Twenty Twenty-Five theme) on PHP 8.3.
* ZIP: `dist/signalpost-connector-1.0.0.zip`

## Install

1. WordPress → **Plugins → Add New → Upload Plugin** → choose the ZIP → **Install Now** → **Activate**.
2. In Signalpost: **Websites & widget → Add a WordPress website** with the exact site address
   (WordPress → Settings → General → *Site Address*), then **Generate pairing code**.
3. WordPress → **Settings → Signalpost Chat → Connection**: enter the Signalpost address
   (e.g. `https://chat.example.com`) and the code → **Connect**.

The plugin shows the connection status, the website name, the non-secret credential prefix
(`spk_abc123…`) and the time of the last successful contact.

## Tabs

* **Connection** — connect, **Test connection** (refresh settings now, completes pending
  rotations), **Rotate credential**, **Disconnect**.
* **Widget** — show/hide chat, brand name, colour, position, offset, launcher label, greeting,
  welcome message, pre-chat fields (off/optional/required), privacy notice, paths where the
  widget is hidden. Saved to the Signalpost server (also editable in the dashboard).
* **Tracking & consent** — shows the active tracking mode and legal basis (managed centrally),
  selects the consent signal source (widget prompt, WP Consent API, custom JS), and the paths
  that are never tracked.
* **Diagnostics** — versions, HTTPS, connection status, credential prefix and source, last
  error code, config cache age, next background refresh, WP-Cron and WP Consent API status.
  Never shows secrets.

## How it works

* The credential is exchanged once for the pairing code and stored in the non-autoloaded
  option `signalpost_credential` (or define `SIGNALPOST_CREDENTIAL` in `wp-config.php`).
* Configuration is cached in `signalpost_config_cache` and refreshed every 15 minutes by
  WP-Cron (and on Test connection). **Page views never wait for the central server.**
* On eligible front-end pages the plugin enqueues `https://<central>/widget/v1/widget.js`
  (deferred, footer) and prints `window.SignalpostConfig` (public key, endpoints, widget and
  tracking policy — no secrets).
* Not loaded in wp-admin, AJAX/REST/feeds, the Customizer preview, or page-builder editors
  (Elementor, Divi, Beaver Builder, Bricks, Oxygen, Thrive, WPBakery, Brizy).
* The widget renders in a Shadow DOM, so theme and builder CSS cannot break it.
* If the site is not connected or the credential is rejected (HTTP 401), the plugin enters a
  safe disconnected state: nothing is loaded on the front end.
* WP Consent API: when selected, the plugin forwards the "statistics" consent decision to the
  widget and declares compatibility via `wp_consent_api_registered_{plugin}`.
* Custom consent tools call `window.Signalpost.setAnalyticsConsent(true|false)` after
  `signalpost:ready` fires.

## Deactivate / uninstall

* **Deactivate:** stops background refresh; the connection and all central data are kept.
* **Delete (uninstall):** removes the plugin's local options and makes a best-effort call to
  revoke this site's credential. **Conversations, visitors and settings on the Signalpost
  server are not deleted** — manage or delete them in the dashboard.

## Extension points

* Filter `signalpost_widget_config` — adjust the public client config (never add secrets; it
  is printed into HTML).
* Action `signalpost_widget_enqueued` — fires after the widget is enqueued.

WooCommerce is not integrated in this release. A future integration must authenticate the
customer through WordPress and must never reveal orders based only on a visitor ID or
conversation URL.

## Multisite

Each site in a network is connected separately (options are per site). Network activation
works, but every site needs its own website entry and pairing code in Signalpost.
