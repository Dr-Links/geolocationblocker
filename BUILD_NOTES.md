# BUILD_NOTES

Running log of decisions, assumptions, and stubs. Newest phase at the top.

---

## Phase 0: Scaffold ✅ (awaiting review)

### Stack (as specified; no deviations)
| Concern | Choice | Version |
|---|---|---|
| App | Next.js App Router + TypeScript (strict, `noUncheckedIndexedAccess`) | next 15.5, react 19 |
| UI | Tailwind v4 + shadcn/ui ("new-york" style; components vendored into `src/components/ui`) | tailwind 4.3 |
| DB | PostgreSQL 16 via Prisma | prisma 6.19 |
| Auth | Auth.js (`next-auth@5` beta) + `@auth/prisma-adapter` | 5.0.0-beta.32 |
| Jobs | BullMQ + Redis, separate worker process (`src/worker`) | bullmq 5 |
| Tests | Vitest (unit + DB integration) and Playwright (e2e) | vitest 4, playwright 1.63 |
| Logs | pino (structured JSON, redacts token/password fields) | |
| Packaging | One Dockerfile, two roles (app / worker); docker-compose with postgres + redis | |

### Decisions
1. **Auth.js v5 is still published as a beta.** It's the version that supports the App Router properly; v4 doesn't fit the App Router well. Pinned to an exact version.
2. **JWT sessions, not database sessions.** The Credentials provider requires JWT in Auth.js. The `Session` table stays in the schema so the adapter contract holds. **Consequence:** a user's `platformRole`/disabled state sits in the token until it expires (7 days). To limit the damage, `requireUserContext()` re-reads the user from the DB on every app render and rejects disabled users. Phase 1 will also refresh the role inside the `jwt` callback so middleware decisions use current data.
3. **Prisma 6, not 7.** Prisma 7 makes driver adapters mandatory and moves the config. 6.19 is stable and well-supported. Upgrading later is mechanical. (The `package.json#prisma` deprecation warning comes from this.)
4. **Full data model up front.** The whole schema from the spec is in the first migration, so later phases make only additive migrations. Every tenant-owned table has `workspaceId` and an index, ready for Phase 1 scoping.
5. **Additions to the spec's data model:**
   - `PostTarget`: one row per (post, social account) with its own status, attempts, error, and external id. Multi-platform posts need per-platform results (one can succeed while another fails), so `Post.status` alone isn't enough. Adds the `PARTIALLY_PUBLISHED` post status.
   - `PostMedia`: an ordered join table between posts and media.
   - `CreditLedgerEntry`: an **append-only** credit ledger; balance = `SUM(delta)`. It's auditable and race-safe, unlike a mutable balance column. `generationRequestId` is unique, so a generation can only be charged once.
   - `ProviderCredential`: encrypted AI keys. `workspaceId = NULL` is a platform key and a set `workspaceId` is BYOK. Platform keys can also come from env (`ANTHROPIC_API_KEY`, …); the router (Phase 3) will prefer the DB row, then env.
   - `StripeEvent`: an idempotency guard for webhooks (Phase 2).
   - `SocialAccount.isMock`: marks accounts connected through `MockPublisher`, so the publisher factory can route them correctly even after real credentials are added.
   - `Subscription.compOverrides` (JSON), `compReason`, `compedById`, `compExpiresAt`: support for full or partial comps as a first-class concept.
   - `Workspace.aiPreferences` (JSON): default provider+model per content type.
6. **Token encryption:** AES-256-GCM with a random 96-bit IV. Format `v1.<iv>.<tag>.<ct>`. `ENCRYPTION_KEY_PREVIOUS` allows key rotation (decrypt-only). Tested.
7. **Signup = user + workspace (WORKSPACE_ADMIN) + free-plan subscription + audit row, in one transaction.** Duplicate email → friendly error, no orphan rows. Tested.
8. **Login hardening already in place:** normalized email, a bcrypt compare even for unknown emails (no timing-based user enumeration), same error message for every failure, disabled users rejected, post-login redirect limited to same-origin paths (open-redirect guard, tested), and security headers (`X-Frame-Options: DENY`, `nosniff`, etc.). Auth.js supplies CSRF protection for its routes; Server Actions check the Origin header.
9. **App-sign-in OAuth (Google/GitHub) is opt-in by env.** Without credentials the buttons don't render. This is separate from social *publishing* connections (Phase 4).
10. **Worker:** BullMQ consumers + a repeatable `heartbeat` job (writes `worker:heartbeat` to Redis with a 3-minute TTL) to prove the pipeline end-to-end. Shuts down gracefully on SIGTERM.
11. **Brand name "Postpilot"** is a placeholder; change it in `src/app/layout.tsx`.

### Stubbed / deferred
- Nav items (Composer, Calendar, Posts, Accounts, Billing, Admin) show but are disabled until their phases.
- OAuth sign-ups don't create a workspace yet. Phase 1 adds "create your workspace" onboarding on first visit.
- No rate limiting on login yet (Phase 1/7, Redis-backed).
- No email verification or password reset. There's no email provider; **I'll ask you which one** before building them.
- S3/R2, Stripe, AI providers, and social publishers have env placeholders only. Their phases build them mock-first.

### Verification done in this environment
- `prisma migrate dev` + seed against local Postgres 16 ✅
- `tsc --noEmit`, `eslint` clean ✅
- Vitest: 25 tests (crypto, validation, redirect guard, slug, signup/login service against a real DB) ✅
- `next build` ✅
- Playwright: sign up → empty dashboard → sign out → protected redirect → log in; bad credentials; validation errors; seeded admin login ✅
- Worker boots, runs the heartbeat, shuts down cleanly ✅
- **Not verified here:** `docker build` / `docker compose up`, because the sandbox can't run the Docker daemon. CI has a `docker` job that builds the image.
