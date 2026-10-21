# 9. Testing Plan

Automated tests never touch real customer mailboxes or send real email. Integration tests use **local fake servers** (GreenMail for IMAP/SMTP, or Dovecot + a capture-only Postfix in containers) and a disposable PostgreSQL. Manual milestone tests use dedicated test mailboxes you create.

| Area | What | How |
|---|---|---|
| Unit | Gmail normalisation, calendar-month math (month ends, leap years, DST), threading algorithm, MIME build, HTML sanitiser, phishing heuristics, backoff schedules, quota maths | Vitest |
| Database | Every constraint and index in `db/schema-draft.sql`; RLS policies; column grants; migrations up/down on an empty and a populated DB | Vitest + Testcontainers Postgres; `pgTAP` optional |
| API | All routes: validation errors, auth required, status codes | Fastify `inject` |
| AuthN/AuthZ | Login rate limits, lockout, refresh rotation & reuse detection, session revocation, pending/suspended/expired users blocked on every route, admin routes reject user tokens, admin TOTP required | API tests |
| **User isolation** | Generated test: for every route taking an ID, user A tries B's IDs → 404 and no side effects; RLS test with direct SQL as `app_api` | API + DB tests (runs in CI on every PR) |
| Mailbox connection | Discovery chain with mocked DNS/HTTP; TLS mismatch; wrong password (no retry); SSRF blocked hosts | Integration with fake servers |
| Incoming sync | New mail, flags both directions, moves, deletes, UIDVALIDITY reset, server without CONDSTORE/IDLE, reconnect after outage, no duplicates after job replays | GreenMail/Dovecot |
| Outgoing | Reply-from-correct-mailbox, CC/BCC handling (BCC not in headers), attachments, Sent append | Capture SMTP |
| **Duplicate-send prevention** | Kill worker before/after DATA; network timeout after DATA; repeated POST with same idempotency key; two workers racing | Fault-injection SMTP proxy |
| Undo / scheduling | Undo at 9.9 s vs 10.1 s; scheduled send across DST in several zones; worker down at scheduled time then recovers | Fake clock |
| Offline | Op queue replay, idempotent replays, draft conflict copies, offline send never shown as sent | Mobile unit tests + Detox/Maestro E2E on emulator |
| Multi-device | Two clients via change feed; notification dedupe | Integration |
| Account expiry & reactivation | Expiry job, request-time enforcement at the boundary second, scheduled messages paused and **not** sent after reactivation until user confirms | Fake clock |
| Storage quota | Warnings, eviction order, storing-paused mode, server mail untouched | Integration |
| Mailbox-specific deletion | Purge one mailbox; checksum all rows/objects of other mailboxes and users before/after | Integration |
| Permanent user deletion | All tables empty for that user; objects gone; DEK destroyed; stale queued jobs abort; restore + ledger replay doesn't resurrect | Integration + restore test |
| Backup restoration | Monthly automated restore into scratch container with verification | Scheduled job on VPS |
| Security | Dependency/OSV scan, Trivy, OWASP ZAP baseline against staging, malicious-HTML corpus through sanitiser, upload of polyglot/mislabelled files, header injection attempts | CI + pre-release |
| Error recovery | Postgres restart, worker crash, object storage outage, FCM outage | Chaos-style integration tests |
| Performance | 50 users × 5 mailboxes, 100k messages each mailbox seeded; inbox list p95 < 300 ms, search p95 < 1 s, IDLE fan-out memory | k6 + seeded DB on staging |

Definition of done for every feature: implemented, automated tests passing in CI, manually verified by you at the milestone, and limitations written down.
