# Operations runbook

## Where to look

| Question | Look at |
|---|---|
| Is it up? | `GET /api/health` returns `db` and `redis` status. Only a database failure returns 503. |
| Did scheduled posts go out? | **Admin → Publishing ops**: failed publishes with the platform's error, stuck posts, and queue counts |
| What did someone do? | **Admin → Audit log**, filterable by action, actor, workspace and date. Support-mode actions show "via admin@…". |
| A user reports "something went wrong" | The error page shows a **reference**. Search the logs for that `digest`. |
| Revenue and usage | **Admin → Overview** |

## Logs

- Both processes write **one JSON object per line** to stdout using pino, with `service` set to `app` or `worker`. Your platform's log viewer can filter on fields.
- Secrets are redacted by field name: passwords, tokens, API keys.
- Every unhandled server error is logged as `"unhandled request error"` with:
  - `digest`, the reference id shown to the user;
  - `method`, `path` and `routeType`.
- Set `LOG_LEVEL=debug` temporarily for more detail.
- Locally, run `npm run dev | npx pino-pretty` for readable output.

## The worker

- **It must be running** for scheduled posts, AI generations and token refresh. Its health endpoint is `WORKER_HEALTH_PORT` (`/`).
- **Restarting is safe.** The database is the source of truth, and a sweep every minute re-queues anything due. Jobs lost from Redis are recovered. A post is claimed atomically, so it is never published twice.
- **Graceful shutdown:** on SIGTERM it stops taking new jobs and finishes the ones in flight. The image runs it under `tini` so the signal arrives.
- **Scaling:** run more worker instances, or raise `PUBLISH_WORKER_CONCURRENCY` and `AI_WORKER_CONCURRENCY`. Claims stay atomic across instances.

## Backups

- **Postgres holds everything that matters.** Use your provider's daily backups with point-in-time recovery (Render, Neon and Fly Managed Postgres all offer this). On a VPS, run something like:
  ```bash
  docker compose -f docker-compose.prod.yml exec -T postgres pg_dump -U postgres -Fc postpilot > postpilot-$(date +%F).dump
  ```
  Restore with `pg_restore --clean --if-exists -d postpilot`. **Test a restore once.**
- **`ENCRYPTION_KEY` must be backed up separately**, for example in a password manager. A database backup without it can't decrypt social tokens or AI keys. Users would have to reconnect every account.
- **Media:** use bucket versioning or replication on S3/R2. Local disk on a VPS sits in the `media` volume, so back it up with the database.
- **Redis** holds no data you'd lose: queues are rebuilt from the database, and rate-limit counters are temporary.

## Rotating `ENCRYPTION_KEY`

1. Generate a new key: `openssl rand -base64 32`.
2. Set `ENCRYPTION_KEY=<new>` and `ENCRYPTION_KEY_PREVIOUS=<old>` on **both** app and worker, then restart. New secrets use the new key, and old ones still decrypt.
3. Re-encrypt everything under the new key:
   ```bash
   npm run keys:reencrypt
   ```
   This prints counts, it's safe to run more than once, and it exits non-zero if any secret couldn't be decrypted.
4. When it reports no failures, remove `ENCRYPTION_KEY_PREVIOUS` and restart.

## Rotating other secrets

- **`AUTH_SECRET`**: changing it signs everyone out. That's harmless, but tell users. Pending OAuth connects and support-mode sessions also end.
- **Database password**: rerun `npm run db:app-role` with the new `APP_DB_PASSWORD`, then update `DATABASE_URL` everywhere.
- **Stripe, AI or platform keys**: replace them in env (or in **Admin → AI** for AI keys) and restart. For Stripe, rolling the webhook secret needs a new endpoint secret in the Stripe Dashboard first.

## Common incidents

**Posts stuck in "publishing" or nothing going out**
1. Check that the worker is running.
2. Check **Admin → Publishing ops** to see whether queues are reachable.
3. Posts stuck in publishing for more than a few minutes after a worker crash are recovered by the sweep.

**A platform starts failing (e.g. 401 on every X post)**
- The account's token was revoked or the app lost access. Its status becomes **Needs reconnect**, and the workspace sees it on its dashboard. The user reconnects it.
- If *every* account on a platform fails, check the platform app's status and keys.

**Rate-limited by a platform**
- Temporary errors (429, 5xx) retry after 1, 5 and 15 minutes (4 attempts in total). After that, the post shows *failed* with the platform's message and the user can **Retry failed**.

**Stripe webhooks failing**
- In the Stripe Dashboard's webhook view, check the response. 400 means a wrong `STRIPE_WEBHOOK_SECRET`; 500 means a processing error, which is in the app logs.
- Stripe retries for up to 3 days, and processing is idempotent, so resending is safe.

**A user is locked out or compromised**
- **Admin → Users → the user**:
  - **Force sign-out** ends every session immediately;
  - **Disable** also blocks sign-in.
- Workspaces can be **suspended** from **Admin → Workspaces**. Their scheduled posts then fail with a clear message instead of publishing.

**Investigating a workspace's issue**
- Open **Admin → Workspaces → the workspace → Support access**. A reason is required and access lasts 60 minutes.
- You act as its admin; billing and AI keys stay locked, and everything is audited.

## Security notes for operators

- **Tenant isolation is enforced by Postgres row-level security,** not just application code. The app and worker refuse to start if their database role could bypass it.
- **Security headers:**
  - a nonce-based Content-Security-Policy on every page;
  - HSTS on `https://` deployments;
  - `X-Frame-Options: DENY` and `nosniff`.
- **Uploads** are identified by their bytes, not the file name or browser type. Only JPEG/PNG/GIF/WebP and MP4/MOV are accepted; SVG and HTML are refused. Uploads are stored under server-generated keys and served through a tenant-checked route.
- **Rate limits** (per IP or workspace, Redis-backed; they fail open if Redis is down):

  | Action | Variable |
  |---|---|
  | Login | `RATE_LIMIT_LOGIN_PER_15M` |
  | Sign-up | `RATE_LIMIT_SIGNUP_PER_HOUR` |
  | Generations | `RATE_LIMIT_GENERATIONS_PER_MIN` |
  | Scheduling | `RATE_LIMIT_SCHEDULE_PER_MIN` |
  | Invitations | `RATE_LIMIT_INVITES_PER_HOUR` |
  | Uploads | `RATE_LIMIT_UPLOADS_PER_HOUR` |
