# Postpilot: AI Social Media Manager

A multi-tenant SaaS for social content:
- write content, or generate it with AI (text, images, short videos);
- preview it per platform;
- schedule it;
- a background worker publishes it to connected accounts on X, Facebook, Instagram, LinkedIn, TikTok and YouTube.

**Every external integration defaults to a mock** (AI providers, social platforms, Stripe, object storage). The whole product works end to end with no credentials. Real services switch on one at a time when you add their keys.

| Guide | For |
|---|---|
| [docs/INTEGRATIONS.md](./docs/INTEGRATIONS.md) | **Swapping each mock for the real service:** env vars, callback URLs, scopes, platform review notes |
| [docs/DEPLOY.md](./docs/DEPLOY.md) | Deploying to Render, Fly.io or a single VPS |
| [docs/OPERATIONS.md](./docs/OPERATIONS.md) | Logs, backups, key rotation, incident playbooks |
| [BUILD_NOTES.md](./BUILD_NOTES.md) | Design decisions, phase by phase, and what's still stubbed |

## Quick start (Docker)

Requires Docker with Compose v2.

```bash
cp .env.example .env
```

In `.env`, set `AUTH_SECRET` and `ENCRYPTION_KEY`. Generate each one with:

```bash
openssl rand -base64 32
```

Then start the stack and load the demo data:

```bash
docker compose up --build
```

```bash
docker compose exec app npm run db:seed
```

Open http://localhost:3000. The stack runs the app, the worker, Postgres and Redis. Migrations run automatically when the app starts.

## Quick start (Node 22, your own Postgres 16 + Redis 7)

```bash
cp .env.example .env
```

Fill in `AUTH_SECRET` and `ENCRYPTION_KEY` as above. Then create the runtime database role once. Tenant isolation needs a non-superuser role:

```bash
psql postgresql://postgres:postgres@localhost:5432/postgres -f docker/postgres/init.sql
```

```bash
npm install
```

```bash
npm run db:migrate
```

```bash
npm run db:seed
```

```bash
npm run dev
```

In a second terminal, start the worker. It publishes posts and runs AI jobs:

```bash
npm run worker:dev
```

### Seeded logins
| Role | Email | Password |
|---|---|---|
| SUPER_ADMIN (platform owner) | `admin@example.com` | `ChangeMe123!` (or `SEED_ADMIN_PASSWORD`) |
| Workspace admin | `demo@example.com` | `Demo12345!` (or `SEED_DEMO_PASSWORD`) |
| Owner of a second tenant | `other@example.com` | same as demo |

- **"Acme Coffee"** is a comped Pro workspace with 3 mock social accounts and sample posts: scheduled, published, failed and recurring.
- **"Globex Bakery"** is a separate tenant, invisible to `demo@`.

## What you can do

**Users** (`/dashboard`)
- **Compose:**
  - write once, optionally customized per platform;
  - attach uploaded or AI-generated images and videos;
  - see a live preview per platform, with character limits, truncation, aspect ratios and media rules;
  - then **Publish now**, **Schedule** (time zone and repeat), or **Add to queue**.
- **AI:** captions from a brief, images, and short videos. These run as background jobs and cost plan credits, or nothing with your own API key. Choose providers and models in **Settings → AI**.
- **Posts and Calendar:** per-platform status, links and errors, **Retry failed**, and the posting-queue time slots.
- **Accounts:** connect and disconnect social accounts through OAuth. See their health ("needs reconnect").
- **Billing:** plans, checkout and the customer portal. Without Stripe, use the mock with test card `4242 4242 4242 4242`; `4000 0000 0000 0002` is declined.
- **Members:** invite people as admin or member.

**Platform owner** (`/admin`, SUPER_ADMIN)
- **Overview:** revenue (MRR/ARR), sign-ups, publishing and AI usage charts.
- **Workspaces:**
  - search, **comp** (full or partial, with an optional expiry), and **suspend**;
  - **support mode**: act inside a workspace as its admin for 60 minutes. A reason is required, everything is audited, and billing and AI keys stay locked.
- **Users:** disable, force sign-out, and grant or revoke SUPER_ADMIN.
- **Plans:** you set every price and limit. Price changes apply to new subscribers; existing ones are grandfathered.
- **AI:** platform API keys (encrypted) and credit costs.
- **Publishing ops:** failed publishes across all tenants, accounts needing reconnect, and queue health.
- **Audit log:** a filterable history of every action.

## Architecture in one screen

- **Next.js app (App Router)** serves the UI, the API, OAuth callbacks and Stripe webhooks.
- **Worker (BullMQ on Redis)** handles scheduled publishing, AI generation and token refresh.
  - The **database is the source of truth.** Queue jobs are only timers, and a per-minute sweep recovers anything missed.
  - Posts are claimed atomically, so they're never double-posted.
- **Adapters.** Every external call goes through a small interface with a mock implementation. Real adapters activate from env:
  - `SocialPublisher` (X, Meta, LinkedIn, TikTok, YouTube);
  - `TextGenerator` / `ImageGenerator` / `VideoGenerator` (Anthropic, OpenAI, Google, Hugging Face) behind a router with fallback;
  - `BillingProvider` (Stripe);
  - `Storage` (S3/R2).
- **Tenant isolation** is enforced by Postgres **row-level security**, not just application code (next section).

## Tenant isolation (read before writing data access)

- **In request code**, use `ctx.db` from `getTenantContext()` / `requireTenant(permission)`, or `withTenantTx(workspaceId, fn)` for transactions. RLS hides other workspaces' rows, so a foreign id simply isn't found.
- **Use `systemDb` / `withSystemTx` only for trusted cross-tenant code:** auth, admin and the worker.
- **Database roles:** `DATABASE_URL` must be a non-superuser member of `app_user`. `DIRECT_DATABASE_URL` is the owner role, used for migrations. The app and worker refuse to start in production otherwise. On managed Postgres, create the role with `npm run db:app-role` (see [DEPLOY.md](./docs/DEPLOY.md)).

## Scripts
| Script | What |
|---|---|
| `npm run dev` / `build` / `start` | Next.js app |
| `npm run worker` / `worker:dev` | Background worker |
| `npm test` | Vitest unit + integration tests (needs Postgres and Redis; uses `TEST_DATABASE_URL`, migrated automatically) |
| `npm run test:e2e` | Playwright against a production build (run `npm run build` first) |
| `npm run typecheck` / `lint` | |
| `npm run db:migrate` / `db:deploy` / `db:seed` / `db:reset` | Prisma |
| `npm run db:app-role` | Create or update the least-privilege runtime database login |
| `npm run keys:reencrypt` | Re-encrypt stored secrets after rotating `ENCRYPTION_KEY` |

## Layout
```
prisma/              schema, migrations (incl. RLS policies), seed
src/app/             routes: (auth) login/signup · (app) dashboard · admin · api/
src/server/          server-only domain code:
  ai/                generators, router, credits, BYOK
  billing/           plans, entitlements, Stripe/mock provider, webhook sync
  social/            publishers (adapters), OAuth, validation rules
  scheduling/        posts, schedules, recurrence, publish runs
  admin/ tenancy/    admin services, tenant context, permissions, impersonation
  media/ storage/    uploads (type sniffing), S3/local storage
src/lib/             db (RLS clients), env, crypto, logger, CSP, queues
src/worker/          worker entrypoint
docker/ deploy/      container entrypoint, Postgres init, Caddy
tests/               unit · integration (real DB) · e2e (Playwright)
docs/                integrations, deploy, operations
```
