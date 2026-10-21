# 1. Requirements Summary and Hosting Feasibility

## 1.1 Requirements summary

A multi-tenant email client platform. Each **platform user** (one normalised Gmail address = one account) connects any number of **mailboxes** (cPanel, other IMAP/SMTP hosts, Google, Microsoft) and reads, sends, searches and organises mail from them in a React Native app. A single **central administrator** (you) approves accounts after an external payment and controls access periods.

| Area | Requirement (condensed) | Where it is designed |
|---|---|---|
| Accounts | Gmail-only registration, email verification, pending → approved by admin, suspended/expired/rejected/deleted states, no self-promotion | `03-database-design.md` §users, `04-security-privacy.md` §auth |
| Admin | One admin, no public registration, stronger auth (password + mandatory TOTP), separate web surface, audit trail, no access to mail content via the UI, password recovery via designated email, emergency recovery procedure | `04` §admin, `06` §emergency recovery |
| Billing | No in-app payment. Approval starts a **calendar-month** access period; automatic suspension at expiry; only admin can reactivate; data retained | `02-architecture.md` §account lifecycle |
| Mailboxes | Autodiscovery → test → save; manual settings; app passwords; OAuth for Google/Microsoft; password-change detection, bounded retries | `02` §mailbox connection |
| Sync | Backend sync that runs with apps closed; IDLE/polling/provider push; checkpoints; no duplicates; honest sync state | `02` §sync engine |
| Inbox | Unified + per-mailbox; conversations (header-based threading) + message view; full action set | `02` §threading, `05-roadmap.md` M3/M5 |
| Sending | Correct sender mailbox, undo window (~10 s), queued/sending/sent/failed, duplicate-send prevention, sent-folder sync, scheduled send, drafts | `02` §send pipeline |
| Composer | Rich text, inline images, signatures, templates, quick replies, autosave, plain-text alternative | `02` §composer |
| Attachments | Provider limits respected, safe upload validation, previews, dedup storage | `02` §attachments |
| Search | All mailboxes incl. sent, filters, saved searches, tenant-scoped | `02` §search |
| Contacts | **Explicitly out of scope** (no address book, groups, import/export) | — |
| Spam | Provider spam + mark spam/not spam + platform-level blocklist (clearly labelled as platform-only) | `02` §spam |
| Reminders | Stars, flags, priority, follow-up reminders run on the backend | `02` §jobs |
| Bulk | Legitimate business multi-recipient mail with provider limits, BCC safeguards; not a marketing tool | `02` §bulk |
| Notifications | Every new email by default, text = "New email received at <mailbox>" (no sender/subject), multi-device dedupe | `02` §notifications |
| Offline | Read cached mail, compose, drafts, queue; conflict policy; encrypted local storage | `02` §offline |
| Storage | Default quota, admin-adjustable, warnings, retention-based eviction, never deletes server mail | `02` §storage |
| Deletion | Mailbox disconnect (retain vs purge), full user purge, backup ageing, no resurrection by stale jobs | `02` §lifecycle, `06` §backups |
| Security | Argon2id, rotating refresh tokens, encrypted credentials with keys outside DB, RLS + composite FKs, input validation, rate limiting, audit | `04` |
| Phishing | Link/attachment heuristics, optional ClamAV, "not scanned" shown honestly | `04` §phishing |
| Backups | Scheduled, encrypted, off-site, verified, restore-tested | `06` §backups |
| Updates | Controlled CI/CD, migrations, rollback; mobile OTA limits explained | `06` §updates |
| Testing | Full plan incl. isolation, duplicate-send, expiry, deletion, restore | `09-testing-plan.md` |

## Decision (21 Oct 2026)

You chose to host on your **cPanel account**. Milestone 1 (accounts, admin, approval, expiry) is built for it: one Node.js app per subdomain via *Setup Node.js App*, cPanel PostgreSQL (13+, no extensions, no superuser) and a 1-minute cron job. See `docs/milestones/M1.md`.

The concerns below still apply from **Milestone 2** onward (mailbox sync and sending). Before M2 we will measure your account with `node dist/cli.js check:outbound`. If outbound mail ports are open, M2 will use a **cron-driven sync**: each run polls mailboxes for about 50 seconds and exits, so it needs no permanent process. New mail then arrives within about 1–2 minutes instead of instantly, and sending happens on the next minute after the undo window. If the ports are blocked, we will discuss the smallest workaround with you then.

## 1.2 Hosting feasibility: shared cPanel

I cannot inspect your hosting account from here, so this assessment is based on how cPanel shared hosting normally behaves. **Section 1.4 is a checklist you can run to confirm or overturn it for your specific plan.**

| Need | Typical shared cPanel reality | Verdict |
|---|---|---|
| PostgreSQL | cPanel *can* offer PostgreSQL, but many hosts disable it or ship an old version. You get no superuser, cannot create roles freely (RLS roles above need `CREATE ROLE`), and usually cannot install extensions (`citext`, `pg_trgm`). No WAL archiving or point-in-time recovery. | ⚠️ Partial at best |
| Backend runtime (Node.js) | "Setup Node.js App" (CloudLinux + Passenger) exists on many hosts. Passenger starts the app **on HTTP request** and stops idle processes. | ⚠️ OK for a request/response API only |
| Persistent background workers | Long-running processes are typically killed by the host (CPU/process-time limits, LVE limits, "no daemons" policy in the terms of service). | ❌ Not reliable |
| IMAP IDLE (real-time sync) | Needs one long-lived TCP connection per mailbox, 24/7. 20 users × ~5 mailboxes ≈ 100 permanent sockets. | ❌ Not feasible |
| Scheduled jobs | cron available, but often minimum 1–15 min intervals and each run is a fresh process. Undo-send (10 s) and on-time scheduled sends need sub-minute precision. | ⚠️ Too coarse |
| Outbound SMTP/IMAP to other hosts | Many shared hosts block outbound connections on ports 25/465/587 (CSF `SMTP_BLOCK`) and sometimes 993 to third-party servers, to stop spam. This would break sending from mailboxes hosted elsewhere. | ❌ Frequently blocked |
| Push notifications (FCM) | Outbound HTTPS is usually fine, but needs a worker to drain the queue. | ⚠️ Depends on workers |
| Secret management | Secrets live in files in your home directory, readable by anything running as your user; no separate key store. | ⚠️ Weak |
| Malware scanning (ClamAV daemon ~1–1.5 GB RAM) | Not possible to run your own daemon. | ❌ |
| Resources | Typical LVE limits: ~1 GB RAM, 1–2 cores, process caps; email parsing of large messages can hit these. | ⚠️ |

**Conclusion:** a normal shared cPanel plan **cannot reliably run the backend** this specification requires (persistent sync workers, IDLE connections, second-level job scheduling, unrestricted outbound mail ports). Running it there would produce exactly the "looks functional but isn't" result the brief rules out.

> If your account is actually a **cPanel/WHM VPS or dedicated server with root/SSH access**, the picture changes: it can run everything below, because it is effectively a VPS. Check §1.4.

## 1.3 Recommended adjustment (smallest necessary change)

Move **only the backend runtime, PostgreSQL and file storage** to a small Linux VPS. Keep using cPanel for what it does well.

| Component | Where | Why |
|---|---|---|
| API server, sync workers, job scheduler, ClamAV | **VPS** (Docker Compose) | Needs persistent processes and outbound mail ports |
| PostgreSQL 16+ | **VPS** (same box initially; can move to managed Postgres later with no code change) | Needs roles, RLS, extensions, WAL archiving |
| Attachment/blob storage | **S3-compatible object storage** (e.g. Backblaze B2, Cloudflare R2, Wasabi) — or the VPS disk at first behind the same storage interface | Cheap, durable, keeps big binaries out of Postgres |
| Off-site backups | Object storage bucket in a **different provider/region** from the VPS | Avoids single-point-of-failure |
| DNS for your domain | **cPanel** (add `api.` and `admin.` A records pointing to the VPS) | Nothing to move |
| Platform's own system emails (verification, password reset, admin alerts) | **cPanel mailbox** e.g. `noreply@yourdomain` via SMTP, or a transactional provider later | Already available, low volume |
| Admin recovery mailbox | **cPanel** mailbox you control | — |
| Marketing/landing page, privacy policy | **cPanel** | Static site |
| Mobile app | Google Play (Android first), later App Store | — |
| Admin web dashboard | Static files served by the VPS reverse proxy (`admin.yourdomain`) | Same origin policies as the API; could also be static on cPanel, but keeping it with the API makes CSP/cookies simpler |

**Sizing for 20–50 users:** 2 vCPU / 4 GB RAM / 80 GB SSD VPS (e.g. Hetzner CX22/CPX21, DigitalOcean, Linode/Akamai, OVH — roughly US$6–25/month depending on provider), plus object storage (≈US$6 per TB-month on B2/Wasabi-class services, usually a few dollars at this scale). ClamAV is the largest RAM consumer; it is optional and can be switched off on a 2 GB box.

**Operational complexity:** moderate. You will need SSH, Docker, automatic security updates and the runbooks in `06-deployment-and-operations.md`. Everything is containerised, so moving to another VPS or to managed services later is a re-deploy plus a database restore, not a rebuild.

**Portability guarantees built into the design:**
- Only standard PostgreSQL features (no vendor-specific extensions beyond `citext`, `pg_trgm`, both available on every managed Postgres).
- Storage behind an S3-compatible interface (works with AWS S3, B2, R2, Wasabi, MinIO).
- Configuration only via environment variables / mounted secret files.
- The job queue lives in PostgreSQL (`pg-boss`), so no extra Redis service to migrate.

## 1.4 Checklist to verify your actual cPanel plan

Run these and send me the answers; I'll revise this section if your plan is more capable than typical shared hosting.

1. Do you have **SSH** access? Is it a **VPS/dedicated with WHM/root**, or shared?
2. cPanel → *Databases*: is **PostgreSQL Databases** listed? Run `psql --version` over SSH; can you `CREATE EXTENSION citext;` and `CREATE ROLE`?
3. cPanel → *Software*: is **Setup Node.js App** listed, and which Node versions?
4. Ask the host: "Are long-running background processes (daemons) permitted? What are the CPU/RAM/process (LVE) limits?"
5. From SSH: `nc -vz smtp.gmail.com 587`, `nc -vz imap.gmail.com 993`, `nc -vz outlook.office365.com 993` — are outbound mail ports open?
6. cPanel → *Cron Jobs*: what is the minimum interval?
7. Disk quota and inode limits.

If (1) is "shared" or (4)/(5) are "no", the VPS recommendation stands.
