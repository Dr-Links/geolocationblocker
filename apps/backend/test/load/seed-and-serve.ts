// Load-test helper (not part of the test suite): seeds a user with a synced mailbox of N messages,
// starts the API on 127.0.0.1:19760, and prints a bearer token. Run with tsx.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ImapFlow } from 'imapflow';
import { createPool } from '../../src/lib/db.js';
import { runSyncPass } from '../../src/sync/runner.js';
import { bearer, login, makeCtx, registerVerified, resetData } from '../helpers.js';
import { MAIL_DIR, MAIL_PASSWORD, startSmtp } from '../mailserver/smtp.js';

const N = Number(process.env.LOAD_MESSAGES ?? 300);
const ctx = await makeCtx({ env: { MAIL_EXTRA_CA_FILE: `${MAIL_DIR}/ca.pem` }, discovery: { resolveMx: async () => [], resolveSrv: async () => [], fetchText: async () => null } });
const worker = createPool(ctx.cfg, 'worker', 5);
const smtp = await startSmtp(() => ({ 'alice@test.local': MAIL_PASSWORD }));
await resetData(ctx);
const c = new ImapFlow({ host: '127.0.0.1', port: 19993, secure: true, auth: { user: 'alice@test.local', pass: MAIL_PASSWORD }, logger: false,
  tls: { ca: readFileSync(`${MAIL_DIR}/ca.pem`), servername: 'localhost' } });
c.on('error', () => undefined);
await c.connect();
for (const f of await c.list()) {
  const lock = await c.getMailboxLock(f.path);
  try { if (c.mailbox && c.mailbox.exists) await c.messageDelete('1:*'); } finally { lock.release(); }
}
for (let i = 0; i < N; i++) {
  await c.append('INBOX', `From: Customer ${i % 40} <c${i % 40}@example.org>\r\nTo: alice@test.local\r\nSubject: Order ${i} invoice and delivery\r\n` +
    `Message-ID: <${randomUUID()}@x>\r\nDate: ${new Date(Date.now() - i * 60_000).toUTCString()}\r\n\r\nHello, this is message ${i} about invoice number ${1000 + i}.\r\n`);
}
await c.logout();
const uid = await registerVerified(ctx, 'load.user@gmail.com');
await ctx.owner.query(`UPDATE app.users SET status = 'approved', access_expires_at = now() + interval '1 month' WHERE id = $1`, [uid]);
const token = (await login(ctx, 'load.user@gmail.com')).body.accessToken as string;
await ctx.api.inject({ method: 'POST', url: '/v1/mailboxes', headers: bearer(token), payload: { email: 'alice@test.local', password: MAIL_PASSWORD,
  manual: { imap: { host: 'localhost', port: 19993, security: 'tls', username: 'alice@test.local' }, smtp: { host: 'localhost', port: 19465, security: 'tls', username: 'alice@test.local' } } } });
const t0 = Date.now();
for (let i = 0; i < 5; i++) {
  await ctx.owner.query(`UPDATE app.mailboxes SET next_sync_at = now(), sync_lease_until = NULL`);
  await runSyncPass(ctx.cfg, worker, { budgetMs: 60_000, log: () => undefined });
}
const { rows } = await ctx.owner.query(`SELECT count(*)::int AS n FROM app.messages`);
console.log(`SYNCED ${rows[0].n} messages in ${Date.now() - t0} ms`);
await ctx.api.listen({ port: 19760, host: '127.0.0.1' });
console.log(`TOKEN ${token}`);
process.on('SIGTERM', async () => { await smtp.close(); await worker.end(); await ctx.close(); process.exit(0); });
