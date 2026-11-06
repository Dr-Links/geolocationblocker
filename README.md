# Postpilot: AI Social Media Manager

Multi-tenant SaaS: generate social content with AI, schedule it, and auto-publish to connected accounts.
Every external integration (AI providers, social platforms, Stripe, S3) **defaults to a mock**, so the app works end-to-end with no live credentials.

> Status: **Phase 1 (multi-tenancy)**. See [`BUILD_NOTES.md`](./BUILD_NOTES.md) for decisions and what's stubbed.

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
cp .env.example .env          # fill AUTH_SECRET, ENCRYPTION_KEY
# Create the runtime DB role once (tenant isolation needs a NON-superuser role):
psql postgresql://postgres:postgres@localhost:5432/postgres -f docker/postgres/init.sql
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

| Owner of a 2nd tenant | `other@example.com` | same as demo |

"Acme Coffee" is a comped Pro workspace with 3 mock social accounts and 6 sample posts. "Globex Bakery" is a separate tenant, invisible to `demo@`.

## Tenant isolation (read this before writing data access)
Isolation is enforced by **Postgres row-level security**, not just app code:
- In request code, use `ctx.db` from `getTenantContext()` / `requireTenant(permission)`, or `withTenantTx(workspaceId, fn)` for transactions.
- Use `systemDb` / `withSystemTx` only for trusted cross-tenant code (auth, admin, worker).
- `DATABASE_URL` **must** be a non-superuser member of `app_user`; `DIRECT_DATABASE_URL` is the owner role for migrations. The app refuses to boot in production otherwise.

On a managed host (e.g. Neon), create the runtime role once:
```sql
CREATE ROLE postpilot_app LOGIN PASSWORD '<strong password>' IN ROLE app_user;  -- after running migrations
```

## Scripts
| Script | What |
|---|---|
| `npm run dev` / `build` / `start` | Next.js app |
| `npm run worker` / `worker:dev` | BullMQ worker process |
| `npm test` | Vitest unit + integration (needs Postgres + Redis; uses `TEST_DATABASE_URL`, migrated automatically via `TEST_DIRECT_DATABASE_URL`) |
| `npm run test:e2e` | Playwright (builds must exist: `npm run build` first) |
| `npm run typecheck` / `lint` | |
| `npm run db:migrate` / `db:deploy` / `db:seed` / `db:reset` | Prisma |

## Layout
```
prisma/            schema, migrations, seed
src/app/           Next.js routes: (auth) login/signup, (app) dashboard, api/
src/auth*.ts       Auth.js config (edge-safe part + full part)
src/lib/           db, env, crypto (AES-256-GCM), logger, queues, validation
src/server/        server-only: services/, tenancy/ (context, permissions), mail/, rate-limit
src/worker/        background worker entrypoint
tests/             unit, integration (real DB), e2e (Playwright)
```

## Swapping mocks for real adapters
Covered in Phase 7. In short: fill in the provider's env vars in `.env` and that adapter turns on; blank vars fall back to the mock.
