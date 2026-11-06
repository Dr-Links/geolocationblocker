# Postpilot: AI Social Media Manager

Multi-tenant SaaS: generate social content with AI, schedule it, and auto-publish to connected accounts.
Every external integration (AI providers, social platforms, Stripe, S3) **defaults to a mock**, so the app works end-to-end with no live credentials.

> Status: **Phase 0 (scaffold)**. See [`BUILD_NOTES.md`](./BUILD_NOTES.md) for decisions and what's stubbed.

## Quick start (Docker)

```bash
cp .env.example .env
# set AUTH_SECRET and ENCRYPTION_KEY (each: openssl rand -base64 32)
docker compose up --build
docker compose exec app npm run db:seed
```

Open http://localhost:3000.

## Quick start (local Node 22 + your own Postgres/Redis)

```bash
cp .env.example .env          # fill AUTH_SECRET, ENCRYPTION_KEY; point DATABASE_URL/REDIS_URL at localhost
npm install
npm run db:migrate            # applies migrations
npm run db:seed               # demo data + SUPER_ADMIN
npm run dev                   # app on :3000
npm run worker:dev            # in a second terminal: background worker
```

### Seeded logins
| Role | Email | Password |
|---|---|---|
| SUPER_ADMIN | `admin@example.com` | `ChangeMe123!` (or `SEED_ADMIN_PASSWORD`) |
| Workspace admin | `demo@example.com` | `Demo12345!` (or `SEED_DEMO_PASSWORD`) |

The seeded "Acme Coffee" workspace is a comped Pro plan with 3 mock social accounts and 6 sample posts.

## Scripts
| Script | What |
|---|---|
| `npm run dev` / `build` / `start` | Next.js app |
| `npm run worker` / `worker:dev` | BullMQ worker process |
| `npm test` | Vitest unit + integration (needs Postgres; set `TEST_DATABASE_URL` to use a separate DB) |
| `npm run test:e2e` | Playwright (builds must exist: `npm run build` first) |
| `npm run typecheck` / `lint` | |
| `npm run db:migrate` / `db:deploy` / `db:seed` / `db:reset` | Prisma |

## Layout
```
prisma/            schema, migrations, seed
src/app/           Next.js routes: (auth) login/signup, (app) dashboard, api/
src/auth*.ts       Auth.js config (edge-safe part + full part)
src/lib/           db, env, crypto (AES-256-GCM), logger, queues, validation
src/server/        server-only services (users, audit) and session helpers
src/worker/        background worker entrypoint
tests/             unit, integration (real DB), e2e (Playwright)
```

## Swapping mocks for real adapters
Covered in Phase 7. In short: fill in the provider's env vars in `.env` and that adapter turns on; blank vars fall back to the mock.
