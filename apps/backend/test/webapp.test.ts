import { createECDH, createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import ece from 'http_ece';
import webpush from 'web-push';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EDITOR_SCRIPT, FRAME_BRIDGE_SCRIPT, FRAME_SCRIPT_HASHES, MAIL_LINK_SCRIPT } from '@app/shared';
import { createPool, type Db } from '../src/lib/db.js';
import { dispatchNotifications } from '../src/push/notify.js';
import { PASSWORD, makeCtx, registerVerified, resetData, type Ctx } from './helpers.js';

const WEB_DIR = '/var/tmp/emailplatform-test-web';
const vapid = webpush.generateVAPIDKeys();

// A browser-side push subscription: we keep its private key to decrypt what the server sends.
const ua = createECDH('prime256v1');
ua.generateKeys();
const authSecret = randomBytes(16);
const b64u = (b: Buffer) => b.toString('base64url');
const subscription = { endpoint: 'http://127.0.0.1:19702/push/abc', keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(authSecret) } };

let pushServer: Server;
const received: Array<{ headers: Record<string, unknown>; body: Buffer }> = [];
let ctx: Ctx;
let worker: Db;

const cookieOf = (setCookie: string | string[] | undefined) => {
  const v = (Array.isArray(setCookie) ? setCookie : [setCookie ?? '']).find((c) => c.startsWith('awm_rt='));
  return v ?? null;
};

beforeAll(async () => {
  rmSync(WEB_DIR, { recursive: true, force: true });
  mkdirSync(`${WEB_DIR}/_expo/static/js/web`, { recursive: true });
  writeFileSync(`${WEB_DIR}/index.html`, '<!doctype html><title>AllWebMails</title><div id="root"></div>');
  writeFileSync(`${WEB_DIR}/sw.js`, 'self.addEventListener("fetch",()=>{});');
  writeFileSync(`${WEB_DIR}/_expo/static/js/web/entry-abc.js`, 'console.log(1)');
  pushServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { received.push({ headers: req.headers, body: Buffer.concat(chunks) }); res.statusCode = req.url?.includes('gone') ? 410 : 201; res.end(); });
  });
  await new Promise<void>((r) => pushServer.listen(19702, '127.0.0.1', r));
  ctx = await makeCtx({ env: {
    WEB_APP_DIR: WEB_DIR, WEB_PUSH_PUBLIC_KEY: vapid.publicKey, WEB_PUSH_PRIVATE_KEY: vapid.privateKey,
    WEB_PUSH_ALLOWED_HOSTS: '127.0.0.1', PUSH_PROVIDER: 'none',
  } });
  worker = createPool(ctx.cfg, 'worker');
});
afterAll(async () => {
  await worker.end();
  await ctx.close();
  await new Promise<void>((r) => pushServer.close(() => r()));
});
beforeEach(async () => {
  await resetData(ctx);
  received.length = 0;
});

async function webLogin(email: string) {
  const id = await registerVerified(ctx, email);
  await ctx.owner.query(`UPDATE app.users SET status = 'approved', access_expires_at = now() + interval '1 month' WHERE id = $1`, [id]);
  const r = await ctx.api.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: PASSWORD, device: { platform: 'web', name: 'Chrome on Windows (web app)' } } });
  return { id, r };
}

describe('web app sessions', () => {
  it('keeps the refresh token in an HttpOnly cookie, never in page-readable responses', async () => {
    const { r } = await webLogin('webuser@gmail.com');
    expect(r.statusCode).toBe(200);
    expect(r.json().refreshToken).toBeNull();
    const cookie = cookieOf(r.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\/v1\/auth/);
    const value = cookie!.split(';')[0]!;

    // Without the app's header (e.g. a form posted from another site) the cookie is not accepted.
    expect((await ctx.api.inject({ method: 'POST', url: '/v1/auth/refresh', headers: { cookie: value }, payload: {} })).statusCode).toBe(403);
    const ok = await ctx.api.inject({ method: 'POST', url: '/v1/auth/refresh', headers: { cookie: value, 'x-requested-with': 'awm' }, payload: {} });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().refreshToken).toBeNull();
    const rotated = cookieOf(ok.headers['set-cookie'])!.split(';')[0]!;
    expect(rotated).not.toBe(value);
    // The old cookie is now a replayed token: the whole session is ended.
    expect((await ctx.api.inject({ method: 'POST', url: '/v1/auth/refresh', headers: { cookie: value, 'x-requested-with': 'awm' }, payload: {} })).statusCode).toBe(401);
    expect((await ctx.api.inject({ method: 'POST', url: '/v1/auth/refresh', headers: { cookie: rotated, 'x-requested-with': 'awm' }, payload: {} })).statusCode).toBe(401);
  });

  it('signing out clears the cookie', async () => {
    const { r } = await webLogin('webuser2@gmail.com');
    const out = await ctx.api.inject({ method: 'POST', url: '/v1/auth/logout', headers: { authorization: `Bearer ${r.json().accessToken}` } });
    expect(out.statusCode).toBe(204);
    expect(cookieOf(out.headers['set-cookie'])).toMatch(/awm_rt=;|Expires=Thu, 01 Jan 1970/);
  });
});

describe('web app hosting', () => {
  it('serves the app with a strict security policy and lets the app handle its own routes', async () => {
    const page = await ctx.api.inject({ method: 'GET', url: '/' });
    expect(page.statusCode).toBe(200);
    const csp = String(page.headers['content-security-policy']);
    expect(csp).toContain("script-src 'self' 'sha256-");
    expect(csp.split('; ').find((d) => d.startsWith('script-src'))).not.toContain('unsafe');
    expect(csp).toContain("frame-ancestors 'none'");
    expect(page.headers['cache-control']).toBe('no-cache');
    const deep = await ctx.api.inject({ method: 'GET', url: '/message/0b1c' });
    expect(deep.statusCode).toBe(200);
    expect(deep.body).toContain('<div id="root">');
    const asset = await ctx.api.inject({ method: 'GET', url: '/_expo/static/js/web/entry-abc.js' });
    expect(asset.headers['cache-control']).toContain('immutable');
    expect((await ctx.api.inject({ method: 'GET', url: '/sw.js' })).headers['service-worker-allowed']).toBe('/');
    const api404 = await ctx.api.inject({ method: 'GET', url: '/v1/nothing-here' });
    expect(api404.statusCode).toBe(404);
    expect(api404.json().error.code).toBe('not_found');
    expect((await ctx.api.inject({ method: 'GET', url: '/v1/config' })).json().webPushPublicKey).toBe(vapid.publicKey);
  });

  it('allows exactly the frame scripts in the app by hash', () => {
    const h = (s: string) => `sha256-${createHash('sha256').update(s).digest('base64')}`;
    expect(FRAME_SCRIPT_HASHES).toEqual({ editor: h(EDITOR_SCRIPT), bridge: h(FRAME_BRIDGE_SCRIPT), mailLink: h(MAIL_LINK_SCRIPT) });
  });
});

describe('browser push (Web Push)', () => {
  it('sends an encrypted notification only the subscribed browser can read, and drops dead subscriptions', async () => {
    const { r } = await webLogin('pushweb@gmail.com');
    const token = r.json().accessToken as string;
    const put = (sub: object) => ctx.api.inject({ method: 'PUT', url: '/v1/devices/current/push', headers: { authorization: `Bearer ${token}` },
      payload: { provider: 'webpush', token: JSON.stringify(sub) } });
    expect((await put({ ...subscription, endpoint: 'https://evil.example/collect' })).statusCode).toBe(400); // only known push services
    expect((await put(subscription)).statusCode).toBe(200);

    const { rows } = await ctx.owner.query(`SELECT id, user_id FROM app.devices WHERE push_provider = 'webpush'`);
    await ctx.owner.query(`INSERT INTO app.notification_outbox (user_id, device_id, kind, dedupe_key, title, data) VALUES ($1, $2, 'new_mail', 'k1', 'New email received at sales@company.example', '{"type":"new_mail"}')`,
      [rows[0].user_id, rows[0].id]);
    const d1 = await dispatchNotifications(ctx.cfg, worker, () => undefined);
    const dbg = (await ctx.owner.query(`SELECT o.status, o.last_error, d.push_enabled, d.revoked_at, d.push_provider FROM app.notification_outbox o JOIN app.devices d ON d.id = o.device_id`)).rows;
    expect(d1, JSON.stringify(dbg)).toMatchObject({ sent: 1 });
    expect(received).toHaveLength(1);
    expect(String(received[0]!.headers.authorization)).toMatch(/^vapid t=/);
    expect(received[0]!.headers['content-encoding']).toBe('aes128gcm');
    expect(received[0]!.body.includes(Buffer.from('sales@company'))).toBe(false); // encrypted in transit
    const plain = ece.decrypt(received[0]!.body, { version: 'aes128gcm', privateKey: ua, authSecret: b64u(authSecret) });
    expect(JSON.parse(plain.toString())).toMatchObject({ title: 'New email received at sales@company.example', data: { type: 'new_mail' } });

    // The browser unsubscribed: the push service answers 410 and the subscription is switched off.
    await ctx.owner.query(`UPDATE app.devices SET push_token = $1 WHERE id = $2`, [JSON.stringify({ ...subscription, endpoint: 'http://127.0.0.1:19702/push/gone' }), rows[0].id]);
    await ctx.owner.query(`INSERT INTO app.notification_outbox (user_id, device_id, kind, dedupe_key, title) VALUES ($1, $2, 'new_mail', 'k2', 'x')`, [rows[0].user_id, rows[0].id]);
    await dispatchNotifications(ctx.cfg, worker, () => undefined);
    expect((await ctx.owner.query(`SELECT push_token, push_enabled FROM app.devices WHERE id = $1`, [rows[0].id])).rows[0]).toEqual({ push_token: null, push_enabled: false });
  });
});
