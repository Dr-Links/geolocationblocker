# 4. Security and Privacy Plan

Email credentials can open entire business mailboxes, so the design assumes the server will be attacked and tries to limit what any single failure exposes.

## 4.1 Platform authentication (ordinary users)

- **Registration:** Gmail or Googlemail addresses only. The Gmail address is purely the sign-in identity: the platform sends it account emails (confirmation, password reset, approval/expiry notices) and never forwards mailbox content to it. Normalisation: lowercase, `googlemail.com` → `gmail.com`, dots removed from the local part, `+tag` removed. `UNIQUE(email_normalized)` blocks duplicates such as `j.doe+x@gmail.com` vs `jdoe@gmail.com`. The address must be **verified** with an emailed link (single-use, 24 h, SHA-256 hashed in DB) before the account appears in the admin's pending queue. Responses don't reveal whether an address is already registered.
- **Passwords:** argon2id (OWASP baseline: m = 19 MiB, t = 2, p = 1; tuned on the VPS to ~250 ms), minimum 10 characters, checked against a breached-password list (k-anonymity Have I Been Pwned range API, optional) and a local common-password list. No composition rules.
- **Sessions:** short-lived access token (JWT, 10 min, EdDSA-signed, carries only `sub`, `sid`, `kind`) + opaque refresh token (256-bit random, stored hashed, rotated on every use). Reusing an old refresh token revokes the whole session family (theft detection). Mobile stores the refresh token in `expo-secure-store`. Every request re-checks account status, so suspension takes effect within one request.
- **Session management:** user can view devices/sessions and revoke any; password change revokes all other sessions.
- **Rate limiting:** per IP and per normalised email (e.g. 5 failures/15 min per account → progressive delay; 20/hour → 1 h lockout; per-IP 100/hour), implemented in PostgreSQL counters so it survives restarts, plus Caddy request limits. Same generic error for wrong password/unknown user.
- **Account recovery:** reset link to the verified Gmail (single use, 30 min), revokes sessions on use; no security questions. Admin can trigger a reset email but never sees or sets the password.
- **No 2FA for ordinary users in v1** (as specified); the design leaves room to add TOTP later.

## 4.2 Administrator

- Created only by a server-side CLI (`pnpm admin:create`) run over SSH; there is no registration route for admins and the role column cannot be written by the API DB role.
- Separate origin `admin.<domain>`, separate cookie (`__Host-` prefix, `Secure`, `HttpOnly`, `SameSite=Strict`), CSRF tokens on all state-changing requests, strict CSP, 30-min idle / 8-h absolute session lifetime.
- **Password + mandatory TOTP** (RFC 6238; replay-protected) with 10 one-time recovery codes; WebAuthn/passkey optional. Optional IP allow-list in Caddy.
- Destructive actions (delete user, purge data, change quota to below usage) require re-entering TOTP.
- **Password recovery:** reset link sent to the designated admin recovery address (configured in `platform_settings`, ideally a mailbox that is *not* hosted on this platform). The reset still requires a TOTP code or a recovery code.
- **Emergency recovery (lost password *and* TOTP):** documented in `06-deployment-and-operations.md` §6.6 — requires SSH or authorised database access; generates a one-time token; never involves plaintext passwords or a hidden backdoor; logged in `audit_log`.
- Admin views mailbox **metadata and health only** (address, provider, status, error codes, counts, sizes). The admin API's DB role has no grants on message content tables.

## 4.3 Secrets and encryption

| Secret | Protection |
|---|---|
| Mailbox passwords / OAuth tokens | AES-256-GCM with a **credential master key** loaded from a file mounted into the container (`/run/secrets/…`), not in the DB, not in git. Associated data = `mailbox_id`, so ciphertext can't be swapped between rows. `key_version` enables rotation (re-encrypt job). |
| Attachment & MIME blobs | Per-user DEK (`user_keys.wrapped_dek`, wrapped by a separate KEK file). Deleting the DEK makes that user's objects — including copies in versioned buckets/backups — unreadable. |
| Admin TOTP secret | Encrypted with the credential key |
| JWT signing key, DB passwords, S3 keys, FCM service account | Secret files, `0400`, owned by the container user; rotated on staff/host change |
| Backups | Encrypted client-side (pgBackRest repo cipher / `age`) before upload; key stored offline by you too |

Upgrade path: move the KEKs to a cloud KMS or HashiCorp Vault/OpenBao when you outgrow a single VPS. Limitation: on a single VPS, root on that host can read the key files; KMS reduces but doesn't eliminate that.

Bodies and search index in PostgreSQL are **not** application-encrypted (full-text search needs plaintext). They are protected by disk encryption (where the VPS provider supports it), DB access control, and encrypted backups. Documented.

## 4.4 Application security controls

- **Input validation:** every route has a `zod`/JSON-schema for params, query and body (Fastify rejects unknown fields). Email addresses parsed with a proper RFC parser; header injection prevented by Nodemailer's encoding and our own CR/LF rejection.
- **SQL injection:** parameterised queries only (Kysely); raw SQL only via tagged templates with parameters; lint rule bans string-concatenated SQL.
- **IDOR / broken access control:** user scoping + composite FKs + RLS (see `03` §3.1); automated tests attempt cross-tenant access on every route.
- **XSS:** email HTML sanitised server-side (allow-list) *and* rendered in a WebView with JavaScript disabled, no file access, navigation intercepted (links open externally after showing the real URL), remote images blocked until the user allows per message/sender. Admin SPA uses React escaping + CSP `script-src 'self'`.
- **CSRF:** mobile uses bearer tokens (not cookies); admin web uses SameSite=Strict cookies + double-submit token.
- **SSRF:** users supply IMAP/SMTP hostnames — the connector resolves DNS and **refuses private, loopback, link-local and metadata addresses** (10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, ::1, fc00::/7, fe80::/10), and allows only mail ports (143, 993, 25, 465, 587, 2525 + explicit admin-approved extras). Otherwise a user could probe the VPS's internal network.
- **Uploads:** size limits, magic-byte detection, no server-side execution or conversion, stored under random keys, served with `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff` through short-lived signed URLs or streamed by the API after authorisation.
- **Logging:** `pino` with a redaction list (`password`, `authorization`, `secret*`, `token*`, `cookie`, IMAP `LOGIN`/`AUTHENTICATE` lines, message bodies, subjects). IMAP/SMTP protocol debug logging is off in production. Push notifications and error reports never include subjects/senders.
- **Dependencies:** lockfile, Renovate/Dependabot PRs, `pnpm audit` + OSV scanning in CI, container image scanning (Trivy), monthly base-image rebuilds.
- **Transport:** HTTPS only (HSTS), TLS 1.2+; IMAP/SMTP only with TLS or STARTTLS (plaintext not offered), certificate verification always on.
- **Server hardening:** SSH keys only, no root login, firewall (only 22/80/443 inbound), unattended security upgrades, fail2ban on SSH, Docker containers non-root with read-only FS where possible, PostgreSQL not exposed publicly.
- **OAuth:** minimal scopes; PKCE for the mobile flow; tokens never sent to the device.

## 4.5 Phishing and malicious attachments

Signals computed at ingest and stored in `messages.security_flags`:
- `Authentication-Results` (SPF/DKIM/DMARC) from the receiving server — failures shown as "Sender could not be verified".
- Display-name/address mismatch, look-alike domains (punycode/homoglyphs, edit distance to the user's own domains and well-known brands), Reply-To differing from From domain.
- Links: visible text URL ≠ actual href domain, IP-literal URLs, URL shorteners, `data:`/`javascript:` links (stripped). Optional Google Safe Browsing v4 Lookup API (free, non-commercial terms must be checked) or a self-hosted list.
- Attachments: dangerous extensions, double extensions (`invoice.pdf.exe`), extension ≠ detected type, macro-enabled Office, encrypted archives.
- **ClamAV** scan (optional container) for attachments when downloaded.

UI wording is deliberately cautious: "⚠ This message has signs of phishing" / "Not scanned" / "No threat detected by ClamAV — this does not guarantee the file is safe". Nothing is opened automatically; links require a tap that shows the destination first.

## 4.6 Privacy

- Data minimisation: the admin sees metadata, not content; audit logs contain IDs and action names, not subjects or addresses of correspondents.
- Users get a clear privacy notice: what is stored, retention, that the operator hosts their mail copies, backup ageing (35 days), and that deletion does not affect their original mailboxes.
- Push notification text never contains sender or subject.
- Depending on where you and your users are, data-protection laws (e.g. GDPR, NDPR, UK GDPR) may apply; the deletion and export capabilities here support them, but legal review is your responsibility.

## 4.7 Operational responsibilities (yours)

Keep the VPS patched (automated, but check monthly), protect SSH keys and the secrets directory, keep an offline copy of backup encryption keys and admin recovery codes, review the admin dashboard alerts, run the monthly restore test, and rotate keys if a laptop or host is compromised.
