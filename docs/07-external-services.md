# 7. External Accounts, Services, Secrets and Infrastructure

## 7.1 Accounts you need

| Item | Needed by | Cost (approx.) | Notes |
|---|---|---|---|
| VPS (2 vCPU / 4 GB / 80 GB SSD, Ubuntu 24.04 LTS) | M1 | US$6–25/month | Hetzner, DigitalOcean, Linode/Akamai, OVH, Vultr… |
| Domain + DNS (your existing cPanel) | M1 | existing | `api.` and `admin.` subdomains |
| SMTP mailbox for system emails (e.g. `noreply@yourdomain` on cPanel) | M1 | existing | Set SPF, DKIM, DMARC for that domain so verification mails don't land in spam |
| Admin recovery mailbox (ideally not on the same host) | M1 | free/existing | |
| GitHub (this repo + Actions) | M1 | free tier OK | CI/CD |
| Test mailboxes: 2+ on cPanel, 1 on another host, 1 Gmail, 1 Outlook | M2–M4 | free/existing | Never use customer mailboxes in automated tests |
| S3-compatible object storage (2 buckets: data + backups, ideally different providers) | M2 / M9 | ~US$6/TB-month; usually <US$5 at this scale | Backblaze B2, Cloudflare R2, Wasabi |
| Expo account (EAS Build/Update) | M1 | free tier to start; paid plans for more builds/updates | |
| Google Play Developer account | M1 (internal testing) | US$25 one-time | Developer verification requirements apply |
| Firebase project (FCM) | M7 | free | |
| Google Cloud project + OAuth consent screen | **Start in M1** (lead time) | free to create; restricted-scope verification + annual CASA assessment can cost hundreds to thousands of US$ | Needed for Gmail OAuth; app passwords as interim |
| Microsoft Entra ID app registration | M4b | free | Publisher verification needs a Microsoft Partner Network ID |
| Apple Developer Program (when iOS is added) | later | US$99/year | |
| Optional: Google Safe Browsing API key | M9 | free (check terms) | |
| Optional: hosted uptime monitor / error tracker (e.g. Sentry with PII scrubbing) | M10 | free tiers | |

## 7.2 Secrets (never committed; examples only)

```dotenv
# apps/backend/.env.example  — values are placeholders
NODE_ENV=production
PUBLIC_API_URL=https://api.example.com
ADMIN_WEB_URL=https://admin.example.com
DATABASE_URL_API=postgres://app_api_login:CHANGE_ME@postgres:5432/emailplatform
DATABASE_URL_ADMIN=postgres://app_admin_login:CHANGE_ME@postgres:5432/emailplatform
DATABASE_URL_MIGRATOR=postgres://app_owner:CHANGE_ME@postgres:5432/emailplatform
BUSINESS_TIMEZONE=Africa/Lagos          # IANA zone used for calendar-month expiry
CREDENTIAL_KEY_FILE=/run/secrets/credential_key_v1   # 32 random bytes, base64
DATA_KEK_FILE=/run/secrets/data_kek_v1
JWT_PRIVATE_KEY_FILE=/run/secrets/jwt_ed25519.pem
SYSTEM_SMTP_HOST=mail.example.com
SYSTEM_SMTP_PORT=465
SYSTEM_SMTP_USER=noreply@example.com
SYSTEM_SMTP_PASSWORD_FILE=/run/secrets/system_smtp_password
S3_ENDPOINT=https://s3.us-west-004.backblazeb2.com
S3_BUCKET=emailplatform-data
S3_ACCESS_KEY_ID_FILE=/run/secrets/s3_key_id
S3_SECRET_ACCESS_KEY_FILE=/run/secrets/s3_secret
FCM_SERVICE_ACCOUNT_FILE=/run/secrets/fcm.json
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET_FILE=/run/secrets/google_oauth_secret
MS_OAUTH_CLIENT_ID=
MS_OAUTH_CLIENT_SECRET_FILE=/run/secrets/ms_oauth_secret
CLAMAV_HOST=clamav
CLAMAV_ENABLED=true
```

(`BUSINESS_TIMEZONE` above is only an example — tell me your zone.)
