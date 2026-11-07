# Deploying Postpilot

A deployment has four parts:
- **app**: Next.js, serves the UI, API, OAuth callbacks and Stripe webhooks;
- **worker**: BullMQ; publishes scheduled posts, runs AI generations, refreshes tokens;
- **PostgreSQL 16**;
- **Redis 7**.

The app and worker come from **one Docker image**; the container's first argument picks the role:

| Command | What it does |
|---|---|
| `app` (default) | Runs `prisma migrate deploy` (skip with `SKIP_MIGRATIONS=1`), then `next start` on `$PORT` |
| `worker` | Starts the worker. It must be running, or scheduled posts never go out. |
| `migrate` | Runs migrations only (for platform release steps) |

Ready-made configs: [`render.yaml`](../render.yaml), [`fly.toml`](../fly.toml), [`docker-compose.prod.yml`](../docker-compose.prod.yml).

## Before any deploy: checklist

1. **Secrets.** Generate `AUTH_SECRET` and `ENCRYPTION_KEY` with `openssl rand -base64 32`, and **back up `ENCRYPTION_KEY` somewhere safe.** Losing it makes every stored social token and API key unreadable. Both values must be identical on the app and the worker.
2. **`APP_URL`** = your public `https://` URL. OAuth callbacks, Stripe redirects and invite links are built from it.
3. **Redis with `maxmemory-policy noeviction`.** BullMQ loses jobs if Redis evicts keys. The configs here set it; check it on any managed Redis you bring.
4. **Object storage (S3/R2)** whenever the app and worker don't share a disk: Render, Fly, or more than one server. See [INTEGRATIONS.md](./INTEGRATIONS.md#object-storage-s3-or-cloudflare-r2).
5. **Database roles.** Migrations run as the database owner (`DIRECT_DATABASE_URL`). The app should connect as a separate login that is a member of `app_user` (`DATABASE_URL`). Create it once after the first migration:
   ```bash
   DIRECT_DATABASE_URL=<owner url> APP_DB_PASSWORD=$(openssl rand -hex 24) npm run db:app-role
   ```
   - Row-level security is `FORCE`d, so the owner role is tenant-isolated too. The separate login also can't alter tables or switch RLS off, which is why it's recommended.
   - The app **refuses to start** if `DATABASE_URL` is a superuser or a `BYPASSRLS` role.
6. **Admin account.** Set `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` before running the seed (`npm run db:seed`), then change the password after first login. The app refuses to boot on an `https://` URL while the example password is still set.

**Production config check.** The app and worker validate their configuration at boot and print every problem at once: missing or weak secrets, a wrong-length encryption key, half-configured integrations. Read the error, fix the variables and redeploy.

---

## Render

`render.yaml` creates the app (web service), the worker, a Postgres database and a Key Value (Redis) instance with `noeviction`. Shared secrets live in an env group; `AUTH_SECRET` and `ENCRYPTION_KEY` are generated for you.

1. Push this repo to GitHub, then in Render choose **New → Blueprint** and pick the repo.
2. Fill in the prompted values:
   - `APP_URL` (use the `onrender.com` URL first; update it when you add a domain);
   - the `S3_*` values;
   - `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD`.

   Leave the integration keys blank to keep the mocks.
3. After the first deploy, open the app service's **Shell** and run:
   ```bash
   npm run db:seed
   APP_DB_PASSWORD=$(openssl rand -hex 24) npm run db:app-role   # optional least-privilege login
   ```
   If you created the login, set the app's and worker's `DATABASE_URL` to the printed URL (add your password, URL-encoded) and redeploy.
4. Copy the generated `ENCRYPTION_KEY` from the env group into your password manager.
5. Custom domain: add it under the web service. Then update `APP_URL` and every OAuth or Stripe URL that contains the old domain.

## Fly.io

`fly.toml` runs `app` and `worker` as two process groups of one Fly app. Migrations run once per deploy as the release command. Postgres and Redis are external: for example Neon or Fly Managed Postgres, plus Upstash Redis. If you use Upstash, set eviction off.

```bash
fly launch --no-deploy --copy-config        # choose a unique app name; decline the Postgres/Redis prompts
```

```bash
fly secrets set \
  APP_URL=https://<app>.fly.dev \
  DATABASE_URL='postgresql://postpilot_app:…@…/postpilot?sslmode=require' \
  DIRECT_DATABASE_URL='postgresql://owner:…@…/postpilot?sslmode=require' \
  REDIS_URL='rediss://default:…@…:6379' \
  AUTH_SECRET=$(openssl rand -base64 32) \
  ENCRYPTION_KEY=$(openssl rand -base64 32) \
  S3_BUCKET=… S3_ENDPOINT=… S3_REGION=auto S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=… \
  SEED_ADMIN_EMAIL=you@example.com SEED_ADMIN_PASSWORD='…'
```

```bash
fly deploy
```

```bash
fly ssh console -C "npm run db:seed"
```

**First deploy and the app login.** `DATABASE_URL` points at the app login, which doesn't exist until you create it. For the first deploy, set `DATABASE_URL` to the owner URL. Then run `fly ssh console -C "sh -c 'APP_DB_PASSWORD=… npm run db:app-role'"` and switch `DATABASE_URL` to the new login.

**Neon notes**
- Use the **pooled** connection string for `DATABASE_URL` and the **direct** one for `DIRECT_DATABASE_URL` (migrations).
- Tenant context is applied with `set_config(..., true)`, which is transaction-local, inside each transaction. Transaction-mode pooling (PgBouncer) is therefore safe.
- If your pooler doesn't support prepared statements, add `&pgbouncer=true` to `DATABASE_URL`.

## Single server (VPS) with Docker

`docker-compose.prod.yml` runs everything on one machine:
- Caddy terminates HTTPS and gets the certificate automatically;
- Postgres and Redis are on a private network;
- app and worker share a media volume, so S3 is optional here but recommended for durability.

1. Point a DNS A/AAAA record at the server and open ports 80 and 443.
2. Create `.env.production` from `.env.example`. Set:
   - `NODE_ENV=production`;
   - `APP_URL=https://<domain>`;
   - `AUTH_SECRET` and `ENCRYPTION_KEY`;
   - `SEED_ADMIN_*`;
   - `DOMAIN=<domain>`;
   - `POSTGRES_PASSWORD` and `APP_DB_PASSWORD` (two different strong values).

   The compose file builds `DATABASE_URL`, `DIRECT_DATABASE_URL` and `REDIS_URL` itself. The app login (`postpilot_app`) is created on the first database boot.
3. Start:
   ```bash
   docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
   ```

   ```bash
   docker compose -f docker-compose.prod.yml --env-file .env.production exec app npm run db:seed
   ```
4. Update to a new version:
   ```bash
   git pull && docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
   ```
   The app migrates before serving, and the worker waits for the app to be healthy.

## After deploying

- `GET /api/health` returns `{"status":"ok","db":"ok","redis":"ok"}`. Only a database failure returns 503; Redis problems show as `degraded`.
- Log in as the admin. **Admin → Publishing ops** should list all three queues without "unreachable".
- Schedule a post a minute out on a mock account to confirm the worker is publishing.
- Then switch integrations on one at a time: [INTEGRATIONS.md](./INTEGRATIONS.md).

Day-to-day running (backups, key rotation, logs, incidents): [OPERATIONS.md](./OPERATIONS.md).
