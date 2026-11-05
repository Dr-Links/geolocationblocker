# Deploying to alllivechats.com on Hostinger (hPanel)

This installs the chat platform at **https://alllivechats.com** using
`dist/alllivechats-hostinger-1.2.0.zip`. It takes about 20 minutes and needs
no SSH. Nothing here has been run on your account yet. Take a backup first
(hPanel → **Websites → Manage → Files → Backups**) if anything already lives
on the domain.

Below, `u123456789` stands for your Hostinger username (shown in hPanel and
in File Manager paths).

## 1. PHP version

hPanel → **Websites → alllivechats.com → Manage → Advanced → PHP Configuration**:
choose **PHP 8.2 or 8.3**. On the *PHP extensions* tab make sure `pdo_mysql`,
`mbstring`, `openssl`, `curl`, `gd` and `intl` are ticked (they are by default).

## 2. Database

hPanel → **Databases → Management** (MySQL Databases):

1. Database name, e.g. `alllivechats` → becomes `u123456789_alllivechats`.
2. Username, e.g. `alcadmin` → becomes `u123456789_alcadmin`.
3. Click *Generate* for a strong password and store it in your password manager.
4. **Create**. The host is `localhost`.

## 3. Mailbox for outgoing email

hPanel → **Emails → Email Accounts** → create `no-reply@alllivechats.com`
with a strong password. It sends invitations, password resets and
verification emails over SMTP (`smtp.hostinger.com`, port 465, SSL), which is
already set in the config template.

## 4. Upload the files

hPanel → **Files → File Manager**, open `domains/alllivechats.com/`.

1. Inside `public_html/`, delete Hostinger's placeholder files (`default.php`,
   `index.html`) if present. Keep anything you deliberately put there.
2. Back in `domains/alllivechats.com/`, **Upload** `alllivechats-hostinger-1.2.0.zip`.
3. Right-click it → **Extract** into the current folder.

You now have:

```
domains/alllivechats.com/
├── public_html/     ← web root: index.php, .htaccess, sw.js, assets/, widget/
└── signalpost/      ← application, config and storage (NOT web-accessible)
```

4. Delete the ZIP afterwards.

## 5. Configure

1. Open **https://alllivechats.com** in your browser. It says "not configured
   yet" and prints a freshly generated **application key**. Copy it. (The key
   is generated on the fly and not stored anywhere.)
2. In File Manager, go to `signalpost/config/`, copy
   `config.alllivechats.example.php` to **`config.php`** and edit `config.php`.
   Replace every value marked `CHANGE`:
   * `app.key` → the key from step 1
   * `db.name`, `db.user`, `db.password` → from section 2
   * `mail.smtp.password` → the mailbox password from section 3
3. Save, then set `config.php` permissions to **600** (right-click → Permissions).

## 6. SSL

hPanel → **Security → SSL**: make sure alllivechats.com shows an active
certificate (Hostinger installs one automatically). The app forces HTTPS.

## 7. Create your owner account

1. Go to **https://alllivechats.com/install**.
2. The page creates `signalpost/storage/setup-token.txt`. Open it in File
   Manager and paste its contents into the *Setup token* field.
3. Fill in your name, email, first workspace name and a strong password →
   **Create owner and finish**. The installer creates the database tables, then
   disables itself permanently.
4. Sign in at https://alllivechats.com/login.
5. **Account → Two-factor authentication → Set up** (strongly recommended for
   the platform owner).
6. **Platform admin → Health**: every line should be OK apart from the cron
   line until step 8 is done.

## 8. Cron job (retention cleanup)

hPanel → **Websites → Manage → Advanced → Cron Jobs** → *Custom*:

* Command: `/usr/bin/php /home/u123456789/domains/alllivechats.com/signalpost/bin/console cron:run`
* Schedule: every 15 minutes (`*/15 * * * *`).

After 15 minutes, **Platform admin → Health → Last cron run** shows a time.

## 9. Install the operator app (PWA) and turn on notifications

The dashboard is an installable Progressive Web App.

* **Android / Chrome / Edge (desktop or phone):** open https://alllivechats.com,
  sign in, then use **Install app** in the sidebar (or the browser menu →
  *Install app* / *Add to Home screen*).
* **iPhone / iPad (iOS 16.4+):** Safari → Share → **Add to Home Screen**, then
  open the app from the Home Screen.

Then, inside the installed app: **Account → App and notifications → Enable
notifications on this device**, and **Send a test notification**. You'll be
notified of new visitor messages on every device where you enable this.
Message text is hidden in notifications unless you tick "Show the first words
of the visitor's message".

## 10. Connect your WordPress sites

For each WordPress site:

1. Dashboard → **Websites & widget → Add a WordPress website** with the site's
   exact address (e.g. `https://www.example.com`) → **Generate pairing code**.
2. In that WordPress site: **Plugins → Add New → Upload Plugin** →
   `signalpost-connector-1.2.0.zip` → Install → Activate.
3. **Settings → Signalpost Chat**: server address `https://alllivechats.com`,
   paste the pairing code → **Connect**.

## 11. Activation codes (who can sign up, and for how long)

Registration defaults to **Activation code**: people can create an account only
with a single-use code you generate.

* **Platform admin → Activation codes**: choose 1 month, 3 months, 6 months or
  1 year, how many codes, and a note (who it's for) → **Generate**. Copy the
  codes immediately — they are shown once. Send each person their code and the
  sign-up link `https://alllivechats.com/register`.
* One code creates exactly one account. The access period starts at sign-up.
* When the period ends, the account is signed out and can only open the
  renewal page. Entering a **new** code reopens the **same** account (all data
  kept). Renewing early adds the time to the end of the current period.
* The list shows each code's status (unused / used / revoked), who used it,
  and until when that account has access. Unused codes can be revoked.
* **Platform admin → Accounts → Extend** adds time without a code (audited).
* Settings (Platform admin → Settings): whether invited team members need
  their own code (default: they share the workspace owner's period), whether
  chat widgets go offline while an owner is expired (default: offline; data is
  kept), and the reminder email lead time (default 7 days).
* Your platform owner account never expires and needs no code.

Other registration modes: `Invitation only`, `Open` (anyone, no time limit)
or `Closed`.

## Updating later (site already installed)

1. Back up: hPanel → **Databases → phpMyAdmin** → select the database →
   **Export** (Quick, SQL), plus hPanel → Files → **Backups** if you like.
2. File Manager → `domains/alllivechats.com/` → upload the new
   `alllivechats-hostinger-<version>.zip` → **Extract**, choosing to
   **overwrite**. `signalpost/config/config.php` and your `signalpost/storage/`
   data are not in the ZIP, so they are kept. Delete the ZIP.
3. Open https://alllivechats.com. If the update includes database changes,
   you are sent to **/upgrade** (signed-in pages and the dashboard API pause
   until it's done). Open `signalpost/storage/upgrade-token.txt` in File
   Manager, paste its contents, and click **Apply update**. The token file is
   deleted and the page disables itself.
4. Sign in again and check **Platform admin → Health** (no pending migrations).

Alternative with SSH: `php ~/domains/alllivechats.com/signalpost/bin/console migrate`.
Accounts that existed before activation codes keep working with no time limit;
use **Platform admin → Accounts → Extend** if you want to put one on a limit.

## If something goes wrong

* Blank page or error 500: check `signalpost/storage/logs/` (File Manager) and
  that `config.php` values are right. Also see docs/TROUBLESHOOTING.md.
* "HTTPS is required": the SSL certificate isn't active yet (section 6).
* Emails not arriving: check the mailbox password in `config.php` and that
  `no-reply@alllivechats.com` exists. hPanel → Emails → *Email deliverability*
  helps you set up SPF/DKIM.
* Notifications not arriving on iPhone: the app must be opened from the Home
  Screen, not from a Safari tab.
