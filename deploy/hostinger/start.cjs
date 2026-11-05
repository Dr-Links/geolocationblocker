// Hostinger (LiteSpeed lsnode) startup file for AllWebMails. lsnode loads startup files with require();
// the application is an ES module, so it is imported dynamically.
//
// Settings come from the site's Node.js environment variables (hPanel → Websites → <site> → Node.js →
// Environment variables). They are also written to a private file outside public_html
// (~/.awm/env, mode 600) so that the cron job — which does not receive those variables — uses the same settings.
'use strict';
const fs = require('fs');
const path = require('path');

const role = process.env.AWM_ROLE === 'admin' ? 'admin' : 'api';
if (process.env.JWT_PRIVATE_KEY_B64 && !process.env.JWT_PRIVATE_KEY) {
  process.env.JWT_PRIVATE_KEY = Buffer.from(process.env.JWT_PRIVATE_KEY_B64, 'base64').toString('utf8');
}
const KEEP = /^(NODE_ENV|PUBLIC_API_URL|ADMIN_WEB_URL|TRUST_PROXY|COOKIE_SECURE|DB_[A-Z_]+|CREDENTIAL_KEY|JWT_PRIVATE_KEY|SMTP_[A-Z_]+|WEB_[A-Z_]+|PUSH_PROVIDER|EXPO_[A-Z_]+|FCM_[A-Z_]+|BLOB_[A-Z_]+|S3_[A-Z_]+|BACKUP_[A-Z_]+|PG_[A-Z_]+|CLAMAV_[A-Z_]+|MIN_APP_VERSION|LATEST_APP_VERSION|APP_DOWNLOAD_URL|JOB_STALE_SECONDS|MAIL_[A-Z_]+|HTTP_RATE_LIMIT)$/;
const quote = (v) => (v.includes('\n') || v.includes("'") ? `"${v.replace(/"/g, '\\"')}"` : `'${v}'`);
try {
  const dir = path.join(process.env.HOME || __dirname, '.awm');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Files and backups live outside the build folders (which are replaced on every deploy).
  if (!process.env.BLOB_DIR) process.env.BLOB_DIR = path.join(dir, 'blobs');
  if (!process.env.BACKUP_DIR) process.env.BACKUP_DIR = path.join(dir, 'backups');
  const body = Object.keys(process.env).filter((k) => KEEP.test(k)).sort().map((k) => `${k}=${quote(process.env[k])}`).join('\n') + '\n';
  const file = path.join(dir, 'env');
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (role === 'api' && old !== body && body.includes('DB_HOST=')) {
    fs.writeFileSync(`${file}.tmp`, body, { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  }
  // The cron job runs this script every minute: migrations, then the scheduler, sending, sync and notifications.
  if (role === 'api') {
    const current = path.join(process.env.HOME || '', 'hbuilds', 'current', 'nodejs');
    const appDir = fs.existsSync(path.join(current, 'dist', 'cli.js')) ? current : __dirname;
    const script = [
      '#!/bin/bash',
      '# Written by start.cjs. Run every minute by the Hostinger cron job.',
      `cd ${JSON.stringify(appDir)} || exit 1`,
      `export ENV_FILE=${JSON.stringify(file)}`,
      `NODE=${JSON.stringify(process.execPath)}`,
      '"$NODE" dist/cli.js db:migrate > /dev/null || exit 1',
      'exec "$NODE" dist/cli.js cron --seconds 50',
      '',
    ].join('\n');
    // One-time administrator setup (run once by a temporary cron job). The password is generated on this
    // server and, with the authenticator key and recovery codes, written only to a private file.
    const adminScript = [
      '#!/bin/bash',
      'OUT="$(dirname "$0")/ADMIN-SETUP.txt"',
      '[ -e "$OUT" ] && exit 0',
      'umask 077',
      `cd ${JSON.stringify(appDir)} || exit 1`,
      `export ENV_FILE=${JSON.stringify(file)}`,
      'export ADMIN_PASSWORD="$(head -c 18 /dev/urandom | base64 | tr -d "/+=")Aa1!"',
      '{ echo "AllWebMails administrator — keep this safe, then DELETE this file."; echo "Admin site: https://admin.allwebmails.com"; echo "Email: $1"; echo "Password: $ADMIN_PASSWORD"; echo;',
      `  ${JSON.stringify(process.execPath)} dist/cli.js admin:create --email "$1"; } > "$OUT" 2>&1`,
      '',
    ].join('\n');
    const adminFile = path.join(dir, 'admin-setup.sh');
    if (!fs.existsSync(adminFile) || fs.readFileSync(adminFile, 'utf8') !== adminScript) fs.writeFileSync(adminFile, adminScript, { mode: 0o700 });
    const cronFile = path.join(dir, 'cron.sh');
    if (!fs.existsSync(cronFile) || fs.readFileSync(cronFile, 'utf8') !== script) fs.writeFileSync(cronFile, script, { mode: 0o700 });
  }
} catch (err) {
  console.error(`AllWebMails: could not write the settings file: ${err.message}`);
}

import(role === 'admin' ? './dist/entry-admin.js' : './dist/entry-api.js').catch((err) => {
  console.error(err);
  process.exit(1);
});
