# AllWebMails

A multi-user email platform: connect many IMAP/SMTP mailboxes and use them in one secure inbox. It comes as:
- a **web app (PWA)** at app.allwebmails.com, installable on any device;
- an **Android app** (APK);
- a Node.js + PostgreSQL backend;
- an admin site.

**Current stage: milestones 1–10 are built.** Only "Sign in with Google/Microsoft" for Gmail and Outlook mailboxes (M4b) is left; it needs app registrations with Google and Microsoft.
→ **[Deployment guide](docs/deploy.md)** · [Roadmap](docs/05-roadmap.md) · [Milestone notes](docs/milestones/)

## Repository layout

```
apps/backend      Node.js API (user + admin), scheduler, CLI, SQL migrations, tests
apps/admin-web    Admin dashboard (React + Vite), served by the admin app
apps/mobile       The app: Android (APK) and the web app/PWA (Expo / React Native + react-native-web)
packages/shared   Rules shared by all three (Gmail normalisation, password policy, status)
deploy/server     Docker image + compose (VPS), Caddy, env template, smoke test
deploy/website    Public website for allwebmails.com (static, for Hostinger)
deploy/cpanel     Startup files and packaging for a Node-capable cPanel host
docs/             Architecture, database design, security, roadmap, milestone guides
```

## Development quick start

Requirements: Node 22, PostgreSQL 13+.

```bash
npm ci
# Backend tests need a PostgreSQL superuser to create a scratch database:
TEST_PG_HOST=localhost TEST_PG_PORT=5432 TEST_PG_SUPERUSER=postgres TEST_PG_PASSWORD=... npm test -w @app/backend
npm run typecheck
npm run package:cpanel        # builds everything into deploy/cpanel/out/emailplatform

# Mobile
cd apps/mobile && npm ci && EXPO_PUBLIC_API_URL=http://<your-ip>:3000 npx expo start
```

Run the backend locally with the `DB_*` variables from `deploy/cpanel/env.example`. Use `npm run cli -w @app/backend -- db:create-roles` (development only), then `db:migrate`, then `npm run dev:api` / `npm run dev:admin -w @app/backend`, plus `npm run dev -w @app/admin-web`.

## Planning documents

| Doc | Contents |
|---|---|
| [01 – Requirements & hosting feasibility](docs/01-requirements-and-feasibility.md) | Requirements, cPanel assessment, hosting decision |
| [02 – Architecture](docs/02-architecture.md) | Stack, components, lifecycle, sync, sending, search, notifications, offline, storage, jobs |
| [03 – Database design](docs/03-database-design.md) | Tables, tenant isolation, transactions, retention |
| [04 – Security & privacy](docs/04-security-privacy.md) | Auth, admin protections, encryption, phishing, privacy |
| [05 – Roadmap](docs/05-roadmap.md) | Milestones M1–M10 |
| [06 – Deployment & operations](docs/06-deployment-and-operations.md) | Releases, mobile updates, backups, emergency recovery |
| [07 – External services](docs/07-external-services.md) | Accounts, costs, secrets |
| [08 – Risks & decisions](docs/08-risks-and-decisions.md) | Risk register, resolved and open decisions |
| [09 – Testing plan](docs/09-testing-plan.md) | Test strategy |
