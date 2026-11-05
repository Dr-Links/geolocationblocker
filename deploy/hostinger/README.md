# AllWebMails on Hostinger Business (shared hosting) + Neon

This is how the live platform runs. It was set up through the Hostinger API.

| Site | Hostinger website | What runs |
|---|---|---|
| allwebmails.com | static site | `deploy/website/` (landing, download, privacy) |
| app.allwebmails.com | Node.js app, entry `start.cjs` (`AWM_ROLE=api`) | web app (PWA) + API for the web and Android apps |
| admin.allwebmails.com | Node.js app, entry `start.cjs` (`AWM_ROLE=admin`) | administrator site |
| cron job, every minute | `/bin/bash ~/domains/app.allwebmails.com/.awm/cron.sh` | migrations, scheduler, sending, mailbox sync, notifications |
| Database | Neon project `allwebmails` (eu-central-1), PostgreSQL 17 | users `awm_owner` (owner) + `awm_auth/api/admin/worker` |

**Settings** are the Node.js environment variables of each site. Edit them in hPanel → Websites → *site* → Node.js → Environment variables.
- On start, `start.cjs` writes them to `~/domains/app.allwebmails.com/.awm/env` (mode 600, outside `public_html`). The cron job uses that file.
- Stored files and backups live in `~/domains/app.allwebmails.com/.awm/blobs` and `.awm/backups`.

**Deploy a new version** (from the repository root):
```bash
npm ci && npm run build
(cd apps/mobile && npm ci && npx expo export --platform web --output-dir dist-web)
node deploy/hostinger/package.mjs        # → deploy/hostinger/out/allwebmails.zip
```
Then, for both app.allwebmails.com and admin.allwebmails.com:
1. Upload `allwebmails.zip` (hPanel → Node.js → Deploy, or the API's upload URL).
2. Build with Node 22, entry file `start.cjs`, build script `build`.

Migrations run automatically from the next cron run.

**Health:**
- `https://app.allwebmails.com/healthz`: the app is up.
- `https://app.allwebmails.com/healthz/jobs`: the cron job is running; returns 503 if it stops.
