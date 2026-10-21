# 8. Risks, Mitigations and Open Decisions

## 8.1 Significant risks

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| 1 | Shared cPanel can't run persistent workers / blocks outbound mail ports | Sync and sending silently fail | Backend on a VPS (see `01` §1.3); verify with the checklist |
| 2 | **Gmail OAuth restricted-scope verification + annual CASA assessment** | Can't onboard Gmail/Workspace mailboxes via OAuth at scale; testing-mode tokens expire after 7 days | Start the Google verification early; use app passwords meanwhile; decide whether Gmail support is worth the cost |
| 3 | Microsoft tenants disabling SMTP AUTH / requiring admin consent | Some M365 mailboxes can't send via SMTP | Graph `sendMail` fallback; clear error explaining tenant policy |
| 4 | Duplicate sends after crashes/timeouts | Embarrassing for business users | Frozen MIME + fixed Message-ID, idempotency keys, lease/attempt rows, `uncertain` state never auto-retried, Sent-folder check |
| 5 | Credential database leak | Attacker gains entire business mailboxes | Encryption with keys outside DB, SSRF guard, least-privileged DB roles, patching, no credentials to devices, prompt rotation runbook |
| 6 | Cross-tenant data exposure bug | Severe privacy breach | API scoping + composite FKs + RLS; automated isolation tests on every route |
| 7 | Single VPS failure | Downtime; possible data loss | Off-site encrypted backups with PITR, tested monthly; restore runbook; infrastructure-as-code for quick rebuild |
| 8 | Hosting provider IP reputation / per-IP limits on cPanel Dovecot/Exim (cPHulk, fail2ban) | Mailbox lockouts or connection refusals | Never retry bad passwords; 1–2 connections per mailbox; backoff; document whitelisting the VPS IP on your own cPanel servers |
| 9 | Malicious HTML / attachments | Device compromise, phishing | Server sanitising + JS-disabled WebView + remote-content blocking + warnings + optional ClamAV |
| 10 | Storage growth beyond VPS disk | Outage | Attachments in object storage; quotas; retention; disk alerts |
| 11 | Rich-text output renders differently across clients | Poor-looking mail | Conservative HTML, plain-text alternative, cross-client testing in M6 |
| 12 | Play Store policy changes (permissions, target SDK, data-safety form) | Release delays | Keep SDK current; accurate data-safety declarations; minimal permissions |
| 13 | Operator burden (one person running servers) | Missed patches/backups | Automation, alerts, dashboard backup status, monthly checklist |
| 14 | Push delivery is best-effort (Doze, OEM battery optimisers) | Late notifications | FCM high-priority for new mail; document limits; app shows true state on open |
| 15 | Legal/compliance (handling third-party business email) | Liability | Privacy notice, terms, data-processing statements, deletion workflows; get local legal advice |

## 8.2 Decisions

Resolved on 21 Oct 2026:
- **Hosting:** your cPanel account (M1 built for it; M2 feasibility to be measured with `check:outbound`).
- **Time zone:** each user's own time zone (from their phone).
- **Gmail:** sign-in identity only; no mailbox mail is sent to it. Connecting Gmail-hosted *business mailboxes* (Google Workspace) is still question 2 below, for M4b.

Still open (they don't block M1):

1. **Outbound mail ports on your cPanel account:** run `node dist/cli.js check:outbound` (see `milestones/M1.md` step 9) and send the output. This decides how M2 sync can work.
2. **Gmail/Google Workspace mailboxes:** (a) support via app passwords only for now, (b) also start Google OAuth verification (cost/time above), or (c) skip Gmail-hosted mailboxes initially?
3. **Microsoft 365/Outlook mailboxes:** needed at launch or later (M4b can be deferred)?
4. **Default storage quota** (proposal 5 GB/user) and **retention** (bodies 365 days, attachments 180 days)?
5. **ClamAV:** include (needs a server that can run it; usually not possible on shared cPanel) or skip initially and show "Not scanned"?
6. **Undo window:** 10 s default (configurable 5–30)?
7. **User web client:** confirm it's deferred (admin web only in v1).
8. **App name and package id** (e.g. `com.yourcompany.mail`) for the Android project.
