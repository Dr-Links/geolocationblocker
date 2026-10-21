# Signalpost — Data Collection, Privacy and Retention

This document describes what Signalpost collects, why, how long it is kept,
and how it is deleted. It is written for the people who operate a Signalpost
platform or workspace. **It is not legal advice.** Installing Signalpost, or
showing a consent prompt, does not by itself make a website compliant with
any law. Each workspace owner must decide, with appropriate advice, which
legal basis applies to their processing and what their visitors must be told.

## 1. Two tiers: essential chat and optional analytics

| Tier | What it covers | Default |
|---|---|---|
| **Essential chat** | Providing the chat a visitor asks for and keeping the service secure. | Always on when the widget is enabled. |
| **Optional analytics** | Page-view history, visit counts, referrer origin, page titles, coarse browser/OS, estimated country. | **Off** for every new website. |

Calling chat "essential" does not automatically exempt it from notice or
consent requirements everywhere. Operators should mention the chat in their
privacy notice in any case.

### 1.1 Essential chat data

Created **only after a visitor opens the chat widget** (or permits analytics):

| Data | Where | Purpose |
|---|---|---|
| Random visitor token (256-bit) | Visitor's browser, `localStorage` key `signalpost:v1:<site key>` on the website's own origin | Continue the same conversation across page loads. |
| Keyed hash (HMAC-SHA256) of that token | Central database (`visitors.token_hash`) | Look the visitor up without storing a usable copy of the token. |
| Random visitor ID (`public_id`, 80-bit) | Central database | Pseudonymous reference shown to operators. Not derived from IP, fingerprint, email or any personal data. Not a credential. |
| First seen / last seen timestamps | Central database | Chat continuity; "active now" indicator for operators. |
| Conversations and messages | Central database | The service the visitor requested. |
| Delivery timestamps | Central database | Show whether operator replies reached the visitor. |
| Pre-chat details (name, email, phone) — **only if the workspace enables the form and the visitor submits them** | Central database | Let the operator follow up. |

Visitors who never open the chat and have not permitted analytics generate
**no requests to Signalpost** and no identifier, apart from the browser
downloading the widget script.

Identifiers expire: the widget discards a stored token that has not been used
for 180 days, the server rotates tokens every 30 days, and inactive profiles
are deleted by retention (§4).

### 1.2 Optional analytics

Collected **only** when all of these are true:

1. The workspace owner enabled analytics for the website (Websites → Tracking & consent).
2. The page path is not excluded (account, checkout, cart, payment and login pages are excluded by default).
3. The visitor's permission is established for the configured legal basis (§2).

The central server re-checks condition 3 on every submission and **discards
events when permission cannot be verified** (fail closed).

| Data | Notes |
|---|---|
| Page path | Query strings and fragments are removed before sending and again on the server. Only paths on the connected website. |
| Page title | Only if "Record page titles" is enabled. |
| Referrer | Only if enabled; reduced to an origin such as `https://google.com`. Same-site referrers are dropped. |
| Visit (session) and visit count | See §3. |
| Browser and OS family | Only if enabled. Coarse family names only (e.g. "Chrome", "Windows"); no versions, screen sizes, fonts, plugins or other high-entropy values. |
| Estimated country | Only if enabled **and** a local geolocation source is configured. Shown as "estimated". The IP address is used transiently for the lookup and is not stored. |

The tracking client never reads form fields, keystrokes, page contents,
passwords or payment data, and cannot see other tabs or other websites.

Signalpost does **not** fingerprint browsers, link identities across
websites, or merge profiles because of matching IP addresses or browser
characteristics. Each connected website has separate visitor identities.

## 2. Legal bases and consent

Each website chooses a **legal basis** for optional analytics:

* **Consent (default, recommended).** Analytics run only after the visitor
  opts in. The decision is recorded with its timestamp, the policy version and
  the source (widget prompt, WP Consent API, or a custom JavaScript call).
  Changing the policy version asks visitors again; until they answer,
  collection stops.
* **Another documented basis.** For operators who have assessed and
  documented that another basis (for example legitimate interests) applies.
  Analytics run unless the visitor objects; the widget offers a "Turn off"
  control. Selecting this option requires an explicit acknowledgement in the
  dashboard, and the change is recorded in the audit history.

**Cookie/storage consent vs. legal basis.** Rules about storing information
in a visitor's browser (such as the ePrivacy Directive's cookie rules) are
separate from the legal basis for processing personal data (such as the
GDPR's Article 6 bases). The analytics features rely on browser storage, so in
some jurisdictions consent is required for them regardless of the basis you
choose for processing. The essential chat token is stored only after the
visitor actively opens the chat; whether that is "strictly necessary" for the
service the visitor requested is for you to assess.

Consent states recorded per visitor: `unknown`, `essential` (declined),
`analytics` (permitted), `withdrawn`. The absence of a consent interface or
signal is never treated as consent.

**Withdrawal.** When a visitor turns analytics off (or objects), collection
stops immediately and that visitor's existing page views, visit sessions,
visit count, last page, browser/OS and estimated country are deleted. Chat
continues to work. The withdrawal itself is recorded.

**Consent sources.** The WordPress plugin can take the decision from the
WordPress Consent API ("statistics" category) or from your own consent tool
calling `window.Signalpost.setAnalyticsConsent(true|false)`. The same policy
is enforced by the central server regardless of what the browser does.

## 3. Visits, activity and the live view

* **Visit:** a run of eligible analytics activity in which no gap exceeds the
  website's inactivity threshold (default 30 minutes, configurable 5–240). The
  first page view after a longer gap starts a new visit and increments the
  visit count. Chat messages and polling never count as visits.
* **Multiple tabs** share the same stored identifier and the same visit while
  activity continues within the threshold.
* **Deleted sessions** (by retention or withdrawal) are not re-counted; the
  visit count is reset on withdrawal.
* **Identifier resets** (cleared storage, another browser, private mode) start
  a new visitor with a new count; the old profile is not linked.
* **Active now** means the visitor's browser contacted Signalpost within the
  last 2 minutes (`limits.active_visitor_seconds`). **Recently seen** covers
  the last 30 minutes (`limits.recent_visitor_minutes`). Neither proves the
  person is still looking at the page; the dashboard says so.

## 4. Retention

Per website (Websites → Retention). Defaults:

| Category | Default | Notes |
|---|---|---|
| Page-view events | 90 days | Optional analytics. |
| Visit sessions | 90 days | Optional analytics. |
| Pre-chat submissions | 365 days | Values copied to the profile stay until the profile is deleted. |
| Conversations and messages | 730 days after the last message | `0` keeps them until deleted manually. |
| Inactive visitor profiles | 395 days without activity | Only removed once none of their conversations remain. |
| Consent records | 1095 days | Kept independently so decisions can be demonstrated. |

Platform-level (not configurable per workspace):

| Category | Retention |
|---|---|
| Security records (failed logins, failed integration auth; masked IP + keyed hash) | 30 days |
| Expired dashboard sessions | 1 day after expiry / 30 days after revocation |
| Expired password-reset/verification tokens, pairing codes | 7 days after expiry |
| Expired invitations | 30 days after expiry |
| Revoked site credential records (hash only) | 90 days |
| Audit history | Kept with the workspace; deleted with it |

Cleanup runs from cron (`php bin/console cron:run`, see docs/CRON.md) or
manually (Privacy & retention → Run cleanup). It deletes in bounded batches;
"Preview (dry run)" only counts. No visitor or analytics data is kept
indefinitely by default; only the workspace audit history (which contains no
message text or contact details) lives as long as the workspace.

## 5. Export and deletion

* **Workspace export** (owners): JSON containing websites, settings, visitors,
  contact details, conversations, messages, analytics, consent records, blocks
  and audit history. Never includes password hashes, tokens, credential hashes
  or pairing codes. Recorded in the audit history.
* **Visitor export** (owners): everything held about one visitor ID, for
  access requests.
* **Visitor deletion** (owners): removes the profile, conversations, messages,
  analytics, contact submissions and blocks for that visitor ID. Consent
  records are detached and follow their own retention.
* **Website deletion** (owners): removes that website and all of its data.
* **Workspace deletion** (primary owner only, name + password confirmation):
  removes everything in the workspace. Other workspaces are unaffected. A
  platform-level audit entry without personal data records that it happened.
* **WordPress plugin deactivation or deletion never deletes central data.**
  The central dashboard is the authority for deletion.

**Backups:** deleted data may survive in database backups until those backups
expire. State your backup retention in your privacy notice (see
docs/BACKUP.md).

## 6. IP addresses

* Not stored in visitor profiles, events, messages or consent records.
* Used transiently for rate limiting (stored only as keyed hashes in
  short-lived buckets) and, if enabled, the country lookup.
* Security records keep a **masked** address (IPv4 /24, IPv6 /48) and a keyed
  hash for correlating abuse, for 30 days, visible only to the platform owner.
* Never used to identify, merge or block visitors.
* Forwarding headers (`X-Forwarded-For`) are trusted only from proxies listed
  in `security.trusted_proxies`.

## 7. Visitor blocking limitations

Blocking uses the opaque visitor ID only, scoped to one website. There is no
IP-based blocking. The server enforces blocks on every visitor write; hiding
the widget is not relied upon.

**Limitation:** if the person clears browser storage, uses private browsing,
switches browser or device, or otherwise obtains a new visitor ID, the block
does not follow them. Signalpost intentionally does not use fingerprinting, IP
matching or cross-site identity resolution to work around this.

## 8. Who can see what

| Role | Access |
|---|---|
| Workspace agent | Conversations, visitor profiles (including submitted contact details), live view, blocking. |
| Workspace owner | Everything in the workspace, including settings, credentials, export and deletion. |
| Platform owner | Accounts, workspaces (names, counts), health, platform audit and masked security records. **No access to conversations or visitor data** unless a workspace owner grants time-limited, read-only support access; every page viewed under a grant is recorded in that workspace's audit history. |
| Website visitor | Only their own conversation on that website, via their token. |

## 9. Sub-processors and transfers

Signalpost itself sends visitor data to no third party. Your hosting
provider stores the database. If you enable the `trusted_header` geolocation
provider behind a CDN such as Cloudflare, that CDN processes visitor IPs under
your agreement with it. Outbound email (invitations, password resets) goes
through your server's mail system.
