# BUILD_NOTES

Running log of decisions, assumptions, and stubs. Newest phase at the top.

---

## Phase 4: Social connections + publishers ✅ (awaiting review)

### What you can do
- **Accounts** (`/dashboard/accounts`): connect X, Instagram, Facebook, LinkedIn, TikTok and YouTube; see status (Connected / Expired / Error / Disconnected), token expiry and last check; **Check** the connection, **Disconnect**, and **Reconnect**. Usage is shown against the plan's account limit.
- With no platform app credentials, **Connect** opens a clearly labelled **simulated consent screen**. It then runs the *real* OAuth machinery: state + PKCE bound to your user and workspace, the callback, the code exchange, and encrypted token storage.
- **Composer → "Check for accounts"**: pick target accounts and validate the draft against each platform's publisher rules, with errors and warnings per account. **This is the Phase 4 acceptance check.**

### Architecture (as specified)
- **`SocialPublisher` interface** (`src/server/social/types.ts`):
  - `connect()` is split into `authorizeUrl()` (where to send the browser) and `connect()` (code → tokens + profiles);
  - `refreshToken()`, `validateMedia(post)`, `publish(post)`, plus `checkHealth()`.
- **`MockPublisher`** is the default:
  - signed one-time auth codes; 1-hour tokens, so refresh actually gets exercised;
  - realistic delays and validation;
  - test hooks: `[mock:fail]` for a transient failure, `[mock:reject]` for a permanent one.
- **Real adapters** activate only when their env credentials are set (`registry.ts`); otherwise the mock is used. Accounts connected through the mock stay on the mock even after credentials are added.

  | Adapter | Auth | Publishing |
  |---|---|---|
  | `XPublisher` | OAuth 2.0 + PKCE | v2 tweets; one-shot image upload; chunked video upload with processing poll |
  | `MetaPublisher` (one Meta app) | short → long-lived user token; **Page** tokens (don't expire) | FB: feed / photos / multi-photo / video. IG: container → processing poll → `media_publish`, reels and carousels |
  | `LinkedInPublisher` | OpenID + `w_member_social` | versioned REST Posts / Images / Videos (`LINKEDIN_API_VERSION` configurable) |
  | `TikTokPublisher` | PKCE | Direct Post, FILE_UPLOAD + status poll; `SELF_ONLY` privacy until the app passes TikTok's audit |
  | `YouTubePublisher` | Google OAuth offline + consent (for a refresh token) | resumable upload |

- **Platform rules are shared and pure** (`validation.ts`): text limits counted in code points (emoji = 1), image and video counts, mixing rules, formats, sizes, durations, Instagram aspect ratios (4:5 to 1.91:1), YouTube titles, hashtag warnings, and Instagram/Facebook "needs public media URLs" (which requires S3). Mock and real publishers validate identically; Phase 5's per-platform preview will reuse this.
- **OAuth security:**
  - state (192-bit random) + PKCE verifier live in an **HMAC-signed, 10-minute, httpOnly, `SameSite=Lax` cookie** scoped to `/api/social`;
  - the callback re-checks the state, platform, **workspace and user**, so a callback can't be replayed into another workspace or account;
  - the mock consent screen only ever redirects to our own callback (open-redirect guard) and checks the `Origin` header.
- **Tokens:** encrypted at rest (AES-256-GCM).
  - Refresh happens before use when a token expires within 5 minutes, plus a **worker sweep every 30 minutes** for tokens expiring within 24 hours.
  - A rejected refresh marks the account **EXPIRED**; a transient failure marks it **ERROR**.
  - Disconnect wipes the credentials but keeps the row, so post history stays intact.
- **Limits:**
  - Connected accounts are enforced in the callback, per account (Meta can return several Pages at once; any beyond the limit are skipped and reported).
  - Reconnecting an existing account never needs a new slot. Re-activating a disconnected one does.
  - Only workspace admins can connect or disconnect; members can view.

### Bugs found and fixed this phase
1. **The up-front limit check blocked reconnecting** an expired account at the limit. Start now only blocks when there's nothing on that platform to reconnect; the callback still enforces the limit, and a test proves a different account authorized through a "reconnect" is refused.
2. **The EXPIRED status written by a failed refresh was rolled back** when the error propagated out of the transaction. Callers now catch inside the transaction (covered by the sweep test).
3. **The mock consent screen's server-action redirect became a client-side soft navigation**, so the browser never actually loaded the OAuth callback. It's now a plain form POST + 303 to a route handler, like a real provider redirect (caught by e2e).
4. The OAuth routes swallowed Next.js's redirect-to-login; they now rethrow control-flow errors.
5. Connect tiles overflowed on phones.

### ⚠️ Not yet verified against live platform APIs
I couldn't reach the platforms' developer docs from this sandbox (its network blocks docs.x.com and learn.microsoft.com), and there are no app credentials yet. The real adapters follow each platform's documented OAuth and REST flows as I know them, and are unit-tested against a scripted fake `fetch` for authorize URLs, token exchange and publish request shapes. **Expect small adjustments on first live use**, most likely in X's v2 media upload paths and LinkedIn's version string. Version strings are env-configurable for that reason.

### Tests added
- **Unit (23):**
  - every platform rule;
  - PKCE; HTTP error mapping (401 → reconnect, 429/5xx → retryable);
  - the mock publisher's connect, refresh, publish and failure hooks;
  - each real adapter's authorize URL, code exchange and publish flow (X media + tweet, LinkedIn headers + `x-restli-id`, Meta page tokens + IG container polling, TikTok upload + status, YouTube resumable upload + refresh-token retention).
- **Integration (16):**
  - the full mock OAuth round trip with encrypted storage and audit; reconnect without duplicates;
  - forged, mismatched and cancelled callbacks; cross-workspace replay;
  - plan limits (start and callback, including the reconnect loophole); permissions;
  - refresh-before-use; a revoked refresh persisting EXPIRED; the cross-tenant worker sweep; transient failures → ERROR;
  - disconnect freeing the slot; tenant isolation; validation against target accounts.
- **E2E (5):**
  - connect two accounts, health check, disconnect, limit reached;
  - cancelled consent; a forged callback;
  - composer validation per account (invalidated by edits); members get a read-only view.
- Totals: **210 unit/integration + 29 e2e, all passing.**

### Stubbed / next
- Publishing itself is wired and unit-tested; it gets **triggered by the Phase 5 scheduler** (worker-driven, with retries and backoff).
- When Meta returns several Pages, all of them are connected (up to the limit) instead of showing a picker. A picker can come later if you want it.
- Provider-side token revocation on disconnect isn't implemented; we only delete our copy.

### Needs you
- **Developer app credentials** for whichever platforms you want live (X, Meta, LinkedIn, TikTok, Google/YouTube). Each requires registering the redirect URI shown in `.env.example`. Several also need app review before posting publicly (Meta `instagram_content_publish`/`pages_manage_posts`, TikTok Direct Post audit, Google verification for YouTube upload).
- **S3/R2** for Instagram/Facebook media, which those APIs fetch from a public URL.

---

## Phase 3: AI generation ✅

### What you can do
- **Composer** (`/dashboard/compose`):
  - Write a post, then generate **captions** (platform-aware, 1-3 options, tone), **images** (1:1, 4:5, 9:16, 16:9) or **short videos**.
  - Text: **Use** or **Append** it. Media: preview it and **Attach** it to the post.
  - Save as a draft with its media; drafts are listed and reopen with everything attached.
- Each generation runs as an async job (`GenerationRequest` → BullMQ `generation` queue → worker). The UI polls until it's done and shows the provider, model, any fallback, and the credits used.
- **Credit costs: 1 text / 5 image / 25 video** (your choice), editable in **Admin → AI**.
- **AI settings** (`/dashboard/settings/ai`): default provider + model per content type, and bring-your-own API keys (BYOK). Keys are masked (only the last 4 characters show) and BYOK requires the plan feature.
- **Admin → AI**: credit costs, platform API keys (encrypted in the DB, overriding env vars), and each provider's status.

### Architecture (as specified)
- Interfaces `TextGenerator` / `ImageGenerator` / `VideoGenerator` (`src/server/ai/types.ts`).
- **Mocks, the zero-key default:**
  - text: template captions built from the brief, respecting platform limits;
  - image: a real PNG gradient at the requested aspect ratio;
  - video: a real 4-second H.264 MP4, vertical or landscape.

  Test hooks: `[mock:fail]` in the prompt simulates an outage, `[mock:refuse]` simulates a policy refusal.
- **Real adapters** use each vendor's **official SDK**, with every SDK difference contained in its file:

  | Adapter | Text | Image | Video |
  |---|---|---|---|
  | `anthropic.ts` (`@anthropic-ai/sdk`) | Claude | n/a | n/a |
  | `openai.ts` (`openai`) | Responses API | `gpt-image-1` | Sora 2 Videos API (async polling) |
  | `google.ts` (`@google/genai`) | Gemini (JSON) | Imagen | Veo (long-running operation + authenticated download) |
  | `huggingface.ts` (`@huggingface/inference`) | chat | text-to-image | text-to-video (experimental) |

  Each activates only when a key exists (platform key, env var, or the workspace's BYOK).
- **Anthropic specifics:**
  - default model `claude-opus-5-5`;
  - structured output, so captions come back as validated JSON;
  - `effort: "low"` (captions are a light task; change in `anthropic.ts`);
  - **server-side refusal fallbacks enabled by default** (`fallbacks: "default"`) on models that support them. Tell me if you'd rather not have this;
  - refusals become a clear "declined" message.
- **Router** (`router.ts`) builds the provider chain:
  1. the per-generation override, else the workspace default;
  2. then other configured providers (with their default models);
  3. then the mock, only when nothing real is configured, when the mock was explicitly chosen, or when `AI_FALLBACK_TO_MOCK=true`. In production a real-provider failure shouldn't silently return placeholder content.

  Retryable errors (429/5xx/overload/timeouts/bad key) fall through to the next provider. **Refusals and invalid requests stop the chain**: we don't route around a safety refusal by shopping vendors.
- **`GenerationService`** (`service.ts`) is the only thing the UI calls: `requestGeneration()` (validate, gate on feature/credits/rate limit, record, enqueue) and `processGeneration()` (worker).
- **Keys & cost model:**
  - Platform keys come from the DB (encrypted, Admin → AI) or env.
  - The workspace's BYOK key wins when the plan allows it. **BYOK generations charge 0 credits.**
  - Platform-key and mock generations charge the configured cost. Mock charges are intentional, so the usage meters and limits are exercised end to end.
- **Credit settlement is idempotent per generation.** Charges and refunds carry the generation id, and the net is held at exactly the cost (or 0) under a per-workspace advisory lock. Writing tests surfaced a double-refund bug in my first design (a unique-constraint approach); this replaced it. Failed or refused generations are fully refunded, and job retries can't double-charge.
- **Storage:** an S3/R2 adapter when `S3_*` is set, else local files (`STORAGE_LOCAL_DIR`; docker-compose shares a volume between app and worker).
  - Media is always served through `/api/media/[id]`, which checks the tenant first: another workspace's id is a 404 thanks to RLS. S3 gets a 15-minute signed redirect; local files are streamed with Range support for video.
  - Keys are tenant-prefixed (`workspaces/<id>/…`).
- **Worker** now runs the `generation` queue (concurrency `AI_WORKER_CONCURRENCY`), has an optional health endpoint (`WORKER_HEALTH_PORT`), and loads `.env` itself.

### Limits wired this phase
- **AI video** is gated on the plan's `video` feature.
- **Credits** are checked at request time (fast feedback) and again atomically when the worker charges.
- **BYOK** is gated on the plan's `byok` feature.
- **Posts per period** are enforced when a draft is created.
- **Rate limit:** 20 generations per workspace per minute (env).

### Decisions / notes
- Model names are **suggestions, not restrictions**: workspaces can enter any model id the provider accepts. Defaults were taken from the installed SDKs' own type definitions and doc examples (e.g. `gpt-5.5`, `gpt-image-1`, `sora-2`, `gemini-3.8-flash`, `imagen-4.0-generate-001`, `veo-2.0-generate-001`).
- **The real adapters have not been called against live APIs** (no keys yet). They're unit-tested against fake SDK clients for request shape, response parsing, refusal handling, retry classification and the async video polling. Expect minor adjustments on first live use, especially for video, where account access varies (Sora, Veo).
- E2E tests run their own app + worker on a separate Redis DB, so a dev worker can't steal test jobs.
- Fixed while checking layouts: page grids overflowed on phones (this included the Phase 1 members page). Every page now fits 390 px.

### Tests added
- **Unit (36):** mock generators (real PNG/MP4 output), the caption prompt and parser, error classification, every adapter against fake SDK clients, and router planning (BYOK precedence, plan gating, fallback order, mock policy).
- **Integration (18):**
  - the mock pipeline for all three types, with correct credit charges;
  - admin-set costs; input validation;
  - fallback across providers with a single charge; a refusal stopping the chain and refunding;
  - all-providers-failing with a safe error message;
  - workspace preference vs. per-generation override;
  - BYOK (key used, 0 credits, encrypted, isolated);
  - BYOK gated by plan; platform-key precedence over env;
  - out-of-credits at request time and when the worker runs;
  - idempotent charge, refund and processing;
  - cross-tenant generation/media isolation; the rate limit.
- **E2E (6):**
  - generate caption, image and video, attach, save and reload the draft;
  - free plan: video locked, credits decreasing, failures refunded;
  - media isolation across workspaces (404);
  - admin cost change reflected in the composer;
  - AI defaults and a masked BYOK key; free plan blocked from BYOK.
- Totals: **171 unit/integration + 24 e2e, all passing.**

### Needs you
- **Provider API keys** to go live: Anthropic, OpenAI, Google and/or Hugging Face. Add them in Admin → AI (stored encrypted) or as env vars. Each one turns on independently.
- **S3/R2 bucket credentials** for production media (local disk works for a single server; Phase 4 publishing to Instagram/TikTok will need publicly fetchable URLs, which S3 signed URLs provide).

---

## Phase 2: Billing ✅

### Your direction: the admin sets and changes all prices
- **Admin → Plans** (`/admin/plans`): create and edit plans. Each plan has a price, currency, monthly/yearly interval, four usage limits (-1 = unlimited), three feature flags (video, bring-your-own-key, recurring posts), plus active/visible flags and sort order.
- The seed's four plans (Free/Starter/Pro/Agency) are **only starting defaults**. Re-seeding never overwrites a plan that already exists.
- **Price changes are grandfathered.** Stripe prices can't be edited, so a change creates a new price (`PlanPrice` row) that becomes current for **new** checkouts. Existing subscribers keep paying what they signed up for until they switch plans. The editor shows how many subscribers that affects, and price history marks each price current or grandfathered.
- **Limit and feature changes apply immediately** to every workspace on the plan. Entitlements are computed live; nothing is copied per workspace.
- Guards:
  - Plan keys are permanent.
  - The `free` plan must stay $0 and active, since it's the fallback for lapsed workspaces.
  - Plans are never deleted, only deactivated or hidden.
- Every change is audit-logged with before/after values.

### Architecture
- **One billing-provider interface** (`src/server/billing/types.ts`) with two adapters:
  - `StripeBillingProvider`: active when `STRIPE_SECRET_KEY` is set.
  - `MockBillingProvider` (default): local checkout page (card 4242… succeeds, 4000…0002 is declined) and portal (switch plan, cancel/resume, and simulate renewal or payment failure).
- **One writer for subscription state:** `applyBillingEvent()` (`sync.ts`). Stripe webhooks and the mock both produce the same normalized `BillingEvent`, so the mock exercises the production sync path. It is:
  - **idempotent**: event ids are recorded in `StripeEvent`, so replays are no-ops;
  - **order-safe**: `lastEventAt` makes it ignore events that arrive late;
  - **loud on unknown prices**: it throws and rolls back, so Stripe retries instead of the event being silently dropped.
- **Webhook** at `POST /api/webhooks/stripe`. It verifies the signature on the raw body, then re-fetches the subscription from Stripe instead of trusting partial payloads. It handles current Stripe API versions, where billing periods live on subscription items. Returns 5xx on errors so Stripe retries.
- **Comp is stored apart from billing.** `Subscription.planId` is what's *billed* (it mirrors Stripe), and `compPlanId` + `compOverrides` is what the admin *granted*. A webhook therefore can never wipe a comp, and removing a comp reverts cleanly to the billed plan.
- **Entitlement rule** (`limits.ts`, pure and unit-tested), in order:
  1. active comp (not expired) → comp plan + overrides;
  2. paid subscription that's ACTIVE, TRIALING or PAST_DUE (grace while Stripe retries the card) → billed plan;
  3. otherwise → Free.

  Setting a paid `planId` without a provider subscription grants nothing.
- **Usage counting** happens in the database at check time (no counters to drift):
  - **posts:** created in the current period;
  - **accounts:** not disconnected;
  - **seats:** members + pending invites;
  - **credits:** plan allowance + the sum of ledger entries in the period.

  The period is the Stripe billing period when one is active, otherwise the UTC calendar month. Credits don't roll over.
- **Credit spending is race-free.** `consumeCredits()` takes a per-workspace Postgres advisory lock inside the tenant transaction. A test fires 25 concurrent 1-credit spends against a 10-credit allowance; exactly 10 succeed.

### Comping and free accounts (first-class admin actions)
- **Comp an existing workspace** (`/admin/workspaces/[id]`): choose a plan, optionally override any limit or feature (partial comp), give a reason (required, audited) and an optional expiry. You can also cancel their paid Stripe subscription at period end. "Remove comp" reverts to the billed plan.
- **Create free account** (`/admin/accounts/new`): creates a comped workspace for an email. Existing users become its admin right away. New people get a single-use admin invitation link, shown to you since there's no email provider yet.
- Comped workspaces see "Complimentary" on Billing with nothing to buy, and checkout refuses them.

### Limits enforced now vs. later
- **Now:** member seats, both when inviting and when accepting. Accepting re-checks in case the plan was downgraded in between.
- **Ready, wired in later phases:**
  - `assertWithinLimit(…, "maxPostsPerMonth")` → Phase 5
  - `assertWithinLimit(…, "maxSocialAccounts")` → Phase 4
  - `assertFeature(…, "video" | "byok" | "recurring")` → Phases 3/5
  - `consumeCredits` / `refundCredits` → Phase 3

  All of these are tested already.
- **Product consequence of the default limits:** Free has 1 seat, so a new team must upgrade before inviting. Change Free's member limit in Admin → Plans if you'd rather allow small teams for free.

### Admin revenue
The admin overview shows MRR, ARR, and counts of paying, comped and past-due workspaces, plus revenue per plan. Yearly prices are normalized to monthly, and comped workspaces count as $0. The full analytics view is Phase 6.

### Decisions / notes
- **Prisma refused `migrate dev` and `migrate reset` in this non-interactive agent session** (a safety check against AI agents). I didn't bypass it. I generated the migration SQL with `prisma migrate diff` and applied it with `migrate deploy`. For a clean slate I created a **new local dev database (`socialai_dev`)** instead of resetting the old one. On your machine, `npm run db:migrate` works normally.
- E2E tests now run against the **test database** (migrated and seeded automatically), so local dev data stays clean.
- Mock checkout and portal links are HMAC-signed, expire after 1 hour, are bound to the user, and also re-check that the user is a workspace admin. Mock billing is disabled entirely once Stripe is configured.
- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` isn't used yet: Stripe-hosted Checkout and Portal need only the secret key. It's kept for embedded Elements later.

### Tests added
- **Unit:** entitlement resolution (comp, paid, past-due grace, lapsed, expired comp, partial overrides, malformed overrides), periods, MRR math, signed tokens, Stripe event mapping, and real Stripe signature verification (offline).
- **Integration** (21 tests):
  - grandfathering end to end, admin guards;
  - idempotent, stale and unknown-price events;
  - the full mock lifecycle (declined → paid → switch → past due → cancel → renewal ends it) and checkout permissions;
  - comps surviving webhooks, partial comps, free-account creation for new and existing users;
  - seat limits, credit concurrency, unlimited plans, tenant isolation of the ledger, revenue.
- **E2E** (6 new, 18 total): subscribe with a test card (decline first) and manage in the portal; admin creates a plan, sells it, raises the price and the old customer stays grandfathered; admin creates a free account that the owner claims; partial comp and removal; the free-plan seat block; revenue on the overview.
- Totals: **117 unit/integration + 18 e2e, all passing.**

### Stubbed / needs you
- **Stripe test keys** to run real Stripe Checkout (see README "Stripe setup"). Until then everything runs on the mock.
- **Configure the Stripe customer portal** in your Stripe dashboard (allow plan switching across your products), since Stripe hosts it.
- No trials, coupons UI, taxes or invoices list yet. Stripe Checkout already accepts promotion codes you create in Stripe.

---

## Phase 1: Multi-tenancy ✅

### Defaults I chose for your open questions (change any time)
- **Email provider:** not chosen yet, so `ConsoleMailer` logs emails (bodies only outside production). Since nothing is actually sent, **invite links are shown in the UI** for the admin to share. A real provider plugs into `src/server/mail/index.ts`.
- **Brand:** "Postpilot" kept as the placeholder.
- **Repo:** staying in `geolocationblocker`.

### How isolation works (defense in depth)
1. **Postgres row-level security is the enforcement layer** (`prisma/migrations/*_rls`). Every tenant table has a `tenant_isolation` policy keyed to the transaction-local setting `app.workspace_id`. `FORCE ROW LEVEL SECURITY` applies it to table owners too. Child tables (`PostTarget`, `PostMedia`, `PostSchedule`) are scoped through their parent post. Their `WITH CHECK` also verifies **every referenced row** (social account, media, generation) is in the same workspace, so cross-tenant linking is impossible even with a guessed id.
2. **Fail closed:** with no workspace set, tenant tables look empty and writes are rejected.
3. **Three DB entry points** (`src/lib/db.ts`):
   - `tenantDb(workspaceId)` / `withTenantTx(workspaceId, fn)`: all in-app access. Each operation runs in a tiny transaction that first calls `set_config('app.workspace_id', …, true)`. The setting is transaction-local, so it's safe with pooled connections, including PgBouncer transaction mode (Neon pooler).
   - `systemDb` / `withSystemTx(fn)`: trusted cross-tenant code only (auth/membership lookups, signup, admin console, invite tokens, seed, and later the worker). Sets `app.bypass_rls = 'on'`.
   - `db` (raw): global tables only (User, Account, Plan, …) and the Auth.js adapter.
4. **Two DB roles.** RLS is skipped for superusers and `BYPASSRLS` roles, so:
   - `DATABASE_URL` = runtime role `postpilot_app` (member of `app_user`, not a superuser)
   - `DIRECT_DATABASE_URL` = owner role, used only by `prisma migrate`

   The migration creates the `app_user` group role and grants. **At boot (`src/instrumentation.ts`) the app refuses to start in production if `DATABASE_URL` would bypass RLS**, and warns in dev.
5. **App layer on top:** `getTenantContext()` re-reads the user and membership from the DB on every request. A forged `pp_ws` cookie is ignored unless the user is really a member. `assertCan(ctx, permission)` checks the role matrix (`src/server/tenancy/permissions.ts`).
6. **SUPER_ADMIN gate:** middleware does a coarse check on the JWT. `/admin` re-checks the DB in the layout **and** in every page (`requireSuperAdmin()`).

### Trade-off to be aware of
- The bypass is a session setting the app role is allowed to set. That's simpler than a second connection pool with a `BYPASSRLS` role, at the cost that application code (not SQL injection, since Prisma parametrizes) could bypass it. Every `systemDb` use is greppable and should be justified in review. If you want the stricter version (a separate pool and role for system access), it's a contained change in `src/lib/db.ts`.
- Each `tenantDb` operation costs one extra round trip (`set_config`). Use `withTenantTx` to batch hot paths.

### Other decisions
- **Roles:** `WORKSPACE_ADMIN` manages workspace settings, members, billing, connected accounts and AI settings. `MEMBER` creates and publishes content and can view members. A workspace can never lose its last admin (demote/remove/leave is blocked). SUPER_ADMIN gets **no implicit access** to workspace content; that will come only through audited impersonation (Phase 6).
- **Invitations:** a 256-bit random token, **only its SHA-256 is stored**, 7-day expiry, single use (claimed atomically), and it can only be accepted by the **matching email**. Re-inviting revokes the previous link. Signing up through an invite joins that workspace instead of creating a new one.
- **Session revocation:** `User.sessionVersion` is copied into the JWT. Bumping it (or disabling the user) kills live sessions on the next request. Found and fixed a redirect loop: middleware trusted the still-valid JWT while the server rejected it. `/auth/revoked` now clears the cookie.
- **Rate limiting** (Redis fixed window, `src/server/rate-limit.ts`): login 10 per 15 min per email and 50 per 15 min per IP; signup 5 per hour per IP; configurable by env. **Fails open** if Redis is down (logged), so an outage doesn't lock everyone out. Client IP comes from `X-Forwarded-For`, which assumes a trusted proxy in front.
- **Multiple workspaces per user**, switchable from the sidebar. OAuth sign-ups and users who left their last workspace land on `/onboarding`.
- **Suspended workspaces** (`Workspace.suspendedAt`) send non-admins to `/suspended`. The admin action that sets it arrives in Phase 6.
- **Seed** now also creates a second tenant, "Globex Bakery" (`other@example.com`), with a private draft, to demonstrate isolation.

### Tests added (all passing)
- `tests/integration/tenant-isolation.test.ts`, **22 tests**. They deliberately write "buggy" queries (no filter, foreign ids, nested creates, raw SQL, moving rows between workspaces, linking across tenants) and assert the DB refuses. **Proven meaningful:** run as a superuser, 20 of the 22 fail.
- `members.test.ts`: role rules, last-admin guard, cross-tenant member edits, the invite lifecycle (hash-only storage, single use, email binding, revoke, expiry, re-invite).
- `rate-limit.test.ts` and `permissions.test.ts`. Signup via invite, including rollback on email mismatch.
- E2E (12 total): forged workspace cookie, `/admin` gating (signed-out, non-admin, super admin), the full invite → signup → member-permissions flow, workspace create/switch, rename, session revocation and disable.
- Totals: **69 unit/integration + 12 e2e.**

### Stubbed / deferred
- Plan limits on members (`maxMembers`) are enforced in Phase 2 with the other usage limits.
- Admin console is read-only (workspace and user lists). Comp, suspend, disable and impersonate come in Phases 2 and 6.
- Email verification and password reset still wait for an email provider.

---

## Phase 0: Scaffold ✅

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
2. **JWT sessions, not database sessions.** The Credentials provider requires JWT in Auth.js. The `Session` table stays in the schema so the adapter contract holds. The server re-reads the user from the DB on every request, and Phase 1 added `sessionVersion` for revocation, so a stale token can't keep access.
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
