# MASTER BUILD PROMPT — MULTI-TENANT WORDPRESS LIVE CHAT PLATFORM

> This file records the binding project specification exactly as supplied by the
> project owner. It was not present in the repository at the start of work and
> was committed during Milestone 0 so the specification is versioned with the code.

## 1. ROLE AND OBJECTIVE

Act as a senior software architect, full-stack PHP developer, WordPress plugin engineer, database architect, application security engineer, UI/UX designer, and QA engineer.

Build a complete, original, production-oriented live chat and visitor monitoring platform with functionality comparable in broad terms to established customer support tools such as Tidio and Smartsupp.

Do not copy proprietary source code, branding, logos, or distinctive interface designs. Create an original product with its own name, design system, and interface.

The platform must allow multiple independent users to manage multiple WordPress websites from a single central dashboard.

I am initially the platform owner and may be the only operator. Later, I want to allow other people to register or receive invitations, create their own workspaces, connect their own websites, and manage their own visitors without seeing anyone else's data.

My hosting environment is initially shared hosting with cPanel. I want to minimize additional hosting expenses and avoid infrastructure requirements that my hosting cannot support.

Do not merely describe how to build the platform. Implement actual working functionality in the project repository, run tests, correct errors, and prepare deployment-ready deliverables.

Never claim functionality is complete, security is verified, or tests pass unless the relevant implementation and tests have actually been checked.

## 2. FIRST TASK: INSPECT THE ENVIRONMENT

Before changing files:

1. Inspect the repository, existing code, folder structure, and available documentation.
2. Identify the PHP version, database options, extensions, and tools available locally.
3. Determine whether this is a new project or an existing application that must be preserved.
4. Check the expected cPanel deployment environment and identify unsupported requirements.
5. Identify missing information and technical risks.
6. Produce a concise implementation plan with milestones and acceptance criteria.

Do not delete existing files or overwrite existing projects without understanding their purpose.

After presenting the plan, continue implementing incrementally. Ask questions only when essential information is missing or a consequential decision requires my approval.

Use safe local defaults for development. Never require me to disclose passwords, database credentials, API keys, or hosting secrets in chat.

## 3. REQUIRED ARCHITECTURE

Build three coordinated components.

### A. Central web application

A PHP application deployed at a domain such as: `https://chat.example.com`

It manages authentication, workspaces, websites, visitor profiles, conversations, messages, tracking settings, consent records, visitor blocks, and administration.

### B. WordPress connector plugin

An installable WordPress plugin that connects each WordPress website to the central application.

The plugin must be independent of the WordPress theme and must work with properly supported WordPress themes and common page builders.

### C. Front-end chat widget and tracking client

A lightweight JavaScript and CSS widget loaded on eligible pages through the WordPress connector.

It must support visitor messaging, session handling, and policy-controlled tracking.

### Technology requirements

Prefer:

* PHP 8.x, subject to the actual hosting environment.
* MySQL or MariaDB.
* PDO prepared statements.
* Vanilla JavaScript and CSS where practical.
* WordPress APIs and coding conventions.
* Responsive, accessible HTML/CSS.
* Database migrations and versioned APIs.
* HTTPS for production.
* Short polling for live chat on shared hosting.

Do not require a persistent PHP daemon, WebSockets, Redis, Docker, root access, Node.js at production runtime, or a separate server for every customer.

If Composer or a local JavaScript build tool is helpful, it may be used during development if the deployment package contains everything required to run on the target hosting environment.

Keep the messaging transport modular so WebSockets, queues, or a dedicated worker can be introduced later on suitable infrastructure.

## 4. MULTI-USER, MULTI-WORKSPACE ARCHITECTURE

This is a mandatory requirement from the beginning.

### Platform owner

The initial platform owner can:

* Manage platform accounts.
* Suspend or reactivate accounts.
* Review platform health and operational errors.
* Configure system-wide security and registration settings.
* Manage platform-wide limits.
* View relevant audit records.
* Manage platform-level settings without automatically gaining unnecessary access to private customer conversations.

Any exceptional support access to customer data must be explicitly authorized, audited, and restricted.

### Workspace owner

Each customer has a separate workspace. A workspace owner can:

* Register multiple WordPress websites.
* Configure each website's widget.
* View and reply to conversations belonging to their workspace.
* Review permitted visitor profiles and browsing activity.
* Manage tracking, consent, and retention settings.
* Block or unblock visitors.
* Invite agents and revoke memberships.
* Export or delete their workspace data.
* Rotate and revoke website credentials.

### Workspace agent

Agents can access permitted conversations and visitor information but cannot manage platform settings or perform owner-only actions.

Provide role-based access control that can be extended later.

### Authentication

Implement:

* Account registration, when enabled.
* Login and logout.
* Password reset.
* Email verification when appropriate to the registration model.
* Secure session handling.
* Session expiration and revocation.
* Account suspension.
* Invitation acceptance.
* Workspace membership management.
* Login throttling.
* Optional multi-factor authentication as a future extension.

Use strong password hashing, session ID regeneration after authentication, secure cookies, CSRF protection, and appropriate password reset tokens.

Establish the first platform owner through a secure installation process. Never ship a predictable default password.

### Absolute tenant isolation

Every protected request must verify:

1. Authenticated identity.
2. Workspace membership.
3. Required role.
4. Ownership of the requested website or resource.
5. Permission to perform the requested operation.

Never trust workspace IDs, website IDs, visitor IDs, conversation IDs, message IDs, or other resource identifiers supplied by a client without server-side authorization.

User A must never be able to access User B's websites, conversations, messages, visitor profiles, credentials, analytics, exports, or settings by modifying URLs, API requests, identifiers, or polling cursors.

Test tenant isolation explicitly.

## 5. WEBSITE REGISTRATION AND CREDENTIAL MANAGEMENT

Each workspace must be able to connect multiple WordPress websites.

For every website, store:

* Workspace association.
* Website name.
* Canonical origin.
* Integration status.
* Tracking and privacy configuration.
* Widget configuration.
* Creation and last-activity timestamps.

Implement:

* Website registration.
* Secure pairing between the central application and WordPress plugin.
* Unique integration credentials for each website.
* Credential rotation.
* Credential revocation.
* Connection status.
* Last successful connection timestamp.
* Disconnect and reconnect functionality.
* Validation of allowed origins.

Never expose reusable website secrets in browser JavaScript, HTML, public API responses, error messages, or logs.

Store reusable secrets as hashes where feasible. Design pairing and rotation flows so a credential can be replaced without exposing its plaintext value unnecessarily.

Do not treat CORS or the browser Origin header as authentication.

A website must never be able to use its credentials to access another website's data.

## 6. WORDPRESS PLUGIN REQUIREMENTS

Build an installable plugin with a unique, documented slug, such as `central-live-chat`.

Provide a ZIP ready for installation through the WordPress Plugins screen.

The plugin must include:

* A settings page.
* Central application URL configuration.
* Secure connection and pairing.
* Connection status.
* Enable/disable chat.
* Widget appearance settings.
* Widget position settings.
* Optional welcome message.
* Optional pre-chat form configuration.
* Tracking and consent integration.
* Configurable excluded paths.
* A safe disconnected state.
* Diagnostics that do not reveal secrets.
* Secure credential rotation and disconnection.

Use WordPress nonces, capability checks, sanitization, escaping, and WordPress HTTP APIs.

Do not assume that all websites use WooCommerce, but design the plugin so WooCommerce integration can be added later.

If optional WooCommerce integration is implemented, only retrieve order information for properly authenticated and authorized users. Never expose customer orders merely because someone knows a visitor ID or conversation URL.

Deactivating or uninstalling the plugin must not automatically delete the central chat history.

The central dashboard must remain the authority for deletion of central data.

## 7. CUSTOMER-FACING CHAT WIDGET

Create an original, professional, responsive chat widget. It must include:

* Chat launcher button.
* Open and close controls.
* Welcome screen.
* Message list.
* Message composer.
* Sending indicator.
* Message timestamps.
* Pending, sent, and failed states.
* Retry support.
* Connection error handling.
* Reconnection behavior.
* Conversation reopening rules.
* Mobile-friendly layout.
* Keyboard accessibility.
* Screen-reader-friendly labels.
* Configurable colors, placement, greeting, and branding.
* Optional pre-chat form.

Messages must be rendered safely as plain text by default.

Never insert visitor or operator message bodies into the DOM as trusted HTML. If rich text is later added, use a carefully selected sanitizer and strict allowlist.

Visitors should be able to chat without creating a full platform account.

The visitor widget must never be able to access administrative endpoints or arbitrary conversations.

## 8. CENTRAL OPERATOR DASHBOARD

Create a responsive dashboard with these sections:

1. Overview.
2. Inbox.
3. Live visitors.
4. Visitor profiles.
5. Websites.
6. Workspace members.
7. Widget configuration.
8. Tracking and consent settings.
9. Data retention and privacy.
10. Visitor blocking.
11. Audit history.
12. Account settings.

### Inbox

Include:

* Conversation list.
* Search restricted to authorized workspace data.
* Website filters.
* Conversation status filters.
* Unread indicators.
* Message history.
* Visitor profile panel.
* Reply composer.
* Open, pending, and closed statuses.
* Timestamps.
* Loading and error states.
* Empty states.
* Safe retry handling.
* Pagination or incremental loading.

### Live visitors

Where permitted tracking is enabled, show active or recently active visitors and their last observed page.

Clearly distinguish currently active visitors from visitors who were merely seen recently. Define and document the activity timeout.

Do not claim to know a visitor is still on a page when the application only has stale activity data.

### Dashboard usability

Use an original, polished visual design with a clear information hierarchy, responsive layouts, sensible navigation, and accessible controls.

Do not substitute a static mock-up for working functionality. Sample data must be clearly labeled and confined to development or demonstrations.

## 9. VISITOR IDENTIFICATION AND CONTACT DETAILS

Generate a cryptographically random, opaque visitor identifier.

Do not derive it from personal information, IP addresses, browser fingerprints, or email addresses.

Use a suitable first-party identifier scoped to the connected website, with secure storage and appropriate expiration behavior.

Treat visitor IDs as pseudonymous identifiers, not authentication credentials.

Implement visitor profiles supporting:

* Name, if provided.
* Email, if provided.
* Phone number, if provided.
* First-seen timestamp.
* Last-seen timestamp.
* Visit count.
* Conversation history.
* Permitted browsing activity.
* Browser and operating system information, where appropriate.
* Estimated country or region, where available and permitted.
* Tracking and consent status.
* Block status.

Clearly distinguish:

* Details submitted by the visitor.
* Details obtained through an authorized integration.
* Automatically observed information.
* Estimated or inferred information.

Do not invent visitor details or imply that the platform knows a person's real identity just because they visit a website.

### Pre-chat form

Allow workspace owners to configure optional fields such as:

* Name.
* Email.
* Phone.

Allow the form to be optional or required according to workspace configuration and applicable rules.

Validate submitted values, apply rate limits, and prevent stored cross-site scripting.

Do not collect sensitive information that is not necessary for customer support.

Do not expose contact details through public endpoints.

### Visitor identity limitations

Do not use covert fingerprinting or cross-site identity stitching.

Do not automatically merge two profiles simply because their IP addresses or browser characteristics match.

Keep website-specific visitor identities isolated by default. Any future authenticated customer identity integration must use explicit, documented authorization and privacy safeguards.

## 10. TRACKING POLICY: ESSENTIAL CHAT BY DEFAULT

The tracking architecture must distinguish essential chat operations from broader visitor analytics.

Do not classify all tracking as essential merely because it is part of the chat product.

### Essential chat functionality

Support the minimum data necessary to provide the requested messaging service and secure the application, subject to applicable law.

This may include:

* An opaque chat session identifier.
* Conversation and message identifiers.
* Message content submitted by the visitor.
* Message timestamps.
* Delivery state.
* Minimal technical information needed for security and service reliability.

Avoid collecting extensive page histories, persistent analytics identifiers, and unnecessary behavioral information as a condition of using chat.

Do not assume that calling a feature essential automatically exempts it from consent or notice requirements in every jurisdiction.

### Broader analytics

Treat these as optional analytics features:

* Detailed page-view history.
* Navigation timelines.
* Page engagement and duration.
* Analytics-specific persistent identifiers.
* Returning-visitor analytics not necessary for the requested service.
* Referral and campaign attribution.
* Other non-essential behavioral measurements.

Default broader analytics to disabled until the applicable policy permits collection and any required consent or other authorization has been established.

### Consent management

Implement configurable consent states, including:

* Unknown.
* Essential-only.
* Analytics permitted.
* Consent withdrawn, when consent is the applicable basis.

Provide clear user-facing choices where required.

Requirements:

* Essential chat must continue to function when optional analytics is disabled.
* Do not load or execute optional tracking before the required authorization.
* Record relevant consent decisions with timestamps and policy versions.
* Allow analytics preferences to be changed.
* Stop optional tracking promptly after withdrawal.
* Expire or clear analytics identifiers where appropriate.
* Apply retention and deletion rules to collected analytics data.
* Never treat the absence of a consent interface as consent.
* Fail closed for optional analytics if consent or policy status cannot be verified.
* Keep central application policy and WordPress plugin behavior consistent.
* Document the distinction between cookie consent and other applicable legal bases.

Do not claim legal compliance merely because a consent banner exists.

## 11. BROWSING HISTORY AND PAGE-VIEW ANALYTICS

When broader analytics are permitted, record eligible page-view events on connected websites.

Potential event fields:

* Website ID.
* Workspace ID.
* Visitor ID.
* Session ID.
* Event type.
* Sanitized page path.
* Optional page title.
* Event timestamp.
* Optional sanitized referrer origin.

Requirements:

* Only track pages where the connector is installed and tracking is permitted.
* Exclude URL query strings and fragments by default.
* Do not collect password fields, payment data, form contents, keystrokes, or page contents.
* Do not inspect unrelated browser tabs or unrelated websites.
* Support excluded paths for account, checkout, payment, and other sensitive pages.
* Provide configurable tracking exclusions.
* Deduplicate repeated event submissions when appropriate.
* Apply request rate limits and payload-size limits.
* Use bounded event batching.
* Avoid unnecessary network requests.
* Respect consent withdrawal and plugin disablement promptly.
* Clearly show the active tracking mode in the dashboard.

The operator may view a permitted timeline of visited pages with timestamps.

The timeline must not imply complete browsing history outside the connected and permitted websites.

### Visit count

Define a visit as a session, not as a single page view.

Use a configurable inactivity threshold to start a new visit. Update the current session when additional eligible activity occurs within that threshold.

Avoid incrementing visit counts for every polling request or page-view event.

Document how deleted sessions, multiple tabs, and identifier resets affect visit counts.

## 12. COUNTRY, IP ADDRESS, AND BROWSER INFORMATION

### Country estimation

Optionally estimate country or region using a reputable local IP geolocation database or service.

Prefer an optional local database when practical and permitted by its licensing terms, to minimize external service dependencies and costs.

Requirements:

* Display country as estimated.
* Support unavailable and unknown results.
* Do not claim exact physical location.
* Do not make tracking depend on a paid geolocation API.
* Avoid sending personal data to third-party services without appropriate configuration and authorization.

### IP address handling

Do not store raw IP addresses permanently in general visitor profiles by default.

If IP processing is necessary and lawful for a documented security purpose:

* Keep it in a separate, restricted security record.
* Minimize retention.
* Mask it in routine views where practical.
* Limit access to authorized roles.
* Never expose it across workspaces.
* Never use it as the visitor's sole identity.
* Never use it to block visitors in this version.

Handle reverse proxies safely. Trust forwarding headers only from explicitly configured trusted proxies.

Do not blindly trust `X-Forwarded-For` or similar client-controlled headers.

### Browser and operating system

Where permitted, collect coarse browser and operating system information from the user agent.

Avoid browser fingerprinting, unnecessary device characteristics, and high-entropy identifiers.

## 13. VISITOR BLOCKING: VISITOR ID ONLY

Implement visitor blocking using the opaque visitor identifier, scoped to the relevant website and workspace.

Do not implement IP-based blocking.

Authorized operators must be able to:

* Block a visitor.
* Unblock a visitor.
* See the current block status.
* Record an optional reason.
* See when the block was created.
* See which operator performed the action.

### Enforcement

The central server must enforce the block.

A blocked visitor must not be able to start a new conversation or send messages when prohibited by the block policy.

Do not rely on hiding the widget or using JavaScript alone.

Use generic denial messages that do not reveal private moderation details.

Record block and unblock actions in the audit log.

Allow workspace owners to configure whether an existing conversation becomes read-only or closed after blocking.

Document that visitor-ID-only blocking is not guaranteed to identify the same person after browser storage is cleared, another browser is used, or the identifier is replaced.

Do not use fingerprinting, IP matching, or covert cross-site identity resolution to circumvent this limitation.

Validate all visitor and conversation associations on the server to prevent ID substitution and insecure direct object references.

## 14. DATABASE DESIGN

Create versioned migrations for a normalized MySQL/MariaDB schema.

At minimum, provide the following entities.

* `users` — ID, email, password hash, status, created timestamp, updated timestamp, last login timestamp.
* `workspaces` — ID, name, owner user ID, status, created timestamp, updated timestamp.
* `workspace_members` — ID, workspace ID, user ID, role, membership status, created timestamp.
* `websites` — ID, workspace ID, name, canonical origin, status, tracking policy, created timestamp, updated timestamp.
* `site_credentials` — ID, website ID, secret hash, non-secret key prefix, creation timestamp, last-used timestamp, revocation timestamp.
* `visitors` — ID, workspace ID, website ID, securely designed visitor-token representation, first-seen timestamp, last-seen timestamp, visit count, optional name, optional email, optional phone, consent state, created and updated timestamps.
* `visitor_sessions` — ID, workspace ID, website ID, visitor ID, start timestamp, last activity timestamp, optional end timestamp.
* `visitor_events` — ID, workspace ID, website ID, visitor ID, session ID, event type, sanitized page path, optional sanitized page title, optional referrer origin, event timestamp, creation timestamp.
* `visitor_contact_submissions` — ID, workspace ID, website ID, visitor ID, optional name, optional email, optional phone, submission timestamp.
* `conversations` — ID, workspace ID, website ID, visitor ID, status, optional assigned operator, created and updated timestamps, optional closed timestamp.
* `messages` — ID, workspace ID, conversation ID, sender type, optional sender ID, client message ID, message body, creation timestamp, optional delivery timestamp.
* `visitor_blocks` — ID, workspace ID, website ID, visitor ID, operator who blocked the visitor, optional reason, status, creation timestamp, optional revocation timestamp, optional operator who revoked the block.
* `consent_records` — ID, workspace ID, website ID, optional visitor association, consent category, decision, policy version, recorded timestamp, optional withdrawal timestamp.
* `website_settings` — ID, workspace ID, website ID, widget configuration, tracking configuration, retention configuration, updated timestamp.
* `audit_logs` — ID, optional workspace ID, optional actor user ID, action, resource type, resource ID, timestamp, minimal structured metadata.

Add foreign keys, indexes, uniqueness constraints, and transactional operations where appropriate.

Store JSON settings only after validating them against an explicit schema.

Never put plaintext secrets, passwords, full message bodies, or unnecessary personal information in audit logs.

Design deletion and retention behavior for all related records.

A hashed visitor token must be usable for secure lookup without storing a recoverable copy of the original token. Ensure visitor-token design remains compatible with browser token rotation and block enforcement.

Use idempotency mechanisms for messages and event submissions where appropriate.

## 15. API DESIGN

Use a versioned API, such as `/api/v1/`.

Keep these trust boundaries separate:

1. Authenticated dashboard requests.
2. Trusted server-to-server WordPress integration requests.
3. Public visitor widget requests.

Every endpoint must:

* Authenticate as appropriate.
* Establish the correct workspace and website.
* Verify resource ownership and permissions.
* Validate input types, lengths, and allowed values.
* Use prepared statements.
* Apply rate limits.
* Enforce request-size limits.
* Return only authorized fields.
* Avoid leaking whether private resources exist.
* Use consistent response formats.
* Provide useful error handling without exposing secrets or stack traces.

Use pagination and incremental polling cursors.

Ensure polling requests cannot be manipulated to read other conversations or workspaces.

Do not use public numeric IDs as authentication credentials.

Prevent message replay and duplicate creation.

## 16. LIVE UPDATES AND SHARED-HOSTING PERFORMANCE

Use short polling for the initial release.

Requirements:

* Incremental message fetching.
* Incremental visitor activity fetching.
* Bounded polling frequency.
* Exponential backoff on errors.
* Reduced polling in inactive browser tabs.
* Reconnection after temporary failures.
* Idempotent message submission.
* Efficient database indexes.
* Pagination for large inboxes.
* Bounded retention-cleanup batches.
* No uncontrolled polling loops.

Keep transport logic modular so WebSockets can be introduced later without rewriting the entire messaging application.

Do not promise a particular traffic capacity without measuring performance on the actual hosting environment.

Provide configuration options to adjust polling intervals and limits.

## 17. PRIVACY, RETENTION, EXPORT, AND DELETION

Implement configurable retention for:

* Visitor events.
* Visitor sessions.
* Contact submissions.
* Visitor profiles.
* Conversations and messages.
* Security records.
* Consent records, subject to applicable retention requirements.

Provide:

* Manual cleanup.
* Optional cPanel cron cleanup.
* Dry-run cleanup.
* Batched cleanup.
* Workspace data export.
* Workspace deletion with confirmation.
* Appropriate visitor-data deletion tools.
* Audit records for sensitive administrative actions.
* Documented backup retention.
* Documented restoration procedures.

Do not delete central history when a WordPress plugin is deactivated or removed.

Do not allow workspace owners to delete or export another workspace's data.

Account for dependent records and applicable retention obligations when deleting data.

Explain that backups may retain deleted data until the relevant backup expires.

Do not retain all tracking data forever by default.

Keep optional analytics retention configurable and independent from conversation retention.

Provide documentation on data collection, purpose, retention, and deletion.

## 18. SECURITY REQUIREMENTS

Implement and verify:

* Password hashing.
* Session security.
* CSRF protection.
* XSS prevention.
* SQL injection prevention.
* Authentication and authorization checks.
* Tenant isolation.
* Credential rotation and revocation.
* Rate limiting.
* Secure error handling.
* Secret redaction.
* Public API restrictions.
* Origin validation.
* Safe message rendering.
* Safe URL sanitization.
* Consent enforcement.
* Visitor block enforcement.
* Secure file permissions and configuration.
* Database migrations.
* Audit logging.
* Backup and restoration procedures.

Never trust a browser-provided workspace ID or role.

Never assume a visitor ID proves identity.

Never expose administrative APIs through the public widget.

Never store secrets in version control.

Provide a `.gitignore` and a safe example configuration file without real credentials.

Do not log passwords, secrets, session tokens, complete message bodies, or unnecessary personal data.

Use dependency versions compatible with the supported environment, and document known security limitations.

## 19. AUTOMATED TESTING REQUIREMENTS

Create and run automated tests.

### Authentication and tenancy

* Unauthenticated users cannot access the dashboard.
* User A cannot read User B's data.
* Agents cannot perform owner-only actions.
* Revoked members lose access.
* Suspended accounts lose access to protected operations.
* Modified resource IDs cannot bypass authorization.

### WordPress connection

* Valid credentials work.
* Invalid credentials are rejected.
* Revoked credentials stop working.
* Rotated credentials behave correctly.
* Website A cannot access website B's data.
* Plugin deactivation does not erase central history.

### Chat

* Visitors can start a permitted conversation.
* Operators can reply.
* Messages persist centrally.
* Polling returns only authorized messages.
* Retries do not create duplicates.
* Public users cannot retrieve arbitrary transcripts.
* Message output is protected against XSS.

### Visitor tracking

* Essential chat works when analytics are disabled.
* Optional analytics do not execute before required consent.
* Consent withdrawal stops future optional collection.
* Excluded pages are not tracked.
* URL query strings and fragments are sanitized.
* Repeated events are handled safely.
* Visit counts follow documented session rules.
* Unknown country information does not break profiles.
* Browser metadata is not used to fingerprint visitors.
* Sensitive form values are never collected by the tracking client.

### Visitor blocking

* Authorized operators can block and unblock visitors.
* Blocks are scoped to the correct website and workspace.
* Blocked visitors cannot perform prohibited messaging actions.
* Visitor-ID substitution cannot access another person's profile.
* IP-based blocking does not exist in this release.
* Clearing browser storage is documented as a limitation.

### Retention and privacy

* Dry-run cleanup does not delete data.
* Cleanup removes eligible data in bounded batches.
* Unauthorized exports and deletions are rejected.
* Workspace deletion cannot affect other workspaces.
* Audit logs contain no credentials or full message bodies.
* Consent and retention settings are applied consistently.

Report test results honestly. Separate passing tests, failing tests, tests not run, and known limitations.

## 20. DEPLOYMENT AND DELIVERABLES

Prepare the project for cPanel shared hosting.

Deliver:

1. Complete central PHP application.
2. Versioned database migrations.
3. Installable WordPress plugin ZIP.
4. Front-end widget assets.
5. Automated tests.
6. Example configuration without secrets.
7. Installation and upgrade instructions.
8. cPanel deployment instructions.
9. Database setup instructions.
10. Secure first-owner creation instructions.
11. Cron configuration instructions.
12. Backup and restoration guide.
13. Troubleshooting guide.
14. Security and privacy documentation.
15. API documentation.
16. Known limitations and test report.

The application must not require a separate server or database for each workspace.

The deployment process must not require exposing database credentials publicly.

Do not deploy directly to production without approval and a backup.

If you cannot access my actual hosting account, create the deployment package and explain how I can install it. Do not claim that deployment succeeded when it was not performed.

Do not invent download links or claim ZIP files exist before actually creating them.

## 21. IMPLEMENTATION MILESTONES

Follow these milestones sequentially.

* **Milestone 0 — Inspect.** Inspect the repository and environment, identify risks, and present the plan.
* **Milestone 1 — Foundation.** Implement configuration, database connection, migrations, routing, error handling, and logging.
* **Milestone 2 — Authentication and tenancy.** Implement registration, login, roles, workspaces, membership, platform administration, and isolation tests.
* **Milestone 3 — Website integration.** Implement website registration, pairing, credentials, rotation, revocation, and WordPress connector foundation.
* **Milestone 4 — Messaging.** Implement the visitor widget, message APIs, persistence, polling, and operator inbox.
* **Milestone 5 — Visitor profiles.** Implement opaque visitor identities, contact forms, essential session handling, and profile display.
* **Milestone 6 — Privacy-aware analytics.** Implement consent controls, permitted page-view collection, activity timelines, visit counts, location estimation where available, and retention.
* **Milestone 7 — Visitor blocking.** Implement website-scoped visitor-ID blocking and server-side enforcement.
* **Milestone 8 — Privacy and operations.** Implement exports, deletion, cleanup, audit logs, backup procedures, and documentation.
* **Milestone 9 — Security and QA.** Run the complete test suite, review authorization paths, correct defects, and test clean installation.
* **Milestone 10 — Packaging.** Create the central application package and installable WordPress plugin ZIP. Verify their contents and complete the deployment documentation.

At the end of each milestone, report:

* What was implemented.
* Which files changed.
* Which tests were executed.
* Actual test results.
* Outstanding defects.
* Security concerns.
* Next milestone.

Keep the project runnable after each milestone.

Do not skip tests to make progress appear faster.

## 22. FINAL ACCEPTANCE CRITERIA

The project is complete only when I can:

1. Log in to a central dashboard.
2. Register and manage separate user workspaces.
3. Connect multiple WordPress websites to each workspace.
4. Install the WordPress plugin through the standard WordPress plugin installer.
5. Chat with visitors from the central inbox.
6. Store conversations centrally across sessions.
7. Collect optional name, email, and phone details through a configured form.
8. View visitor profiles and visit counts.
9. View permitted browsing history when analytics is authorized.
10. View estimated country or region when available.
11. Distinguish observed, submitted, and inferred visitor information.
12. Block and unblock visitors by visitor ID only.
13. Keep all workspaces isolated.
14. Operate essential chat when optional analytics is disabled.
15. Enforce the configured privacy and consent policies.
16. Apply retention, export, and deletion controls.
17. Deploy the application using documented cPanel procedures.
18. Install the plugin ZIP on connected WordPress websites.
19. Run and review actual security and automated test results.
20. Receive complete source code, installation files, and documentation.

Start with Milestone 0. Inspect the actual project before making changes. Then continue through the milestones, implementing real functionality, running tests, correcting defects, and packaging the deliverables.

Be transparent about anything that remains incomplete or requires manual configuration. Never substitute a visual mock-up for functioning code or claim that security and privacy have been verified without evidence.

The result must be a maintainable, original live chat product that can begin on shared hosting and evolve to stronger infrastructure when necessary.
