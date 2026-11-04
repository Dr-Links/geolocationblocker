import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, type Db } from '../src/lib/db.js';
import { dispatchNotifications } from '../src/push/notify.js';
import { runSendPass } from '../src/send/sender.js';
import { runSyncPass } from '../src/sync/runner.js';
import type { DiscoveryDeps } from '../src/mail/discovery.js';
import { adminLogin, bearer, createAdmin, login, makeCtx, registerVerified, resetData, totpCode, type Ctx } from './helpers.js';
import { MAIL_DIR, MAIL_PASSWORD, startSmtp } from './mailserver/smtp.js';

const noDiscovery: DiscoveryDeps = { resolveMx: async () => [], resolveSrv: async () => [], fetchText: async () => null };
const MANUAL = {
  imap: { host: 'localhost', port: 19993, security: 'tls', username: 'alice@test.local' },
  smtp: { host: 'localhost', port: 19465, security: 'tls', username: 'alice@test.local' },
};

interface PushReq { to: string; title: string; body?: string; data: Record<string, unknown> }
let pushServer: Server;
const pushed: PushReq[] = [];
const DEAD = 'ExponentPushToken[dead-device]';

async function onServer<T>(fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const c = new ImapFlow({ host: '127.0.0.1', port: 19993, secure: true, auth: { user: 'alice@test.local', pass: MAIL_PASSWORD }, logger: false,
    tls: { ca: readFileSync(`${MAIL_DIR}/ca.pem`), servername: 'localhost' } });
  c.on('error', () => undefined);
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.logout();
  }
}
const deliver = (n: number, prefix = 'm') => onServer(async (c) => {
  for (let i = 0; i < n; i++) {
    await c.append('INBOX', `From: Secret Sender <secret.sender@example.org>\r\nTo: alice@test.local\r\nSubject: Confidential subject ${prefix}${i}\r\n` +
      `Message-ID: <${prefix}${i}-${randomUUID()}@example.org>\r\nDate: ${new Date().toUTCString()}\r\n\r\nBody\r\n`);
  }
});

let ctx: Ctx;
let worker: Db;
let smtp: Awaited<ReturnType<typeof startSmtp>>;
let token: string;
let userId: string;
let mailboxId: string;

const api = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object, t = token) => ctx.api.inject({ method, url, headers: bearer(t), payload });
const sync = async () => {
  await ctx.owner.query(`UPDATE app.mailboxes SET next_sync_at = now(), sync_lease_until = NULL`);
  return runSyncPass(ctx.cfg, worker, { budgetMs: 20_000, log: () => undefined });
};
const dispatch = () => dispatchNotifications(ctx.cfg, worker, () => undefined);

beforeAll(async () => {
  pushServer = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const msgs = JSON.parse(body) as PushReq[];
      pushed.push(...msgs);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: msgs.map((m) => (m.to === DEAD
        ? { status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered' } } : { status: 'ok', id: randomUUID() })) }));
    });
  });
  await new Promise<void>((r) => pushServer.listen(19700, '127.0.0.1', r));
  ctx = await makeCtx({ env: { MAIL_EXTRA_CA_FILE: `${MAIL_DIR}/ca.pem`, PUSH_PROVIDER: 'expo', EXPO_PUSH_URL: 'http://127.0.0.1:19700/push' }, discovery: noDiscovery });
  worker = createPool(ctx.cfg, 'worker');
  smtp = await startSmtp(() => ({ 'alice@test.local': MAIL_PASSWORD }));
});
afterAll(async () => {
  await smtp.close();
  await worker.end();
  await ctx.close();
  await new Promise<void>((r) => pushServer.close(() => r()));
});
beforeEach(async () => {
  await resetData(ctx);
  pushed.length = 0;
  await onServer(async (c) => {
    for (const f of await c.list()) {
      const lock = await c.getMailboxLock(f.path);
      try {
        if (c.mailbox && c.mailbox.exists) await c.messageDelete('1:*');
      } finally {
        lock.release();
      }
    }
  });
  userId = await registerVerified(ctx, 'notified@gmail.com');
  await ctx.owner.query(`UPDATE app.users SET status = 'approved', access_expires_at = now() + interval '1 month' WHERE id = $1`, [userId]);
  token = (await login(ctx, 'notified@gmail.com')).body.accessToken;
  mailboxId = (await api('POST', '/v1/mailboxes', { email: 'alice@test.local', password: MAIL_PASSWORD, manual: MANUAL })).json().mailbox.id;
  expect((await api('PUT', '/v1/devices/current/push', { token: 'ExponentPushToken[phone-1]' })).statusCode).toBe(200);
  // The first (initial) sync of a mailbox never notifies.
  await deliver(2, 'old');
  await sync();
  await dispatch();
  expect(pushed).toEqual([]);
});

describe('push notifications', () => {
  it('announces each new email with the receiving address only, once', async () => {
    await deliver(2);
    await sync();
    await dispatch();
    expect(pushed.map((p) => p.title)).toEqual(['New email received at alice@test.local', 'New email received at alice@test.local']);
    expect(JSON.stringify(pushed)).not.toMatch(/Confidential|secret\.sender|Secret Sender/);
    expect(pushed[0]!.data).toMatchObject({ type: 'new_mail', mailboxId });
    // Another sync and dispatch: nothing new, nothing repeated.
    await sync();
    await dispatch();
    expect(pushed).toHaveLength(2);
  });

  it('collapses a burst into one notification and respects preferences', async () => {
    await deliver(6, 'burst');
    await sync();
    await dispatch();
    expect(pushed.map((p) => p.title)).toEqual(['6 new emails received at alice@test.local']);
    await api('PUT', '/v1/notification-preferences', { defaults: { newMail: true, sendProblems: true, mailboxProblems: true, reminders: true }, mailboxes: [{ mailboxId, newMail: false }] });
    await deliver(1, 'quiet');
    await sync();
    await dispatch();
    expect(pushed).toHaveLength(1);
  });

  it('stops notifying signed-out devices and switches off tokens the push service rejects', async () => {
    await api('PUT', '/v1/devices/current/push', { token: DEAD });
    await deliver(1, 'dead');
    await sync();
    expect(await dispatch()).toMatchObject({ failed: 1 });
    const { rows } = await ctx.owner.query(`SELECT push_token, push_enabled FROM app.devices WHERE user_id = $1`, [userId]);
    expect(rows[0]).toEqual({ push_token: null, push_enabled: false });

    await api('PUT', '/v1/devices/current/push', { token: 'ExponentPushToken[phone-2]' });
    await ctx.api.inject({ method: 'POST', url: '/v1/auth/logout', headers: bearer(token) });
    await deliver(1, 'after-logout');
    await sync();
    pushed.length = 0;
    await dispatch();
    expect(pushed).toEqual([]);
  });

  it('a phone used for another account stops getting the first account\'s notifications', async () => {
    const other = await registerVerified(ctx, 'second.account@gmail.com');
    await ctx.owner.query(`UPDATE app.users SET status = 'approved', access_expires_at = now() + interval '1 month' WHERE id = $1`, [other]);
    const t2 = (await login(ctx, 'second.account@gmail.com')).body.accessToken;
    await api('PUT', '/v1/devices/current/push', { token: 'ExponentPushToken[phone-1]' }, t2);
    const { rows } = await ctx.owner.query(`SELECT user_id FROM app.devices WHERE push_token = 'ExponentPushToken[phone-1]'`);
    expect(rows).toEqual([{ user_id: other }]);
    expect((await api('PUT', '/v1/devices/current/push', { token: 'not-a-token' })).statusCode).toBe(400);
  });

  it('notifies when a message cannot be sent', async () => {
    await api('POST', '/v1/outbound', { mailboxId, idempotencyKey: randomUUID(), to: ['permfail@example.org'], subject: 'x', text: 'y' });
    await ctx.owner.query(`UPDATE app.outbound_messages SET release_at = now() - interval '1 second'`);
    await runSendPass(ctx.cfg, worker, 20_000, () => undefined);
    await dispatch();
    expect(pushed.map((p) => p.title)).toEqual(['A message from alice@test.local could not be sent']);
  });
});

describe('multi-device change feed', () => {
  it('tells other devices what changed, in order, per user only', async () => {
    const first = (await api('GET', '/v1/sync/changes?since=0')).json();
    expect(first.resetRequired).toBe(true);
    const cursor = first.cursor;
    const msg = (await api('GET', '/v1/messages?view=inbox')).json().messages[0];
    await api('POST', `/v1/messages/${msg.id}/actions`, { action: 'flag' });
    const draft = (await api('POST', '/v1/drafts', { mailboxId, subject: 'From the tablet', text: 'x' })).json().draft;
    const ch = (await api('GET', `/v1/sync/changes?since=${cursor}`)).json();
    expect(ch.resetRequired).toBe(false);
    const ids = ch.changes.map((c: { entity: string; id: string }) => `${c.entity}:${c.id}`);
    expect(ids).toEqual(expect.arrayContaining([`message:${msg.id}`, `draft:${draft.id}`]));
    expect(ch.cursor).toBeGreaterThan(cursor);
    const batch = (await api('GET', `/v1/messages/batch?ids=${msg.id}`)).json().messages;
    expect(batch[0]).toMatchObject({ id: msg.id, isFlagged: true });
    // Nothing new after the cursor.
    expect((await api('GET', `/v1/sync/changes?since=${ch.cursor}`)).json().changes).toEqual([]);
    // Another user sees none of it.
    const other = await registerVerified(ctx, 'feed.other@gmail.com');
    await ctx.owner.query(`UPDATE app.users SET status = 'approved', access_expires_at = now() + interval '1 month' WHERE id = $1`, [other]);
    const t2 = (await login(ctx, 'feed.other@gmail.com')).body.accessToken;
    expect((await api('GET', `/v1/sync/changes?since=1`, undefined, t2)).json().changes).toEqual([]);
  });

  it('deleting a user with mail still works (the change feed never blocks it)', async () => {
    const { secret } = await createAdmin(ctx);
    const admin = await adminLogin(ctx, secret);
    const r = await admin.post(`/admin/api/users/${userId}/delete`, { confirmEmail: 'notified@gmail.com', code: totpCode(secret, 1) });
    expect(r.statusCode).toBe(200);
    const { rows } = await ctx.owner.query(`SELECT count(*)::int AS n FROM app.messages WHERE user_id = $1`, [userId]);
    expect(rows[0].n).toBe(0);
  });
});
