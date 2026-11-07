# Swapping mocks for real services

Every external integration has a mock that is used by default, so the app works end to end with no credentials. **To switch one to the real service, set its environment variables and restart the app and the worker.** Clear them to go back to the mock.

- **The variables come in groups.** In production the app refuses to boot if a group is half-filled (for example `STRIPE_SECRET_KEY` without `STRIPE_WEBHOOK_SECRET`). The error names exactly what's missing.
- **The app and worker must have the same values.** The worker publishes posts, runs generations and refreshes tokens, so it needs the same keys as the app.
- **Social callback URLs are built from `APP_URL`.** Set it to your public `https://` URL *before* registering apps with the platforms below.

| Integration | Mock behaviour | Turns real when these are set |
|---|---|---|
| Object storage | Files on local disk (`STORAGE_LOCAL_DIR`) | `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` (+ `S3_ENDPOINT`/`S3_REGION`) |
| Payments | Mock checkout and portal (test card 4242…) | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` |
| AI text/image/video | Placeholder text, generated PNG, sample MP4 | Any of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_AI_API_KEY`, `HUGGINGFACE_API_TOKEN` (or keys saved in **Admin → AI**) |
| X, Facebook/Instagram, LinkedIn, TikTok, YouTube | Mock consent screen; posts "publish" with realistic delays | Each platform's client id + secret (below) |
| App sign-in with Google/GitHub | Buttons hidden; email and password only | `AUTH_GOOGLE_ID`/`SECRET`, `AUTH_GITHUB_ID`/`SECRET` |
| Email (invites) | Written to the server log | Not built yet: **tell me which provider you want** (Resend, Postmark, SES…) |

---

## Object storage (S3 or Cloudflare R2)

**Required in production when the app and worker run on different machines** (Render, Fly, or more than one server), because local disk isn't shared between them. It's also required for **Facebook and Instagram media posts**: Meta downloads the file from a URL, and only S3/R2 can issue one (a short-lived signed URL).

**Cloudflare R2**
1. Create a bucket. Keep it **private**; don't enable public access.
2. Under R2 → **Manage API tokens**, create a token with *Object Read & Write* on that bucket.
3. Set:
   ```
   S3_BUCKET=postpilot-media
   S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
   S3_REGION=auto
   S3_ACCESS_KEY_ID=…
   S3_SECRET_ACCESS_KEY=…
   ```

**AWS S3**
1. Create a private bucket with Block Public Access left on.
2. Create an IAM user (or role) whose policy allows `s3:PutObject`, `s3:GetObject` and `s3:DeleteObject` on `arn:aws:s3:::<bucket>/workspaces/*`.
3. Set `S3_BUCKET`, `S3_REGION` (e.g. `us-east-1`) and the two keys. Leave `S3_ENDPOINT` empty.

**How it behaves**
- Object keys are `workspaces/<workspaceId>/<yyyy>/<mm>/<assetId>.<ext>`. You can scope bucket policies or lifecycle rules per workspace.
- The browser never gets a permanent link. `/api/media/<id>` checks tenant access, then redirects to a 15-minute signed URL.
- Media uploaded before the switch stays on local disk and won't be found. Copy `.data/media/` into the bucket with the same keys if you need it.

## Stripe

1. In the Stripe Dashboard, use **test mode** first and copy the secret key (`sk_test_…`).
2. **Developers → Webhooks → Add endpoint** with these settings:
   - URL: `https://<your-domain>/api/webhooks/stripe`
   - Events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `customer.subscription.paused`, `customer.subscription.resumed`, `invoice.paid`, `invoice.payment_failed`

   Copy the signing secret (`whsec_…`).
3. **Settings → Billing → Customer portal:** enable it, and allow plan switching and cancellation.
4. Set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`, then restart.
5. Open **Admin → Plans → Sync plans to Stripe**. This creates a real Stripe product and price for each paid plan. Price changes you make in the admin after this create new Stripe prices automatically, and existing subscribers keep their old price.
6. For local testing, run `stripe listen --forward-to localhost:3000/api/webhooks/stripe` and use the `whsec_` value it prints.

**Notes**
- Subscriptions are mirrored from webhooks, which are idempotent and safe to replay. Stripe's automatic retries cover temporary outages.
- Workspaces subscribed through the mock keep `mock_` ids. They show as free once Stripe is on, so re-subscribe them or comp them in the admin.
- Going live: switch to `sk_live_…`, create a live-mode webhook (it has its own `whsec_…`), and sync plans again.

## AI providers

Keys can live in **env** (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_AI_API_KEY`, `HUGGINGFACE_API_TOKEN`) or be saved encrypted in **Admin → AI**. When both exist, the admin-saved key wins.

**Routing**
- Each workspace picks a default provider and model per content type in **Settings → AI**. Each generation can override it.
- If the chosen provider fails with a temporary error, the router tries the next configured provider.
- If the provider *refuses* the prompt (a content-policy block), the router stops instead of shopping the prompt around.
- `AI_FALLBACK_TO_MOCK=true` adds the mock as a last resort. Leave it `false` in production so users are never charged for placeholder output.

**Credits and keys**
- Platform keys spend platform **credits** (1 text / 5 image / 25 video by default; change these in **Admin → AI**).
- A workspace can add its **own** key (BYOK) in **Settings → AI**. Generations then go through that key and use no credits.

| Provider | Text | Image | Video | Notes |
|---|---|---|---|---|
| Anthropic | Claude Opus / Sonnet / Haiku | – | – | |
| OpenAI | GPT | gpt-image-1 | Sora | Sora depends on your organization's access |
| Google | Gemini | Imagen | Veo | Veo needs a paid Gemini API tier |
| Hugging Face | Llama (via Inference Providers) | FLUX.1 | Wan 2.1 (experimental) | Availability varies by model |

Model lists live in `src/server/ai/catalog.ts`. To add a provider, implement `TextGenerator` / `ImageGenerator` / `VideoGenerator` in `src/server/ai/providers/`, then register it in `catalog.ts` and `registry.ts`.

## Social platforms

**Callback URLs.** For every platform, the OAuth redirect URL to register is:

```
${APP_URL}/api/social/callback/<platform>
```

`<platform>` is one of `x`, `facebook`, `instagram`, `linkedin`, `tiktok`, `youtube`. Register the URL exactly, with no trailing slash.

**Existing connections.** Accounts connected through the mock stay on the mock. To switch one, disconnect it and reconnect it once real credentials are set.

**Review times.** Most platforms only let *your own* test accounts post until the app passes review, so start review early. App review can take days to weeks.

### X (Twitter)
1. In the developer portal, create a Project and an App.
2. Under **User authentication settings**, turn on OAuth 2.0 and set the type to *Web App, Automated App or Bot*. Add the callback URL.
3. Scopes requested: `tweet.read tweet.write users.read media.write offline.access`.
4. Set `X_CLIENT_ID` and `X_CLIENT_SECRET` (the OAuth 2.0 client credentials, not the API key and secret).
5. Posting needs an X API tier that includes write access. **Media upload needs a paid tier**, so check X's current pricing before you rely on it.

### Facebook Pages and Instagram (Meta)
1. Create a **Business** app at developers.facebook.com and add **Facebook Login for Business**. Add the two callback URLs (`…/facebook` and `…/instagram`).
2. Permissions requested:
   - Facebook: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`.
   - Instagram: those plus `instagram_basic`, `instagram_content_publish`, `business_management`.
3. Set `META_APP_ID` and `META_APP_SECRET`. `META_GRAPH_VERSION` is optional and defaults to `v21.0`.
4. Instagram publishing only works for **Instagram Business/Creator accounts linked to a Facebook Page**. Each connect lists the Pages (or IG accounts) the user grants.
5. **App Review** with **Business Verification** is required before anyone outside your app's roles can connect.
6. Media posts need **S3/R2** (see above).

### LinkedIn
1. Create an app at linkedin.com/developers. It must be linked to a LinkedIn Page.
2. Add the products **Sign In with LinkedIn using OpenID Connect** and **Share on LinkedIn**.
3. Add the callback URL. Scopes requested: `openid profile w_member_social`.
4. Set `LINKEDIN_CLIENT_ID` and `LINKEDIN_CLIENT_SECRET`. `LINKEDIN_API_VERSION` is optional.
5. This posts to the member's own profile. Posting to company Pages needs the Community Management API, which requires separate approval.

### TikTok
1. Create an app at developers.tiktok.com and add **Login Kit** and **Content Posting API** (Direct Post).
2. Add the callback URL. Scopes requested: `user.info.basic video.publish`.
3. Set `TIKTOK_CLIENT_KEY` and `TIKTOK_CLIENT_SECRET`.
4. **Until TikTok audits your app, posts can only be private** (`TIKTOK_PRIVACY_LEVEL=SELF_ONLY`). After the audit, set `PUBLIC_TO_EVERYONE` if you want.
5. Videos are sent as a direct file upload (`FILE_UPLOAD`). TikTok doesn't fetch them from a URL, so neither S3 nor domain verification is needed.

### YouTube
1. In Google Cloud, create a project and enable **YouTube Data API v3**.
2. Configure the OAuth consent screen and create an **OAuth client** of type *Web application*. Add the callback URL.
3. Scopes requested: `youtube.upload youtube.readonly`.
4. Set `YOUTUBE_CLIENT_ID` and `YOUTUBE_CLIENT_SECRET`.
5. While the consent screen is in *Testing*, only listed test users can connect, and their tokens expire after 7 days. Uploads from unverified apps are forced to private. Request an audit to lift both, and keep `YOUTUBE_PRIVACY_STATUS=private` until then.
6. The default quota (10,000 units/day) allows about 6 uploads a day. Request more quota from Google.

### What to expect after switching
- Tokens are encrypted at rest (AES-256-GCM with `ENCRYPTION_KEY`). The worker refreshes them before they expire.
- An account whose refresh fails shows as **Needs reconnect**, both to the workspace and in **Admin → Publishing ops**.
- Each platform's real error message is stored on the post and shown in the Posts page and the ops view.

## App sign-in (Google / GitHub)

This is separate from publishing connections: these let users log in to Postpilot itself.

- **Google:** create an OAuth client (*Web application*) with the redirect URI `${APP_URL}/api/auth/callback/google`. Set `AUTH_GOOGLE_ID` and `AUTH_GOOGLE_SECRET`.
- **GitHub:** create an OAuth App with the callback URL `${APP_URL}/api/auth/callback/github`. Set `AUTH_GITHUB_ID` and `AUTH_GITHUB_SECRET`.

The buttons appear on the login page once a pair is set.

## Email

Invitations are currently "sent" by writing them to the log (`ConsoleMailer`), and the invite link is also shown in the UI so you can copy it. A real provider plugs in at `src/server/mail/index.ts`. **I haven't picked one, because it's a paid vendor decision: tell me which.** Password reset and email verification are waiting on the same choice.
