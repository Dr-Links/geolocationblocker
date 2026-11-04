import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import S3rver from 's3rver';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, type Db } from '../src/lib/db.js';
import { runSyncPass } from '../src/sync/runner.js';
import { storageHousekeeping } from '../src/storage/housekeeping.js';
import { S3BlobStore, signV4 } from '../src/storage/s3.js';
import type { DiscoveryDeps } from '../src/mail/discovery.js';
import { adminLogin, bearer, createAdmin, login, makeCtx, registerVerified, resetData, type Ctx } from './helpers.js';
import { MAIL_DIR, MAIL_PASSWORD, startSmtp } from './mailserver/smtp.js';

const noDiscovery: DiscoveryDeps = { resolveMx: async () => [], resolveSrv: async () => [], fetchText: async () => null };
const manual = (user: string) => ({
  imap: { host: 'localhost', port: 19993, security: 'tls', username: user },
  smtp: { host: 'localhost', port: 19465, security: 'tls', username: user },
});

async function onServer<T>(user: string, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const c = new ImapFlow({ host: '127.0.0.1', port: 19993, secure: true, auth: { user, pass: MAIL_PASSWORD }, logger: false,
    tls: { ca: readFileSync(`${MAIL_DIR}/ca.pem`), servername: 'localhost' } });
  c.on('error', () => undefined);
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.logout();
  }
}
const clear = (user: string) => onServer(user, async (c) => {
  for (const f of await c.list()) {
    const lock = await c.getMailboxLock(f.path);
    try {
      if (c.mailbox && c.mailbox.exists) await c.messageDelete('1:*');
    } finally {
      lock.release();
    }
  }
});
const deliver = (user: string, subject: string, opts: { daysAgo?: number; body?: string; attachment?: Buffer } = {}) => onServer(user, async (c) => {
  const date = new Date(Date.now() - (opts.daysAgo ?? 0) * 86_400_000);
  const head = `From: Sender <sender@example.org>\r\nTo: ${user}\r\nSubject: ${subject}\r\nMessage-ID: <${randomUUID()}@example.org>\r\nDate: ${date.toUTCString()}\r\nMIME-Version: 1.0\r\n`;
  const text = opts.body ?? `Body of ${subject}`;
  const raw = opts.attachment
    ? `${head}Content-Type: multipart/mixed; boundary=b1\r\n\r\n--b1\r\nContent-Type: text/plain\r\n\r\n${text}\r\n--b1\r\nContent-Type: application/pdf\r\n` +
      `Content-Disposition: attachment; filename=report.pdf\r\nContent-Transfer-Encoding: base64\r\n\r\n${opts.attachment.toString('base64')}\r\n--b1--\r\n`
    : `${head}Content-Type: text/plain\r\n\r\n${text}\r\n`;
  await c.append('INBOX', raw, [], date);
});

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
const housekeeping = () => storageHousekeeping(ctx.cfg, worker, () => undefined);
const storage = async () => (await api('GET', '/v1/storage')).json().storage;
const inbox = async () => (await api('GET', '/v1/messages?view=inbox')).json().messages as Array<{ id: string; subject: string }>;
const bodyState = async (subject: string) =>
  (await ctx.owner.query(`SELECT body_state FROM app.messages WHERE subject = $1`, [subject])).rows[0]?.body_state;
const setQuota = (bytes: number) => ctx.owner.query(`UPDATE app.users SET storage_quota_bytes = $2 WHERE id = $1`, [userId, bytes]);

beforeAll(async () => {
  ctx = await makeCtx({ env: { MAIL_EXTRA_CA_FILE: `${MAIL_DIR}/ca.pem` }, discovery: noDiscovery });
  worker = createPool(ctx.cfg, 'worker');
  smtp = await startSmtp(() => ({ 'alice@test.local': MAIL_PASSWORD, 'bob@test.local': MAIL_PASSWORD }));
});
afterAll(async () => {
  await smtp.close();
  await worker.end();
  await ctx.close();
});
beforeEach(async () => {
  await resetData(ctx);
  await clear('alice@test.local');
  await clear('bob@test.local');
  userId = await registerVerified(ctx, 'storage.user@gmail.com');
  await ctx.owner.query(`UPDATE app.users SET status = 'approved', access_expires_at = now() + interval '1 month' WHERE id = $1`, [userId]);
  token = (await login(ctx, 'storage.user@gmail.com')).body.accessToken;
  mailboxId = (await api('POST', '/v1/mailboxes', { email: 'alice@test.local', password: MAIL_PASSWORD, manual: manual('alice@test.local') })).json().mailbox.id;
});

describe('storage accounting and quota', () => {
  it('counts what is stored and shows it to the user', async () => {
    await deliver('alice@test.local', 'One', { body: 'x'.repeat(5000) });
    await deliver('alice@test.local', 'Two');
    await sync();
    const s = await storage();
    expect(s.messageCount).toBe(2);
    expect(s.bodyBytes).toBeGreaterThan(5000);
    expect(s.usedBytes).toBe(s.bodyBytes + s.fileBytes + 2 * 2048);
    expect(s.state).toBe('ok');
    expect(s.mailboxes).toEqual([expect.objectContaining({ email: 'alice@test.local', messages: 2 })]);

    // The admin sees usage figures (never content).
    const { secret } = await createAdmin(ctx);
    const admin = await adminLogin(ctx, secret);
    const dash = (await admin.get('/admin/api/dashboard')).json();
    expect(dash.storage).toMatchObject({ totalUsedBytes: s.usedBytes, warning: 0, full: 0 });
    const detail = (await admin.get(`/admin/api/users/${userId}`)).json();
    expect(detail.user).toMatchObject({ storageUsedBytes: s.usedBytes, storageState: 'ok', storedMessages: 2 });
  });

  it('when full: keeps syncing headers, stores no new text, shows it live, refuses uploads, and warns once', async () => {
    expect((await api('PUT', '/v1/devices/current/push', { token: 'ExponentPushToken[storage-phone]' })).statusCode).toBe(200);
    await deliver('alice@test.local', 'Before');
    await sync();
    await setQuota(1000); // one message's metadata already counts 2 KB
    await deliver('alice@test.local', 'While full', { body: 'secret words in the body' });
    await sync();
    expect(await bodyState('While full')).toBe('skipped_quota');
    expect((await storage()).state).toBe('full');
    const msg = (await inbox()).find((m) => m.subject === 'While full')!;
    const opened = (await api('GET', `/v1/messages/${msg.id}`)).json().message;
    expect(opened.body.text).toContain('secret words');
    expect(await bodyState('While full')).toBe('skipped_quota'); // shown, not kept
    const up = await ctx.api.inject({ method: 'PUT', url: '/v1/uploads?filename=a.txt', headers: { ...bearer(token), 'content-type': 'application/octet-stream' }, payload: Buffer.from('hello') });
    expect(up.statusCode).toBe(413);
    expect(up.json().error.code).toBe('limit_reached');

    const first = await housekeeping();
    expect(first.warned).toBe(1);
    expect((await housekeeping()).warned).toBe(0);
    const { rows } = await ctx.owner.query(`SELECT title FROM app.notification_outbox WHERE user_id = $1 AND kind = 'account'`, [userId]);
    for (const r of rows) expect(r.title).toMatch(/storage is full/);

    // More space: the next sync stores text again, and the message opens and is kept.
    await setQuota(10 * 1024 ** 3);
    await api('GET', `/v1/messages/${msg.id}`);
    expect(await bodyState('While full')).toBe('stored');
  });
});

describe('retention and eviction', () => {
  it('does not store text older than the retention setting, and evicts it later; it is fetched again when opened', async () => {
    await deliver('alice@test.local', 'Recent');
    await deliver('alice@test.local', 'Old one', { daysAgo: 20 });
    expect((await api('PUT', '/v1/storage/settings', { bodyRetentionDays: 7 })).statusCode).toBe(200);
    await sync();
    expect(await bodyState('Old one')).toBe('headers_only');
    expect(await bodyState('Recent')).toBe('stored');

    // A message stored before the setting was made shorter is evicted by housekeeping.
    await ctx.owner.query(`UPDATE app.messages SET received_at = now() - interval '30 days' WHERE subject = 'Recent'`);
    const h = await housekeeping();
    expect(h.evictedBodies).toBe(1);
    expect(await bodyState('Recent')).toBe('evicted');
    const before = (await storage()).bodyBytes;
    expect(before).toBe(0);
    const msg = (await inbox()).find((m) => m.subject === 'Recent')!;
    expect((await api('GET', `/v1/messages/${msg.id}`)).json().message.body.text).toContain('Body of Recent');
  });

  it('under quota pressure evicts the oldest re-fetchable text, never copies that exist only here', async () => {
    for (let i = 0; i < 6; i++) await deliver('alice@test.local', `Big ${i}`, { daysAgo: 6 - i, body: 'y'.repeat(20_000) });
    await sync();
    // "Big 0" disappears from the server: its copy here is the only one and must survive.
    await onServer('alice@test.local', async (c) => {
      const lock = await c.getMailboxLock('INBOX');
      try {
        const uids = await c.search({ subject: 'Big 0' }, { uid: true });
        if (uids && uids.length) await c.messageDelete(uids.join(','), { uid: true });
      } finally {
        lock.release();
      }
    });
    await sync();
    const used = (await storage()).usedBytes;
    await setQuota(Math.floor(used / 0.97)); // 97 % used
    const h = await housekeeping();
    expect(h.evictedBodies).toBeGreaterThan(0);
    expect(await bodyState('Big 0')).toBe('stored');
    expect(await bodyState('Big 1')).toBe('evicted');   // oldest on the server goes first
    expect(await bodyState('Big 5')).toBe('stored');    // newest stays
    const s = await storage();
    expect(s.usedBytes).toBeLessThanOrEqual(s.quotaBytes * 0.86);
  });

  it('removes copies of messages deleted on the server only when the user confirms', async () => {
    await deliver('alice@test.local', 'Gone soon');
    await sync();
    await clear('alice@test.local');
    await sync();
    expect((await api('POST', '/v1/storage/remove-deleted-on-server', {})).statusCode).toBe(400);
    const r = (await api('POST', '/v1/storage/remove-deleted-on-server', { confirm: true })).json();
    expect(r.removed).toBe(1);
    expect(r.storage.messageCount).toBe(0);
  });
});

describe('files: cleanup and mailbox purge', () => {
  it('deletes files nothing refers to, including the stored object', async () => {
    const up = (await ctx.api.inject({ method: 'PUT', url: '/v1/uploads?filename=note.txt', headers: { ...bearer(token), 'content-type': 'application/octet-stream' },
      payload: Buffer.from('a file that will be thrown away') })).json().upload;
    const { rows } = await ctx.owner.query(`SELECT b.id, b.storage_key FROM app.uploads u JOIN app.blobs b ON b.id = u.blob_id WHERE u.id = $1`, [up.id]);
    const file = join(ctx.cfg.blobDir, rows[0].storage_key);
    expect(existsSync(file)).toBe(true);
    expect((await storage()).fileBytes).toBeGreaterThan(0);
    expect((await api('DELETE', `/v1/uploads/${up.id}`)).statusCode).toBe(204);
    expect((await housekeeping()).blobsDeleted).toBe(0); // too new: it could be about to be attached again
    await ctx.owner.query(`UPDATE app.blobs SET created_at = now() - interval '2 hours'`);
    const h = await housekeeping();
    expect(h).toMatchObject({ blobsDeleted: 1, objectsDeleted: 1 });
    expect(existsSync(file)).toBe(false);
    expect((await storage()).fileBytes).toBe(0);
  });

  it('deleting one mailbox removes its mail and files and leaves the other mailbox intact', async () => {
    const bobId = (await api('POST', '/v1/mailboxes', { email: 'bob@test.local', password: MAIL_PASSWORD, manual: manual('bob@test.local') })).json().mailbox.id;
    const pdf = Buffer.from('%PDF-1.4\nshared attachment\n%%EOF');
    await deliver('alice@test.local', 'Alice has a file', { attachment: pdf });
    await deliver('bob@test.local', 'Bob has the same file', { attachment: pdf });
    await deliver('bob@test.local', 'Bob plain');
    await sync();
    const open = async (subject: string) => {
      const { rows } = await ctx.owner.query(`SELECT m.id AS mid, a.id AS aid FROM app.messages m JOIN app.attachments a ON a.message_id = m.id WHERE m.subject = $1`, [subject]);
      return api('GET', `/v1/messages/${rows[0].mid}/attachments/${rows[0].aid}`);
    };
    const aliceFile = await open('Alice has a file');
    expect(aliceFile.statusCode).toBe(200);
    await open('Bob has the same file');
    // Identical content is stored once for this user.
    expect((await ctx.owner.query(`SELECT count(*)::int AS n FROM app.blobs WHERE user_id = $1`, [userId])).rows[0].n).toBe(1);

    expect((await api('POST', `/v1/mailboxes/${mailboxId}/disconnect`, { mode: 'delete', confirmEmail: 'alice@test.local' })).statusCode).toBe(200);
    await ctx.owner.query(`UPDATE app.blobs SET created_at = now() - interval '2 hours'`);
    await housekeeping();
    // Bob still refers to the shared file, so it stays; Bob's mail is untouched.
    expect((await ctx.owner.query(`SELECT count(*)::int AS n FROM app.blobs WHERE user_id = $1`, [userId])).rows[0].n).toBe(1);
    const s = await storage();
    expect(s.messageCount).toBe(2);
    expect(s.mailboxes.map((m: { email: string }) => m.email)).toEqual(['bob@test.local']);
    expect((await open('Bob has the same file')).body).toContain('shared attachment');

    expect((await api('POST', `/v1/mailboxes/${bobId}/disconnect`, { mode: 'delete', confirmEmail: 'bob@test.local' })).statusCode).toBe(200);
    await housekeeping();
    expect((await ctx.owner.query(`SELECT count(*)::int AS n FROM app.blobs WHERE user_id = $1`, [userId])).rows[0].n).toBe(0);
    expect(await storage()).toMatchObject({ messageCount: 0, bodyBytes: 0, fileBytes: 0 });
  });
});

describe('S3-compatible storage', () => {
  it('signs requests exactly like the AWS documentation example', () => {
    const auth = signV4({
      method: 'GET', url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      headers: { host: 'examplebucket.s3.amazonaws.com', range: 'bytes=0-9',
        'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'x-amz-date': '20130524T000000Z' },
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      date: new Date('2013-05-24T00:00:00Z'), region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    });
    expect(auth).toBe('AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
      'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  });

  it('signs uploads the same way as the official AWS SDK (botocore), path-style with a prefix', () => {
    const store = new S3BlobStore({ endpoint: 'https://files.example.net', region: 'auto', bucket: 'mail-files', prefix: 'prod',
      accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret/with+chars' });
    const r = store.build('PUT', 'u/11111111-2222-3333-4444-555555555555/66666666-7777-8888-9999-000000000000', Buffer.from('ciphertext bytes'),
      new Date('2026-01-02T03:04:05Z'));
    expect(r.url.href).toBe('https://files.example.net/mail-files/prod/u/11111111-2222-3333-4444-555555555555/66666666-7777-8888-9999-000000000000');
    expect(r.headers['x-amz-content-sha256']).toBe('4b5670f23b2c9f05852d19b56f58df39ff3a8a87ef81b1f1f8fd8ed3efdc6270');
    expect(r.headers.authorization).toBe('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260102/auto/s3/aws4_request, ' +
      'SignedHeaders=content-length;content-type;host;x-amz-content-sha256;x-amz-date, Signature=8016af3c8e04e27635b01c25b8dcf93dfe0866cca1b1d0d82e59b1a7cd02f6f9');
  });

  it('stores, reads and deletes objects on an S3-compatible server', async () => {
    const dir = mkdtempSync(join(tmpdir(), 's3rver-'));
    const server = new S3rver({ port: 19800, address: '127.0.0.1', directory: dir, silent: true, configureBuckets: [{ name: 'mail-files' }] });
    await server.run();
    try {
      const opts = { endpoint: 'http://127.0.0.1:19800', region: 'us-east-1', bucket: 'mail-files', accessKeyId: 'S3RVER', secretAccessKey: 'S3RVER', prefix: 'prod' };
      const store = new S3BlobStore(opts);
      const key = `u/${randomUUID()}/${randomUUID()}`;
      await store.put(key, Buffer.from('ciphertext bytes'));
      expect((await store.get(key)).toString()).toBe('ciphertext bytes');
      await store.delete(key);
      await expect(store.get(key)).rejects.toThrow(/HTTP 404/);
      await store.delete(key); // deleting twice is fine
      await expect(store.get('../../etc/passwd')).rejects.toThrow(/invalid blob key/);
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
