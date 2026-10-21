=== Signalpost Connector ===
Contributors: signalpost
Tags: live chat, chat, customer support, helpdesk
Requires at least: 6.0
Tested up to: 6.8
Requires PHP: 7.4
Stable tag: 1.0.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Connects your WordPress site to a self-hosted Signalpost live chat server.

== Description ==

Signalpost Connector loads the Signalpost chat widget on your site and links it to your Signalpost central dashboard, where you answer visitors from all of your websites.

* Works with any properly coded theme and common page builders (assets are added through standard WordPress hooks; the widget is skipped inside builder editors).
* Secure pairing with a one-time code. The site credential is stored as a non-autoloaded option (or in wp-config.php) and is never printed into pages.
* Essential chat by default. Optional analytics run only when enabled centrally and permitted for each visitor (built-in prompt, WP Consent API, or your own JavaScript).
* Safe disconnected state: if the site is not connected or the credential is rejected, nothing is loaded.
* Deactivating or deleting the plugin never deletes conversations stored on the Signalpost server.

This plugin requires a Signalpost central server that you operate. It sends data only to the server address you configure.

== Installation ==

1. Plugins → Add New → Upload Plugin → choose signalpost-connector.zip → Install → Activate.
2. In the Signalpost dashboard, add this website (exact address, e.g. https://www.example.com) and generate a pairing code.
3. In WordPress, go to Settings → Signalpost Chat, enter the server address and the pairing code, and click Connect.

Optional: define the credential in wp-config.php instead of the database:
`define( 'SIGNALPOST_CREDENTIAL', 'spk_...' );`

== Frequently Asked Questions ==

= Does uninstalling delete my chat history? =
No. Only this site's local settings are removed and its credential is revoked. Delete central data in the Signalpost dashboard.

= Is WooCommerce supported? =
Not yet. The plugin provides the `signalpost_widget_config` filter and `signalpost_widget_enqueued` action as extension points. Any future order integration must authenticate the customer; order data is never exposed based on a visitor or conversation identifier.

== Changelog ==

= 1.0.0 =
* Initial release.
