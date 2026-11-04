import { execFileSync } from 'node:child_process';
import { readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { ImapFlow } from 'imapflow';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, type Db } from '../src/lib/db.js';
import { MemoryMailer } from '../src/lib/mailer.js';
import { loadConfig } from '../src/lib/config.js';
import { discover, parseAutoconfig, type DiscoveryDeps } from '../src/mail/discovery.js';
import { isPrivateAddress, resolveMailHost } from '../src/mail/net.js';
import { schedulerTick } from '../src/scheduler.js';
import { testEnv } from './env.js';
import { adminLogin, bearer, createAdmin, login, makeCtx, registerVerified, resetData, type Ctx } from './helpers.js';
import { MAIL_DIR, MAIL_PASSWORD, startSmtp } from './mailserver/smtp.js';

const AUTOCONFIG = `<?xml version="1.0"?><clientConfig version="1.1"><emailProvider id="test.local">
  <incomingServer type="pop3"><hostname>localhost</hostname><port>995</port><socketType>SSL</socketType></incomingServer>
  <incomingServer type="imap"><hostname>localhost</hostname><port>19993</port><socketType>SSL</socketType><username>%EMAILADDRESS%</username></incomingServer>
  <outgoingServer type="smtp"><hostname>localhost</hostname><port>19465</port><socketType>SSL</socketType><username>%EMAILADDRESS%</username></outgoingServer>
</emailProvider></clientConfig>`;

const fakeDiscovery: DiscoveryDeps = {
  resolveMx: async () => [],
  resolveSrv: async () => { throw new Error('no srv'); },
  fetchText: async (url) => (url.startsWith('https://autoconfig.test.local/') ? AUTOCONFIG : null),
};

const mailPasswords: Record<string, string> = { 'alice@test.local': MAIL_PASSWORD, 'bob@test.local': MAIL_PASSWORD };
function setMailPassword(user: string, password: string) {
  mailPasswords[user] = password;
  const hash = execFileSync('doveadm', ['pw', '-s', 'SHA512-CRYPT', '-p', password], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  const file = `${MAIL_DIR}/users`;
  const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => {
    const parts = l.split(':');
    if (parts[0] === user) parts[1] = hash;
    return parts.join(':');
  });
  writeFileSync(file, lines.join('\n') + '\n');
  // Dovecot re-reads the file when its mtime changes (1 s resolution): make every change visible.
  mtimeBump += 2;
  const t = Date.now() / 1000 + mtimeBump;
  utimesSync(file, t, t);
}
let mtimeBump = 0;

/** Waits until Dovecot accepts the given password (it reloads its user file asynchronously). */
async function waitForMailPassword(user: string, password: string) {
  for (let i = 0; i < 20; i++) {
    const c = new ImapFlow({ host: '127.0.0.1', port: 19993, secure: true, auth: { user, pass: password }, logger: false,
      tls: { ca: readFileSync(`${MAIL_DIR}/ca.pem`), servername: 'localhost' } });
    c.on('error', () => undefined);
    try {
      await c.connect();
      await c.logout();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`Dovecot did not accept the new password for ${user}`);
}
const authFailures = () => (readFileSync(`${MAIL_DIR}/dovecot.log`, 'utf8').match(/auth failed/gi) ?? []).length;

const trustedEnv = { MAIL_EXTRA_CA_FILE: `${MAIL_DIR}/ca.pem` };

let ctx: Ctx;
let worker: Db;
let smtp: Awaited<ReturnType<typeof startSmtp>>;
let token: string;
let userId: string;

beforeAll(async () => {
  ctx = await makeCtx({ env: trustedEnv, discovery: fakeDiscovery });
  worker = createPool(ctx.cfg, 'worker');
  smtp = await startSmtp(() => mailPasswords);
});
afterAll(async () => {
  await smtp.close();
  await worker.end();
  await ctx.close();
});
beforeEach(async () => {
  await resetData(ctx);
  setMailPassword('alice@test.local', MAIL_PASSWORD);
  await waitForMailPassword('alice@test.local', MAIL_PASSWORD);
  userId = await registerVerified(ctx, 'owner1@gmail.com');
  await ctx.owner.query(`UPDATE app.users SET status = 'approved', approved_at = now(), access_expires_at = now() + interval '1 month' WHERE id = $1`, [userId]);
  token = (await login(ctx, 'owner1@gmail.com')).body.accessToken;
});

const connect = (payload: object, t = token) =>
  ctx.api.inject({ method: 'POST', url: '/v1/mailboxes', headers: bearer(t), payload });
const manual = {
  imap: { host: 'localhost', port: 19993, security: 'tls', username: 'alice@test.local' },
  smtp: { host: 'localhost', port: 19587, security: 'starttls', username: 'alice@test.local' },
};

describe('discovery and network safety (unit)', () => {
  it('parses Thunderbird autoconfig and ignores non-IMAP servers', () => {
    expect(parseAutoconfig(AUTOCONFIG, 'alice@test.local')).toEqual({
      imap: { host: 'localhost', port: 19993, security: 'tls', username: 'alice@test.local' },
      smtp: { host: 'localhost', port: 19465, security: 'tls', username: 'alice@test.local' },
    });
  });

  it('recognises Hostinger-hosted domains by MX and offers cPanel-style guesses', async () => {
    const r = await discover('sales@allwebmails.com', {
      resolveMx: async () => [{ exchange: 'mx1.hostinger.com', priority: 5 }],
      resolveSrv: async () => [],
      fetchText: async () => null,
    });
    expect(r.hint?.name).toBe('Hostinger Email');
    expect(r.candidates[0]).toMatchObject({ source: 'mx', settings: { imap: { host: 'imap.hostinger.com', port: 993 } } });
    expect(r.candidates.map((c) => c.settings.imap.host)).toContain('mail.allwebmails.com');
  });

  it('flags Microsoft consumer addresses as needing OAuth', async () => {
    const r = await discover('someone@outlook.com', { resolveMx: async () => [], resolveSrv: async () => [], fetchText: async () => null });
    expect(r.hint?.requiresOAuth).toBe(true);
  });

  it('refuses private addresses and non-mail ports in production', async () => {
    const prod = loadConfig(testEnv({ MAIL_ALLOW_PRIVATE_HOSTS: 'false' }));
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', '::ffff:10.0.0.1']) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    await expect(resolveMailHost(prod, 'localhost', 993, 'imap')).rejects.toMatchObject({ code: 'BLOCKED_ADDRESS' });
    await expect(resolveMailHost(prod, '169.254.169.254', 993, 'imap')).rejects.toMatchObject({ code: 'BLOCKED_ADDRESS' });
    await expect(resolveMailHost(prod, 'imap.example.com', 22, 'imap')).rejects.toMatchObject({ code: 'PORT_NOT_ALLOWED' });
  });
});

describe('connecting a mailbox', () => {
  it('finds the settings automatically, verifies IMAP and SMTP, and stores the password encrypted', async () => {
    const r = await connect({ email: 'alice@test.local', password: MAIL_PASSWORD, displayName: 'Alice Sales' });
    expect(r.statusCode).toBe(201);
    const m = r.json().mailbox;
    expect(m).toMatchObject({ email: 'alice@test.local', status: 'active', displayName: 'Alice Sales' });
    expect(m.settings).toMatchObject({ discoveredVia: 'autoconfig', imap: { host: 'localhost', port: 19993 }, smtp: { port: 19465 } });
    const { rows } = await ctx.owner.query<{ imap_secret_enc: Buffer }>(`SELECT imap_secret_enc FROM app.mailbox_credentials WHERE mailbox_id = $1`, [m.id]);
    expect(rows[0]!.imap_secret_enc.includes(Buffer.from(MAIL_PASSWORD))).toBe(false);
    const list = await ctx.api.inject({ method: 'GET', url: '/v1/mailboxes', headers: bearer(token) });
    expect(list.json().mailboxes).toHaveLength(1);
    expect(JSON.stringify(list.json())).not.toContain(MAIL_PASSWORD);
  });

  it('accepts manual settings with STARTTLS', async () => {
    const r = await connect({ email: 'alice@test.local', password: MAIL_PASSWORD, manual });
    expect(r.statusCode).toBe(201);
    expect(r.json().mailbox.settings.smtp).toMatchObject({ port: 19587, security: 'starttls' });
  });

  it('stops at the first rejected password (one login attempt, no lockout risk)', async () => {
    const before = authFailures();
    const r = await connect({ email: 'alice@test.local', password: 'wrong-password' });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.details).toMatchObject({ stage: 'imap', reason: 'AUTH_FAILED' });
    await new Promise((res) => setTimeout(res, 300));
    expect(authFailures() - before).toBe(1);
    const { rows } = await ctx.owner.query(`SELECT count(*)::int AS n FROM app.mailboxes`);
    expect(rows[0].n).toBe(0);
  });

  it('rejects duplicates', async () => {
    expect((await connect({ email: 'alice@test.local', password: MAIL_PASSWORD })).statusCode).toBe(201);
    expect((await connect({ email: 'alice@test.local', password: MAIL_PASSWORD })).statusCode).toBe(409);
  });

  it('needs an active account', async () => {
    await ctx.owner.query(`UPDATE app.users SET status = 'pending', access_expires_at = NULL WHERE id = $1`, [userId]);
    expect((await connect({ email: 'alice@test.local', password: MAIL_PASSWORD })).json().error.code).toBe('account_pending');
  });
});

describe('untrusted certificates', () => {
  let strict: Ctx;
  beforeAll(async () => { strict = await makeCtx({ discovery: fakeDiscovery }); }); // test CA NOT trusted here
  afterAll(async () => { await strict.close(); });

  it('shows the certificate and connects only after the user explicitly trusts that exact certificate', async () => {
    const l = await login(strict, 'owner1@gmail.com');
    const first = await strict.api.inject({ method: 'POST', url: '/v1/mailboxes', headers: bearer(l.body.accessToken),
      payload: { email: 'alice@test.local', password: MAIL_PASSWORD, manual: { ...manual, smtp: { ...manual.smtp, port: 19465, security: 'tls' } } } });
    expect(first.statusCode).toBe(422);
    const d = first.json().error.details;
    expect(d.reason).toBe('TLS_UNTRUSTED');
    expect(d.certificate.subject).toBe('localhost');
    const pin = { sha256: d.certificate.fingerprint256, pem: d.certificate.pem };
    // Tampered PEM is ignored (fingerprint mismatch) → still untrusted.
    const tampered = await strict.api.inject({ method: 'POST', url: '/v1/mailboxes', headers: bearer(l.body.accessToken),
      payload: { email: 'alice@test.local', password: MAIL_PASSWORD, manual: { ...manual, smtp: { ...manual.smtp, port: 19465, security: 'tls' } },
        trustCertificate: { imap: { ...pin, sha256: 'AA:BB' }, smtp: pin } } });
    expect(tampered.json().error.details.reason).toBe('TLS_UNTRUSTED');
    const ok = await strict.api.inject({ method: 'POST', url: '/v1/mailboxes', headers: bearer(l.body.accessToken),
      payload: { email: 'alice@test.local', password: MAIL_PASSWORD, manual: { ...manual, smtp: { ...manual.smtp, port: 19465, security: 'tls' } },
        trustCertificate: { imap: pin, smtp: pin } } });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().mailbox.settings.trustedCertificate).toEqual({ imap: true, smtp: true });
  });
});

describe('password changes and health', () => {
  it('detects a changed password, stops retrying, and resumes after the new password is entered', async () => {
    const id = (await connect({ email: 'alice@test.local', password: MAIL_PASSWORD })).json().mailbox.id;
    setMailPassword('alice@test.local', 'changed-at-provider-1');
    const t = await ctx.api.inject({ method: 'POST', url: `/v1/mailboxes/${id}/test`, headers: bearer(token) });
    expect(t.json().error.details.reason).toBe('AUTH_FAILED');
    const after = (await ctx.api.inject({ method: 'GET', url: `/v1/mailboxes/${id}`, headers: bearer(token) })).json();
    expect(after.mailbox.status).toBe('auth_failed');
    expect(after.events[0]).toMatchObject({ severity: 'action_required', code: 'AUTH_FAILED' });
    // The scheduler never retries a rejected password.
    const before = authFailures();
    const tick = await schedulerTick(worker, ctx.cfg, new MemoryMailer(), () => undefined);
    expect(tick.mailboxRetries.attempted).toBe(0);
    expect(authFailures()).toBe(before);

    const wrong = await ctx.api.inject({ method: 'PUT', url: `/v1/mailboxes/${id}/connection`, headers: bearer(token), payload: { password: 'still-wrong' } });
    expect(wrong.statusCode).toBe(422);
    const fixed = await ctx.api.inject({ method: 'PUT', url: `/v1/mailboxes/${id}/connection`, headers: bearer(token), payload: { password: 'changed-at-provider-1' } });
    expect(fixed.statusCode).toBe(200);
    expect(fixed.json().mailbox.status).toBe('active');
    const { rows } = await ctx.owner.query(`SELECT generation FROM app.mailboxes WHERE id = $1`, [id]);
    expect(rows[0].generation).toBe(2);
  });

  it('retries temporary failures with backoff and recovers', async () => {
    const created = await connect({ email: 'alice@test.local', password: MAIL_PASSWORD });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().mailbox.id;
    // Simulate an outage: point at a closed port.
    await ctx.owner.query(`UPDATE app.mailbox_server_settings SET imap_port = 19994 WHERE mailbox_id = $1`, [id]);
    const t = await ctx.api.inject({ method: 'POST', url: `/v1/mailboxes/${id}/test`, headers: bearer(token) });
    expect(t.json().error.details.reason).toBe('CONNECT_REFUSED');
    const { rows } = await ctx.owner.query(`SELECT status, consecutive_failures, next_retry_at > now() AS later FROM app.mailboxes WHERE id = $1`, [id]);
    expect(rows[0]).toEqual({ status: 'error', consecutive_failures: 1, later: true });
    // Outage over, retry due.
    await ctx.owner.query(`UPDATE app.mailbox_server_settings SET imap_port = 19993 WHERE mailbox_id = $1`, [id]);
    await ctx.owner.query(`UPDATE app.mailboxes SET next_retry_at = now() WHERE id = $1`, [id]);
    const tick = await schedulerTick(worker, ctx.cfg, new MemoryMailer(), () => undefined);
    expect(tick.mailboxRetries).toEqual({ attempted: 1, recovered: 1 });
    const { rows: r2 } = await ctx.owner.query(`SELECT status, consecutive_failures FROM app.mailboxes WHERE id = $1`, [id]);
    expect(r2[0]).toEqual({ status: 'active', consecutive_failures: 0 });
  });

  it('pauses mailboxes on suspension and re-verifies them after reactivation', async () => {
    const { secret } = await createAdmin(ctx);
    const admin = await adminLogin(ctx, secret);
    const id = (await connect({ email: 'alice@test.local', password: MAIL_PASSWORD })).json().mailbox.id;
    await admin.post(`/admin/api/users/${userId}/suspend`);
    const s1 = await ctx.owner.query(`SELECT status FROM app.mailboxes WHERE id = $1`, [id]);
    expect(s1.rows[0].status).toBe('paused_account');
    expect((await schedulerTick(worker, ctx.cfg, new MemoryMailer(), () => undefined)).mailboxRetries.attempted).toBe(0);
    await admin.post(`/admin/api/users/${userId}/renew`, { mode: 'from_now' });
    expect((await schedulerTick(worker, ctx.cfg, new MemoryMailer(), () => undefined)).mailboxRetries).toEqual({ attempted: 1, recovered: 1 });
    // Admin sees health metadata, never credentials.
    const detail = (await admin.get(`/admin/api/users/${userId}`)).json();
    expect(detail.mailboxes[0]).toMatchObject({ email: 'alice@test.local', status: 'active' });
    expect(JSON.stringify(detail)).not.toMatch(/secret|password|imap_username/i);
  });
});

describe('isolation and disconnection', () => {
  it('another user cannot see, test, change or disconnect my mailbox', async () => {
    const id = (await connect({ email: 'alice@test.local', password: MAIL_PASSWORD })).json().mailbox.id;
    const other = await registerVerified(ctx, 'owner2@gmail.com');
    await ctx.owner.query(`UPDATE app.users SET status = 'approved', access_expires_at = now() + interval '1 month' WHERE id = $1`, [other]);
    const t2 = (await login(ctx, 'owner2@gmail.com')).body.accessToken;
    for (const [method, url, payload] of [
      ['GET', `/v1/mailboxes/${id}`, undefined], ['POST', `/v1/mailboxes/${id}/test`, {}],
      ['PATCH', `/v1/mailboxes/${id}`, { displayName: 'x' }], ['PUT', `/v1/mailboxes/${id}/connection`, { password: MAIL_PASSWORD }],
      ['POST', `/v1/mailboxes/${id}/disconnect`, { mode: 'delete', confirmEmail: 'alice@test.local' }],
    ] as const) {
      const r = await ctx.api.inject({ method, url, headers: bearer(t2), payload });
      expect(r.statusCode, `${method} ${url}`).toBe(404);
    }
    expect((await ctx.api.inject({ method: 'GET', url: '/v1/mailboxes', headers: bearer(t2) })).json().mailboxes).toEqual([]);
    // Admin database role cannot read credentials at all.
    const adminPool = createPool(ctx.cfg, 'admin', 1);
    await expect(adminPool.query(`SELECT * FROM app.mailbox_credentials`)).rejects.toThrow(/permission denied/);
    await adminPool.end();
  });

  it('disconnect keeps stored data without credentials; delete removes the mailbox; the server is untouched', async () => {
    const id = (await connect({ email: 'alice@test.local', password: MAIL_PASSWORD })).json().mailbox.id;
    const mismatch = await ctx.api.inject({ method: 'POST', url: `/v1/mailboxes/${id}/disconnect`, headers: bearer(token), payload: { mode: 'keep', confirmEmail: 'bob@test.local' } });
    expect(mismatch.statusCode).toBe(400);
    await ctx.api.inject({ method: 'POST', url: `/v1/mailboxes/${id}/disconnect`, headers: bearer(token), payload: { mode: 'keep', confirmEmail: 'alice@test.local' } });
    const { rows } = await ctx.owner.query(
      `SELECT m.status, (SELECT count(*) FROM app.mailbox_credentials WHERE mailbox_id = m.id)::int AS creds FROM app.mailboxes m WHERE id = $1`, [id]);
    expect(rows[0]).toEqual({ status: 'disconnected', creds: 0 });
    // Reconnecting the same address is allowed once the old one is disconnected.
    const again = await connect({ email: 'alice@test.local', password: MAIL_PASSWORD });
    expect(again.statusCode).toBe(201);
    await ctx.api.inject({ method: 'POST', url: `/v1/mailboxes/${again.json().mailbox.id}/disconnect`, headers: bearer(token), payload: { mode: 'delete', confirmEmail: 'alice@test.local' } });
    const { rows: left } = await ctx.owner.query(`SELECT count(*)::int AS n FROM app.mailboxes WHERE id = $1`, [again.json().mailbox.id]);
    expect(left[0].n).toBe(0);
    // Mailbox on the server still works.
    setMailPassword('alice@test.local', MAIL_PASSWORD);
    expect((await connect({ email: 'alice@test.local', password: MAIL_PASSWORD })).statusCode).toBe(201);
  });
});
