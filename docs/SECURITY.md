# Signalpost — Security Model

## Trust boundaries

Signalpost exposes three independent API surfaces. Each has its own
authentication and never accepts another surface's credentials.

| Boundary | Prefix | Authentication | Scope |
|---|---|---|---|
| Dashboard | HTML routes, `/api/v1/dashboard/w/{ws}/…` | Session cookie (`__Host-sp_session` over HTTPS) + CSRF token on every write | Workspaces where the user has an active membership (or a support grant) |
| WordPress integration | `/api/v1/integration/…` | `Authorization: Bearer spk_<prefix>.<secret>` | Exactly one website, derived from the credential |
| Visitor widget | `/api/v1/widget/{siteKey}/…` | `X-Visitor-Token` (opaque random token) | Exactly one visitor on one website |

Blocked visitors are refused on every visitor write (messages, contact,
consent, analytics). The widget prefix contains only visitor-facing endpoints; administrative and
integration endpoints are not reachable through it. The browser `Origin`
header is validated on widget requests and used for CORS, but it is **never**
treated as authentication.

## Tenant isolation

Every dashboard request passes through `Tenancy\Authorizer`, which verifies:

1. an authenticated, active, verified user (session guard);
2. an active membership in an active workspace — or, for the platform owner
   only, an unexpired support grant created by that workspace's owner;
3. the role's permission for the requested operation (`Tenancy\Roles`).

All queries for tenant data include the authorised `workspace_id`. Resource
IDs from URLs, request bodies and polling cursors are always combined with
that workspace ID, so a foreign ID behaves exactly like a missing one (HTTP
404, no information leak). Integration endpoints ignore any website or
workspace identifiers in the request. Widget endpoints resolve the visitor
from the token *within the website identified by the site key*; tokens from
another website do not resolve.

Automated tests cover cross-workspace reads and writes, modified IDs, polling
cursors, search, exports, deletion, agent vs. owner permissions, revoked
members, suspended accounts and workspaces, and support-grant expiry.

## Roles

| Permission | Owner | Agent | Support (grant) |
|---|---|---|---|
| View workspace, conversations, visitors, websites | ✓ | ✓ | ✓ (read-only) |
| Reply, change conversation status | ✓ | ✓ | — |
| Block / unblock visitors | ✓ | ✓ | — |
| Manage websites, credentials, widget/tracking/retention settings | ✓ | — | — |
| Invite / remove members, change roles | ✓ | — | — |
| Export, cleanup, delete visitors | ✓ | — | — |
| Read workspace audit history | ✓ | — | ✓ |
| Delete workspace | primary owner only | — | — |

The platform owner has **no implicit access** to workspace data. Support
grants are created by the workspace owner, limited to a maximum duration
(platform setting, default 24 h), strictly read-only (no replies, status
changes or read markers), revocable, and every route read under a grant —
including polling endpoints — is written to the workspace's audit history
(deduplicated to one entry per route per 10 minutes).

## Authentication

* Passwords: Argon2id (bcrypt fallback), minimum length 10 (configurable),
  rehash on login when parameters change.
* First owner: created by the web installer, which requires a one-time setup
  token written to `storage/setup-token.txt` (outside the web root, mode 0600),
  or by `php bin/console create-owner`. No default password exists. The
  installer is disabled once any user exists.
* Sessions: 256-bit random token in an HttpOnly, SameSite=Lax cookie (Secure +
  `__Host-` prefix over HTTPS); only its SHA-256 is stored. A new token is
  issued at every login (session regeneration). Idle timeout 120 min,
  absolute lifetime 168 h (configurable). Users can revoke sessions; password
  change revokes other sessions; password reset and suspension revoke all.
* CSRF: session-bound token for authenticated forms and the `X-CSRF-Token`
  header for JSON; double-submit cookie for pre-login forms (login CSRF is
  covered); Origin/Referer must match `app.url` on writes.
* Login throttling: 5 failures per account (keyed on the resolved user ID) per
  15 min, 30 per IP; malformed emails are rejected before lookup and emails are
  compared exactly (binary collation), so alternative spellings cannot reset
  the counter; generic error messages; failures recorded as masked security
  events.
* Password reset: single-use 256-bit token, stored hashed, 1 h lifetime, no
  account enumeration.
* Email verification for self-registration (platform setting). Because the
  inviting owner can see the invitation link, accepting it does **not** prove
  mailbox control: when verification is required, accounts created through an
  invitation stay unverified until the emailed verification link is used.
  Accepting an invitation or removing a member invalidates that address's
  other pending invitations. Registration defaults to invitation-only.
* Multi-factor authentication is **not implemented** in this release (planned
  extension).

## Website credentials

* Pairing codes: ~80 bits, single use, 30-minute lifetime, stored hashed; the
  plugin's site URL must match the registered origin.
* Credentials: `spk_<12-hex prefix>.<256-bit secret>`; only SHA-256 of the
  secret is stored; constant-time comparison. Shown to nobody — only the
  plugin receives it, once, over HTTPS.
* Rotation: requested from the dashboard and completed server-to-server by the
  plugin; the previous credential stays valid for 10 minutes for reads only
  and cannot rotate, change settings or disconnect during that grace period.
* Revocation: dashboard "Disconnect", plugin "Disconnect" or uninstall.
* Failures are rate-limited per IP and recorded as security events.

## Visitor identity

* Token: 256-bit random, held in the website's first-party `localStorage`;
  stored centrally as HMAC-SHA256 with the application key (unrecoverable).
* Displayed visitor ID: separate 80-bit random value; not a credential.
* Tokens rotate every 30 days (previous hash accepted until the next rotation).
* Blocks reference the internal visitor record, so rotation does not escape a
  block; clearing storage does (documented limitation).

## Input, output and transport

* All SQL uses PDO native prepared statements (`ATTR_EMULATE_PREPARES=false`);
  table/column names are never taken from input.
* Inputs are validated for type, length and allowed values; JSON settings are
  validated against explicit schemas (`Sites\SettingsSchema`) and unknown keys
  are dropped.
* Request bodies over 64 KB are rejected (413); event batches ≤ 20; messages
  ≤ 4000 characters.
* Output: server templates escape every value; JSON responses escape `<`, `>`,
  `&`; the widget and dashboard insert all user text with `textContent`.
  No user-controlled HTML is ever rendered.
* Dashboard CSP: `default-src 'self'; script-src 'self'; style-src 'self';
  frame-ancestors 'none'; …` (no inline scripts or styles), plus
  `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, HSTS over HTTPS.
* HTTPS is enforced when `security.force_https` is true (default).
  `X-Forwarded-Proto`/`X-Forwarded-For` are honoured only from
  `security.trusted_proxies`.
* Rate limits (MySQL-backed, keys hashed): login, registration, reset,
  pairing, integration failures, widget sessions/messages/contact/consent/
  events, dashboard replies, exports, cleanup.

## Errors, logging, audit

* Unhandled errors return a generic message with a random reference; details
  go to `storage/logs/app-YYYY-MM-DD.log` (JSON lines).
* The logger redacts keys that look sensitive (password, token, secret,
  authorization, cookie, body, email, phone, name, code…) and scrubs
  credential-shaped strings (`spk_…`, bearer/visitor tokens, long hex).
* The audit log stores action, resource and an allowlisted set of short
  metadata keys — never message bodies, contact details, passwords, tokens or
  credentials. Block reasons stay in the block record.

## File and configuration security

* Only `central/public/` should be the web root. `config/`, `storage/`, `src/`,
  `migrations/`, `templates/`, `bin/` contain `.htaccess` deny rules as
  defence in depth, and the package root has a deny-all `.htaccess`.
* `config/config.php` is git-ignored; set permissions to `0600` (or `0640`).
  The health page warns if it is world-readable.
* `storage/` must be writable by PHP and is never web-accessible.
* The application key (`app.key`) must be kept secret; rotating it invalidates
  visitor tokens and rate-limit buckets (visitors simply start new sessions).

## WordPress plugin

* All admin actions require `manage_options` and a nonce; inputs are
  sanitised (`sanitize_text_field`, `sanitize_hex_color`, …) and output is
  escaped (`esc_html`, `esc_attr`, `esc_url`, `wp_json_encode` with HEX
  flags).
* The credential is stored in a non-autoloaded option or a
  `SIGNALPOST_CREDENTIAL` constant, never printed, and only its prefix is
  shown in diagnostics.
* Remote calls use the WordPress HTTP API with TLS verification and no
  redirects; plain HTTP is refused except for local development hosts.
* The widget script is accepted only from the configured central URL.
* No WooCommerce data is accessed. Future integrations must authenticate the
  customer; order data must never be exposed based on a visitor or
  conversation ID.

## Known limitations

* No multi-factor authentication yet.
* Short polling: an operator's reply reaches the visitor within roughly the
  polling interval (default 4 s with the chat open, 15 s closed, 30 s in a
  background tab).
* Rate limits and sessions live in MySQL; under very high load a dedicated
  cache would be more efficient.
* Visitor-ID blocking cannot follow a person who clears storage or switches
  browser (by design — no fingerprinting).
* Email uses PHP `mail()`; deliverability depends on your host (SPF/DKIM).
* The visitor token is readable by JavaScript on the customer's website (it
  lives in that site's `localStorage`). A script injected into the customer's
  site could read it and act as that visitor in their own conversation. It
  cannot access other visitors, operators or the dashboard.
* Security testing consisted of automated tests, an internal adversarial code
  review (whose six medium/low findings were fixed and covered by regression
  tests — see docs/TEST_REPORT.md) and manual review. No independent
  penetration test has been carried out.

## Reporting a vulnerability

Contact the platform operator privately. Do not open public issues for
security problems.
