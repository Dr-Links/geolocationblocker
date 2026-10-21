# 5. Staged Development Roadmap

Each milestone ends with something you can install and test yourself. I won't start the next milestone until you've tested the current one and reported back.

## Changes from your suggested order (and why)

1. **Account expiry moves into Milestone 1.** Approval *is* the start of the paid month, so approval without expiry would be half a feature. M1 includes the calendar-month computation, request-time enforcement and the expiry job. Admin *monitoring* stays in M9.
2. **Object-storage abstraction and the job queue (pg-boss) are set up in M1–M2**, because sync (M3), sending (M4) and scheduling (M6) all depend on them.
3. **Undo-send and the idempotent send state machine move into M4** (sending), not M6. Building sending without duplicate-send protection and adding it later is how duplicate emails happen. M6 adds *scheduling* on top of the same state machine.
4. **Sanitised HTML rendering and basic phishing link handling move into M3**, since rendering untrusted HTML safely is a prerequisite for showing any email.
5. **Google/Microsoft OAuth gets its own milestone (M4b)** after IMAP/SMTP works, because it depends on provider app verification that you need to start early (see `07`).

## Milestones

| # | Objective | Main deliverables | You test |
|---|---|---|---|
| **M1** | Foundation: auth, admin, approval, access periods | Monorepo; Docker Compose (Postgres, API, worker, Caddy); migrations from the schema draft; register (Gmail-only, verification email via your cPanel SMTP), login, refresh rotation, logout, session list; admin CLI bootstrap; admin web (login + TOTP, pending list, approve/reject, suspend/reactivate, renew, password-reset email, audit log view); expiry job + request-time enforcement; Android app shell with login/registration/pending/suspended/expired screens; CI (lint, typecheck, tests) | Register with a Gmail; verify; see "pending"; approve in admin; use the app; set expiry to 2 min in a test build and watch auto-suspension; reactivate |
| **M2** | One real mailbox connection | Discovery chain (autoconfig, ISPDB, SRV, Autodiscover, cPanel guesses); IMAP+SMTP test; TLS cert handling; SSRF guard; encrypted credentials; manual settings form; status/health; auth-failure handling and credential update flow; object-storage adapter (local disk + S3) | Connect a cPanel mailbox and one from another host; enter wrong password; change password on cPanel and update it in the app |
| **M3** | Incoming sync + reading | Sync engine (IDLE INBOX, folder polling, CONDSTORE/QRESYNC, UIDVALIDITY handling, dedup); folder list; per-mailbox inbox; message view with sanitised HTML in locked WebView, remote-image blocking, link warnings; read/unread, flag, move, delete, archive, spam/not spam via `mailbox_operations` with pending/failed states; attachment metadata + download | Send mail to the mailbox from outside, see it arrive with the app closed then opened; mark read on webmail and see it reflect; delete in app and confirm on webmail |
| **M4** | Sending | Compose (plain + basic rich text), reply, reply all, forward with correct default sender; To/CC/BCC; MIME build; send state machine with **undo window**, idempotency, retries, uncertain state; Sent folder append/match; unified Sent view; per-mailbox rate/recipient limits; failure notifications (in-app) | Send, undo within 10 s, send again; kill the worker mid-send; send to an invalid domain; reply from the correct mailbox |
| **M4b** | Google & Microsoft OAuth | Google OAuth (testing mode first) with XOAUTH2 IMAP/SMTP; Microsoft Entra app with IMAP/SMTP OAuth, Graph `sendMail` fallback; token refresh, revocation handling | Connect a Gmail/Workspace and an Outlook/M365 mailbox |
| **M5** | Unified inbox, conversations, search | Threading algorithm; unified inbox with mailbox labels + filter; conversation/message view toggle; full-text search + filters + saved searches; star/flag/priority display | Search across mailboxes; verify unrelated same-subject mails don't merge |
| **M6** | Composer depth, drafts, scheduling | 10tap rich-text editor; email-safe HTML + text alternative; inline images; attachments upload with provider size checks; signatures (per-mailbox default); templates & quick replies; server drafts with autosave and versioning; scheduled send with time zones/DST; cancel/edit scheduled | Schedule across a DST boundary (test zone); check rendering in Gmail/Outlook/Apple Mail |
| **M7** | Push, offline, multi-device | FCM integration; "New email received at …" notifications; device management; change feed sync; encrypted SQLite cache; offline op queue; offline compose/outbox; conflict handling | Airplane mode: read, reply, queue; reconnect; two phones on one account |
| **M8** | Storage and data lifecycle | Usage accounting; quota warnings; retention/eviction; storing-paused mode; mailbox disconnect (retain/purge); blob GC; per-user dedup | Lower your quota to force eviction; purge one mailbox and check others are intact |
| **M9** | Admin monitoring, reminders, security, backups | Admin dashboard (mailbox health, send failures, queue health, quotas, expiry calendar, storage); permanent user deletion with crypto-shred + deletion ledger; follow-up reminders; phishing heuristics + ClamAV; blocklist; backup automation (pgBackRest + object storage), backup status in dashboard | Delete a test user; restore last night's backup into a scratch DB and confirm the deleted user stays deleted |
| **M10** | Production readiness | Full test suite run; load test (50 users × 5 mailboxes); security review & dependency audit; runbooks; monitoring/alerts; Play Store internal testing → production; privacy notice | Pilot with 2–3 real users |

Rough effort: each milestone is typically 1–3 working sessions of implementation plus your testing; M3, M4 and M7 are the largest.

## What every milestone delivery contains

Objective; list of files created/modified; complete code for those files; install/config commands; `.env.example` changes (no real secrets); migrations; how to run and test; expected results; known limitations. All code is committed to this repository on a branch, with automated tests where the feature allows.

## Proposed repository layout

```
apps/
  backend/         Fastify API, admin API, workers (same codebase, different entrypoints)
    src/routes/  src/admin/  src/sync/  src/send/  src/jobs/  src/crypto/  src/storage/
    migrations/    SQL migrations
    test/          unit, integration (Postgres in Docker), fake IMAP/SMTP servers
  mobile/          Expo React Native app (Android first)
  admin-web/       React + Vite admin dashboard
packages/
  shared/          zod schemas, API types, constants (no Node/RN-specific code)
infra/
  docker-compose.yml  Caddyfile  backup/  scripts/
docs/              this plan, runbooks
db/schema-draft.sql
```
