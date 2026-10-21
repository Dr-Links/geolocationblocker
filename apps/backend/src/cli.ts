#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { checkPassword, PASSWORD_PROBLEM_TEXT } from '@app/shared';
import { enrollMfa } from './admin/mfa.js';
import { audit } from './lib/audit.js';
import { loadConfig, type DbRole } from './lib/config.js';
import { randomToken, sha256 } from './lib/crypto.js';
import { createPool, tx } from './lib/db.js';
import { TokenSigner } from './lib/jwt.js';
import { loadEnvFile } from './lib/envfile.js';
import { createMailer } from './lib/mailer.js';
import { migrate } from './lib/migrate.js';
import { hashPassword } from './lib/passwords.js';
import { schedulerTick } from './scheduler.js';

const HELP = `Usage: node dist/cli.js <command>

  db:migrate              Apply pending database migrations (connects as DB_USER_OWNER)
  db:create-roles         Development only: create the database users (needs a superuser as owner)
  admin:create            Create the single administrator (EMAIL via --email, password prompted or ADMIN_PASSWORD)
  admin:emergency-reset   Print a one-time admin recovery link (needs server access)
  token:emergency         Offline: print a random token and its SHA-256 hash for SQL-only recovery
  keys:generate           Print a new JWT_PRIVATE_KEY and CREDENTIAL_KEY
  scheduler:tick          Run one scheduler pass (use from cron every minute)
  scheduler:run           Run the scheduler every 30 s until stopped
  check:outbound          Test whether this server can reach external mail servers (Milestone 2 prerequisite)
`;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function main() {
  loadEnvFile();
  const cmd = process.argv[2];
  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(HELP);
    return;
  }

  if (cmd === 'keys:generate') {
    const pem = await TokenSigner.generatePem();
    console.log('# Save these to files outside the web root and point *_FILE settings at them.\n');
    console.log('CREDENTIAL_KEY=' + randomBytes(32).toString('base64'));
    console.log('\nJWT_PRIVATE_KEY (PEM):\n' + pem);
    return;
  }

  if (cmd === 'token:emergency') {
    const token = randomToken();
    console.log(`token: ${token}\nsha256 hex: ${sha256(token).toString('hex')}`);
    console.log(`\nSQL (run in phpPgAdmin or psql, valid 15 minutes):\nINSERT INTO app.auth_tokens (user_id, purpose, token_hash, expires_at)\nSELECT id, 'admin_emergency', decode('${sha256(token).toString('hex')}', 'hex'), now() + interval '15 minutes'\n  FROM app.users WHERE role = 'admin';\n\nThen open: <ADMIN_WEB_URL>/emergency?token=${token}`);
    return;
  }

  if (cmd === 'check:outbound') {
    const targets: Array<[string, number]> = [
      ['smtp.gmail.com', 465], ['smtp.gmail.com', 587], ['imap.gmail.com', 993],
      ['outlook.office365.com', 993], ['smtp.office365.com', 587],
      ['imap.mail.yahoo.com', 993], ['fcm.googleapis.com', 443],
    ];
    const extra = arg('host');
    if (extra) for (const p of [993, 465, 587, 143]) targets.push([extra, p]);
    for (const [host, port] of targets) {
      const result = await new Promise<string>((resolve) => {
        const s = connect({ host, port, timeout: 8000 });
        s.once('connect', () => { s.destroy(); resolve('OPEN'); });
        s.once('timeout', () => { s.destroy(); resolve('TIMEOUT (probably blocked by the host firewall)'); });
        s.once('error', (e) => resolve(`ERROR ${(e as NodeJS.ErrnoException).code ?? e.message}`));
      });
      console.log(`${host}:${port}`.padEnd(32) + result);
    }
    return;
  }

  const cfg = loadConfig();

  if (cmd === 'db:create-roles') {
    if (cfg.env === 'production') throw new Error('db:create-roles is for development. On cPanel, create users in "PostgreSQL Databases".');
    const owner = createPool(cfg, 'owner', 1);
    try {
      for (const role of ['auth', 'api', 'admin', 'worker'] as DbRole[]) {
        const name = cfg.db.users[role];
        const pw = cfg.db.passwords[role] ?? 'dev-password';
        const exists = await owner.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [name]);
        const c = await owner.connect();
        try {
          const verb = exists.rowCount ? 'ALTER' : 'CREATE';
          await c.query(`${verb} ROLE ${c.escapeIdentifier(name)} LOGIN PASSWORD ${c.escapeLiteral(pw)}`);
          await c.query(`GRANT CONNECT ON DATABASE ${c.escapeIdentifier(cfg.db.database)} TO ${c.escapeIdentifier(name)}`);
        } finally {
          c.release();
        }
        console.log(`${exists.rowCount ? 'updated' : 'created'} role ${name}`);
      }
    } finally {
      await owner.end();
    }
    return;
  }

  if (cmd === 'db:migrate') {
    const owner = createPool(cfg, 'owner', 1);
    try {
      const applied = await migrate(owner, cfg);
      console.log(applied.length ? `Applied ${applied.length} migration(s).` : 'Database is up to date.');
    } finally {
      await owner.end();
    }
    return;
  }

  if (cmd === 'admin:create') {
    const email = (arg('email') ?? (await prompt('Administrator email: '))).toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Invalid email');
    let password = process.env.ADMIN_PASSWORD;
    if (!password) {
      console.log('(The password is shown while typing. Clear your terminal afterwards.)');
      password = await prompt('Administrator password (min 14 characters): ');
      if ((await prompt('Repeat password: ')) !== password) throw new Error('Passwords do not match');
    }
    const problem = checkPassword(password);
    if (problem) throw new Error(PASSWORD_PROBLEM_TEXT[problem]);
    if (password.length < 14) throw new Error('The administrator password must be at least 14 characters.');
    const owner = createPool(cfg, 'owner', 1);
    try {
      const enrollment = await tx(owner, async (c) => {
        const existing = await c.query(`SELECT 1 FROM app.users WHERE role = 'admin'`);
        if (existing.rowCount) throw new Error('An administrator already exists. Use admin:emergency-reset to recover access.');
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO app.users (email_normalized, email_display, password_hash, role, status, email_verified_at, access_expires_at)
           VALUES ($1, $1, $2, 'admin', 'approved', now(), 'infinity') RETURNING id`, [email, await hashPassword(password)]);
        await c.query(`SET LOCAL search_path = app, pg_catalog`);
        const e = await enrollMfa(c, cfg, rows[0]!.id, email);
        await audit(c, { actorType: 'system', action: 'admin.created', targetType: 'user', targetId: rows[0]!.id });
        return e;
      });
      printEnrollment(enrollment);
    } finally {
      await owner.end();
    }
    return;
  }

  if (cmd === 'admin:emergency-reset') {
    const owner = createPool(cfg, 'owner', 1);
    try {
      const token = randomToken();
      await tx(owner, async (c) => {
        const { rowCount } = await c.query(
          `INSERT INTO app.auth_tokens (user_id, purpose, token_hash, expires_at)
           SELECT id, 'admin_emergency', $1, now() + interval '15 minutes' FROM app.users WHERE role = 'admin'`, [sha256(token)]);
        if (!rowCount) throw new Error('No administrator exists yet. Run admin:create.');
        await c.query(`INSERT INTO app.audit_log (actor_type, action, details) VALUES ('system', 'admin.emergency_token_created', '{"via":"cli"}')`);
      });
      console.log(`One-time recovery link (valid 15 minutes):\n\n  ${cfg.adminWebUrl}/emergency?token=${token}\n`);
      console.log('Opening it lets you set a new password and enrol a new authenticator. All admin sessions will be signed out.');
    } finally {
      await owner.end();
    }
    return;
  }

  if (cmd === 'scheduler:tick' || cmd === 'scheduler:run') {
    const worker = createPool(cfg, 'worker', 2);
    const mailer = createMailer(cfg);
    const once = async () => {
      try {
        await schedulerTick(worker, mailer);
      } catch (err) {
        console.error(`scheduler tick failed: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    };
    if (cmd === 'scheduler:tick') {
      await once();
      await worker.end();
      return;
    }
    let stop = false;
    process.on('SIGTERM', () => { stop = true; });
    process.on('SIGINT', () => { stop = true; });
    while (!stop) {
      await once();
      for (let i = 0; i < 30 && !stop; i++) await new Promise((r) => setTimeout(r, 1000));
    }
    await worker.end();
    return;
  }

  console.error(`Unknown command: ${cmd}\n`);
  console.log(HELP);
  process.exitCode = 1;
}

function printEnrollment(e: { secret: string; otpauthUri: string; recoveryCodes: string[] }) {
  console.log('\nAdministrator created.\n');
  console.log('1) Add this key to your authenticator app (Google Authenticator, Microsoft Authenticator, Aegis, 1Password...):');
  console.log(`   Secret: ${e.secret}`);
  console.log(`   or open/scan: ${e.otpauthUri}\n`);
  console.log('2) Store these one-time recovery codes somewhere safe and offline. Each works once:');
  for (const c of e.recoveryCodes) console.log(`   ${c}`);
  console.log('\nThey will not be shown again.');
}

main().catch((err) => {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
});
