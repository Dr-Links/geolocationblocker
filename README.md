# Multi-Mailbox Email Platform — Architecture & Plan

Planning stage (before Milestone 1). No application code yet. This repository holds the architecture, feasibility assessment, database design and roadmap for a multi-user, multi-domain email management platform: a React Native (Android-first) app, a PostgreSQL-backed Node.js backend, and a separate admin web dashboard.

| Doc | Contents |
|---|---|
| [01 – Requirements & hosting feasibility](docs/01-requirements-and-feasibility.md) | Requirements summary, shared-cPanel assessment, recommended adjustment, checklist for your plan |
| [02 – Architecture](docs/02-architecture.md) | Stack, component diagram, what runs where, account lifecycle, connection, sync, threading, sending, search, notifications, offline, storage, jobs |
| [03 – Database design](docs/03-database-design.md) | Table-by-table explanation, tenant isolation, transactions, retention |
| [db/schema-draft.sql](db/schema-draft.sql) | Full draft DDL, checked on PostgreSQL 16 |
| [04 – Security & privacy](docs/04-security-privacy.md) | Auth, admin protections, encryption, app security, phishing, privacy |
| [05 – Roadmap](docs/05-roadmap.md) | Milestones M1–M10 (adjusted order explained) and repo layout |
| [06 – Deployment & operations](docs/06-deployment-and-operations.md) | Environments, releases, mobile updates, backups, emergency admin recovery, monitoring |
| [07 – External services](docs/07-external-services.md) | Accounts, costs, secrets (`.env` example) |
| [08 – Risks & decisions](docs/08-risks-and-decisions.md) | Risk register and **the questions I need you to answer before M1** |
| [09 – Testing plan](docs/09-testing-plan.md) | Test strategy by area |

## Headline conclusions

1. **Shared cPanel hosting can't reliably run the backend.** The backend needs persistent IMAP connections, second-level job timing and open outbound mail ports. The smallest change is to move the backend, PostgreSQL and file storage to a small VPS (~US$6–25/month) and keep DNS, system email and the landing page on cPanel. If your plan is actually a VPS with root access, this may not apply (see the checklist).
2. **Stack:** TypeScript throughout. Expo React Native, Fastify, ImapFlow/Nodemailer, PostgreSQL 16+ with RLS, pg-boss jobs, S3-compatible storage, FCM.
3. **Gmail OAuth is the biggest external dependency.** Google classes the scope as restricted, so it needs app verification and a yearly security assessment. App passwords are the interim route.
4. **Tenant isolation is enforced in three layers:** API scoping, composite foreign keys and Row-Level Security. The admin's database role can't read mail content.
