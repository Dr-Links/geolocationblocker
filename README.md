# Multi-Mailbox Email Platform

A multi-user email management platform: an Android-first React Native app, a Node.js + PostgreSQL backend hosted on cPanel, and a separate admin dashboard.

**Current stage: Milestone 1 is built and waiting for your test.** It covers registration with a Gmail address, email confirmation, admin approval with a one-calendar-month access period in each user's own time zone, automatic expiry and suspension, and the admin dashboard with authenticator sign-in. → **[Setup and test guide](docs/milestones/M1.md)**

## Repository layout

```
apps/backend      Node.js API (user + admin), scheduler, CLI, SQL migrations, tests
apps/admin-web    Admin dashboard (React + Vite), served by the admin app
apps/mobile       Android app (Expo / React Native, iOS-ready)
packages/shared   Rules shared by all three (Gmail normalisation, password policy, status)
deploy/cpanel     Startup files, env template and the packaging script for cPanel
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
