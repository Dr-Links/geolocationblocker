import { createServer, type Server } from 'node:net';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, type Db } from '../src/lib/db.js';
import { runSyncPass } from '../src/sync/runner.js';
import { fireReminders } from '../src/scheduler.js';
import type { DiscoveryDeps } from '../src/mail/discovery.js';
import { adminLogin, bearer, createAdmin, login, makeCtx, registerVerified, resetData, type Ctx } from './helpers.js';
import { MAIL_DIR, MAIL_PASSWORD, startSmtp } from './mailserver/smtp.js';

const noDiscovery: DiscoveryDeps = { resolveMx: async () => [], resolveSrv: async () => [], fetchText: async () => null };
const MANUAL = {
  imap: { host: 'localhost', port: 19993, security: 'tls', username: 'alice@test.local' },
  smtp: { host: 'localhost', port: 19465, security: 'tls', username: 'alice@test.local' },
};

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
interface Mail { from: string; subject: string; html?: string; messageId?: string; inReplyTo?: string; replyTo?: string; attachment?: Buffer; auth?: string }
const deliver = (m: Mail) => onServer(async (c) => {
  const id = m.messageId ?? `<${randomUUID()}@example.org>`;
  let head = `From: ${m.from}\r\nTo: alice@test.local\r\nSubject: ${m.subject}\r\nMessage-ID: ${id}\r\nDate: ${new Date().toUTCString()}\r\nMIME-Version: 1.0\r\n`;
  if (m.inReplyTo) head += `In-Reply-To: ${m.inReplyTo}\r\nReferences: ${m.inReplyTo}\r\n`;
  if (m.replyTo) head += `Reply-To: ${m.replyTo}\r\n`;
  if (m.auth) head += `Authentication-Results: mx.test.local; ${m.auth}\r\n`;
  const body = m.html ? `Content-Type: text/html\r\n\r\n${m.html}\r\n` : `Content-Type: text/plain\r\n\r\nHello\r\n`;
  const raw = m.attachment
    ? `${head}Content-Type: multipart/mixed; boundary=b1\r\n\r\n--b1\r\n${body}--b1\r\nContent-Type: application/octet-stream\r\n` +
      `Content-Disposition: attachment; filename=data.bin\r\nContent-Transfer-Encoding: base64\r\n\r\n${m.attachment.toString('base64')}\r\n--b1--\r\n`
    : head + body;
  await c.append('INBOX', raw);
  return id;
});
const subjectsIn = (folder: string) => onServer(async (c) => {
  const lock = await c.getMailboxLock(folder);
  try {
    const out: string[] = [];
    if (c.mailbox && c.mailbox.exists) for await (const m of c.fetch('1:*', { envelope: true })) out.push(m.envelope?.subject ?? '');
    return out;
  } finally {
    lock.release();
  }
});

// Minimal clamd: anything containing "EICAR" is reported as infected.
let clamd: Server;
let ctx: Ctx;
let worker: Db;
let smtp: Awaited<ReturnType<typeof startSmtp>>;
let token: string;
let userId: string;
let mailboxId: string;
const api = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) => ctx.api.inject({ method, url, headers: bearer(token), payload });
const sync = async () => {
  await ctx.owner.query(`UPDATE app.mailboxes SET next_sync_at = now(), sync_lease_until = NULL`);
  return runSyncPass(ctx.cfg, worker, { budgetMs: 20_000, log: () => undefined });
};
const bySubject = async (subject: string) => {
  const { rows } = await ctx.owner.query(`SELECT id FROM app.messages WHERE subject = $1`, [subject]);
  return (await api('GET', `/v1/messages/${rows[0].id}`)).json().message;
};

beforeAll(async () => {
  clamd = createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= 14 && buf.subarray(buf.length - 4).readUInt32BE() === 0) {
        sock.end(buf.includes('EICAR') ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
      }
    });
  });
  await new Promise<void>((r) => clamd.listen(19810, '127.0.0.1', r));
  ctx = await makeCtx({ env: { MAIL_EXTRA_CA_FILE: `${MAIL_DIR}/ca.pem`, CLAMAV_HOST: '127.0.0.1', CLAMAV_PORT: '19810' }, discovery: noDiscovery });
  worker = createPool(ctx.cfg, 'worker');
  smtp = await startSmtp(() => ({ 'alice@test.local': MAIL_PASSWORD }));
});
afterAll(async () => {
  await smtp.close();
  await worker.end();
  await ctx.close();
  await new Promise<void>((r) => clamd.close(() => r()));
});
beforeEach(async () => {
  await resetData(ctx);
  await ctx.owner.query(`TRUNCATE app.platform_blocklist`);
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
  userId = await registerVerified(ctx, 'secure.user@gmail.com');
  await ctx.owner.query(`UPDATE app.users SET status = 'approved', access_expires_at = now() + interval '1 month' WHERE id = $1`, [userId]);
  token = (await login(ctx, 'secure.user@gmail.com')).body.accessToken;
  mailboxId = (await api('POST', '/v1/mailboxes', { email: 'alice@test.local', password: MAIL_PASSWORD, manual: MANUAL })).json().mailbox.id;
  await api('PUT', '/v1/devices/current/push', { token: 'ExponentPushToken[sec-phone]' });
  await sync(); // initial sync (empty)
});

describe('phishing warnings', () => {
  it('warns about spoofed senders and deceptive links, and leaves ordinary mail alone', async () => {
    await deliver({ from: '"support@paypal.com" <alerts@paypa1-billing.example>', subject: 'Your account is locked',
      html: '<p>Verify now: <a href="https://login.paypa1.com/x">https://www.paypal.com/verify</a></p>', auth: 'spf=fail; dkim=none; dmarc=fail' });
    await deliver({ from: 'Shop <news@shop.example>', subject: 'Weekly offers', html: '<a href="https://shop.example/offers">See offers</a>' });
    await sync();
    const bad = await bySubject('Your account is locked');
    expect(bad.security).toBe('danger');
    expect(bad.securityReasons.map((r: { code: string }) => r.code)).toEqual(expect.arrayContaining(['dmarc_fail', 'display_name_spoof', 'link_mismatch', 'lookalike_link']));
    const ok = await bySubject('Weekly offers');
    expect(ok.security).toBe('none');
    // The list shows it too.
    const list = (await api('GET', '/v1/messages?view=inbox')).json().messages;
    expect(list.find((m: { subject: string }) => m.subject === 'Your account is locked').security).toBe('danger');
  });
});

describe('block lists', () => {
  it('blocking a sender moves that message and future ones to Junk, without notifications', async () => {
    await deliver({ from: 'Pest <pest@spammy.example>', subject: 'Buy now 1' });
    await sync();
    const first = await bySubject('Buy now 1');
    const r = (await api('POST', '/v1/blocked-senders', { messageId: first.id, scope: 'domain' })).json();
    expect(r).toEqual({ pattern: '@spammy.example', movedToJunk: true });
    await sync();
    expect(await subjectsIn('Junk')).toEqual(['Buy now 1']);

    await ctx.owner.query(`DELETE FROM app.notification_outbox`);
    await deliver({ from: 'Other <other@spammy.example>', subject: 'Buy now 2' });
    await sync();
    expect((await subjectsIn('Junk')).sort()).toEqual(['Buy now 1', 'Buy now 2']);
    expect(await subjectsIn('INBOX')).toEqual([]);
    expect((await ctx.owner.query(`SELECT count(*)::int AS n FROM app.notification_outbox WHERE kind = 'new_mail'`)).rows[0].n).toBe(0);
    expect((await bySubject('Buy now 2')).securityReasons).toEqual(expect.arrayContaining([{ code: 'blocked_sender', detail: 'your block list' }]));

    expect((await api('GET', '/v1/blocked-senders')).json().blocked.map((b: { pattern: string }) => b.pattern)).toEqual(['@spammy.example']);
    expect((await api('POST', '/v1/blocked-senders', { pattern: 'alice@test.local' })).statusCode).toBe(400); // own mailbox
    expect((await api('DELETE', '/v1/blocked-senders?pattern=%40spammy.example')).statusCode).toBe(204);
  });

  it('the platform blocklist applies to every user', async () => {
    const { secret } = await createAdmin(ctx);
    const admin = await adminLogin(ctx, secret);
    const added = await admin.post('/admin/api/blocklist', { pattern: 'evil.example', reason: 'phishing campaign' });
    expect(added.statusCode, added.body).toBe(200);
    expect((await admin.get('/admin/api/blocklist')).json().blocklist[0]).toMatchObject({ pattern: '@evil.example', reason: 'phishing campaign' });
    await deliver({ from: 'x@evil.example', subject: 'Invoice overdue' });
    await deliver({ from: 'friend@good.example', subject: 'Lunch?' });
    await sync();
    expect(await subjectsIn('Junk')).toEqual(['Invoice overdue']);
    expect(await subjectsIn('INBOX')).toEqual(['Lunch?']);
    const health = (await admin.get('/admin/api/dashboard')).json().health;
    expect(health).toHaveProperty('outboundWaiting');
    expect(health).toHaveProperty('lastBackup');
  });
});

describe('follow-up reminders', () => {
  it('reminds with the mailbox address only, and skips when someone replied', async () => {
    const idA = await deliver({ from: 'client@customer.example', subject: 'Quote request' });
    await deliver({ from: 'boss@company.example', subject: 'Budget' });
    await sync();
    const quote = await bySubject('Quote request');
    const budget = await bySubject('Budget');
    const soon = new Date(Date.now() + 5 * 60_000).toISOString();
    expect((await api('PUT', `/v1/messages/${quote.id}/reminder`, { remindAt: soon, onlyIfNoReply: true })).statusCode).toBe(200);
    expect((await api('PUT', `/v1/messages/${budget.id}/reminder`, { remindAt: soon, note: 'ask about Q3' })).statusCode).toBe(200);
    expect((await api('PUT', `/v1/messages/${budget.id}/reminder`, { remindAt: new Date(Date.now() - 1000).toISOString() })).statusCode).toBe(400);
    expect((await api('GET', '/v1/reminders')).json().reminders).toHaveLength(2);

    // The client answers before the reminder is due.
    await deliver({ from: 'client@customer.example', subject: 'Re: Quote request', inReplyTo: idA });
    await sync();
    await ctx.owner.query(`UPDATE app.reminders SET remind_at = now() - interval '1 second'`);
    await ctx.owner.query(`DELETE FROM app.notification_outbox`);
    expect(await fireReminders(worker)).toBe(1);
    const { rows } = await ctx.owner.query(`SELECT title, data FROM app.notification_outbox WHERE kind = 'reminder'`);
    expect(rows).toEqual([{ title: 'Reminder: follow up on a message in alice@test.local', data: expect.objectContaining({ messageId: budget.id }) }]);
    expect(JSON.stringify(rows)).not.toMatch(/Budget|boss|Q3/);
    const states = (await api('GET', '/v1/reminders')).json().reminders.map((r: { status: string; message: { subject: string } }) => `${r.message.subject}:${r.status}`);
    expect(states.sort()).toEqual(['Budget:fired', 'Quote request:replied']);
    expect(await fireReminders(worker)).toBe(0);
  });
});

describe('virus scanning (ClamAV)', () => {
  const EICAR = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');
  it('refuses infected uploads and blocks infected attachments', async () => {
    const up = await ctx.api.inject({ method: 'PUT', url: '/v1/uploads?filename=report.txt', headers: { ...bearer(token), 'content-type': 'application/octet-stream' }, payload: EICAR });
    expect(up.statusCode).toBe(422);
    expect(up.json().error.code).toBe('malware_detected');
    const clean = await ctx.api.inject({ method: 'PUT', url: '/v1/uploads?filename=ok.txt', headers: { ...bearer(token), 'content-type': 'application/octet-stream' }, payload: Buffer.from('fine') });
    expect(clean.statusCode).toBe(201);

    await deliver({ from: 'someone@example.org', subject: 'Here is the file', attachment: EICAR });
    await sync();
    const msg = await bySubject('Here is the file');
    const att = msg.attachments[0];
    const dl = await api('GET', `/v1/messages/${msg.id}/attachments/${att.id}`);
    expect(dl.statusCode).toBe(422);
    const after = await bySubject('Here is the file');
    expect(after.attachments[0]).toMatchObject({ scan: 'infected', risk: 'dangerous' });
    expect(after.security).toBe('danger');
    expect(after.securityReasons.map((r: { code: string }) => r.code)).toContain('malware');
    // Remembered: not scanned again, still refused.
    expect((await api('GET', `/v1/messages/${msg.id}/attachments/${att.id}`)).statusCode).toBe(422);
  });
});
