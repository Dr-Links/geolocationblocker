# Postpilot: AI Social Media Manager

Multi-tenant SaaS: generate social content with AI, schedule it, and auto-publish to connected accounts.
Every external integration (AI providers, social platforms, Stripe, S3) **defaults to a mock**, so the app works end-to-end with no live credentials.

> Status: **Phase 3 (AI generation)**. See [`BUILD_NOTES.md`](./BUILD_NOTES.md) for decisions and what's stubbed.

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

## Billing & plans
- **You (SUPER_ADMIN) own pricing**: Admin → Plans to create/edit plans, prices, limits and features. Price changes apply to new subscribers; existing ones are grandfathered.
- Admin → workspace page to **comp** a workspace (full or partial, optional expiry); Admin → Create free account to set up a comped account for someone new.
- Without Stripe keys, billing runs on a **mock**: test cards `4242 4242 4242 4242` (succeeds) and `4000 0000 0000 0002` (declined), plus a mock portal that can simulate renewals and failed payments.

### Stripe setup (test mode)
1. In the Stripe dashboard (test mode), copy the secret key into `STRIPE_SECRET_KEY`.
2. Webhooks, either:
   - locally: install the Stripe CLI and run the command below, then copy the printed `whsec_...` into `STRIPE_WEBHOOK_SECRET`;
   - deployed: add an endpoint `https://<your-domain>/api/webhooks/stripe` with the events `checkout.session.completed`, `customer.subscription.created/updated/deleted/paused/resumed`, `invoice.paid`, `invoice.payment_failed`.
3. Restart the app, open **Admin → Plans → Sync plans to Stripe**. This creates the real Stripe products and prices for your plans.
4. Stripe dashboard → Settings → Billing → **Customer portal**: enable it and allow switching between your plans' products.

```bash
stripe listen --forward-to localhost:3000/api/webhooks/stripe
```

## AI generation
- **Composer** (`/dashboard/compose`) generates captions, images and short videos as background jobs (the worker must be running: `npm run worker:dev`).
- With **no API keys**, mock generators produce placeholder captions, a PNG and a short MP4, so everything works offline.
- To go live, add a provider key in **Admin → AI** (encrypted) or as an env var (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_AI_API_KEY`, `HUGGINGFACE_API_TOKEN`). Each provider activates independently; the router falls back between configured providers on outages.
- Workspaces choose default providers/models in **Settings → AI settings** and may add their own keys (plan feature "Bring your own AI keys"); those generations use no platform credits.
- Credit cost per generation (default 1 text / 5 image / 25 video) is set in **Admin → AI**.

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
