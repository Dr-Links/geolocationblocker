import { importPKCS8, SignJWT } from 'jose';
import webpush from 'web-push';
import type { Config } from '../lib/config.js';

export interface PushMessage {
  token: string;
  title: string;
  body?: string | null;
  data: Record<string, unknown>;
  /** Notifications for the same mailbox replace each other on the phone instead of piling up. */
  group?: string;
}

export interface PushResult {
  ok: boolean;
  /** The push service says this token is no longer valid (app removed, signed out, token rotated). */
  disableToken: boolean;
  error?: string;
}

export interface PushProvider {
  send(messages: PushMessage[]): Promise<PushResult[]>;
}

/** Expo push service: the app's ExponentPushToken; no Firebase key is needed on this server. */
export class ExpoPushProvider implements PushProvider {
  constructor(private readonly url: string, private readonly accessToken?: string) {}
  async send(messages: PushMessage[]): Promise<PushResult[]> {
    const out: PushResult[] = [];
    for (let i = 0; i < messages.length; i += 100) {
      const batch = messages.slice(i, i + 100);
      const res = await fetch(this.url, {
        method: 'POST',
        headers: {
          accept: 'application/json', 'content-type': 'application/json',
          ...(this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {}),
        },
        body: JSON.stringify(batch.map((m) => ({
          to: m.token, title: m.title, body: m.body ?? undefined, data: m.data, sound: 'default', priority: 'high',
          channelId: 'mail', ...(m.group ? { collapseId: m.group } : {}),
        }))),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const text = (await res.text().catch(() => '')).slice(0, 200);
        out.push(...batch.map(() => ({ ok: false, disableToken: false, error: `HTTP ${res.status} ${text}` })));
        continue;
      }
      const body = (await res.json()) as { data?: Array<{ status: string; message?: string; details?: { error?: string } }> };
      batch.forEach((_m, j) => {
        const t = body.data?.[j];
        if (t?.status === 'ok') out.push({ ok: true, disableToken: false });
        else out.push({ ok: false, disableToken: t?.details?.error === 'DeviceNotRegistered', error: t?.message ?? 'unknown push error' });
      });
    }
    return out;
  }
}

interface ServiceAccount { project_id: string; client_email: string; private_key: string }

/** Firebase Cloud Messaging HTTP v1, for native FCM tokens. Needs a service-account key (FCM_SERVICE_ACCOUNT_FILE). */
export class FcmPushProvider implements PushProvider {
  private token: { value: string; expires: number } | null = null;
  private readonly sa: ServiceAccount;
  constructor(json: string, private readonly apiBase: string, private readonly tokenUrl: string) {
    this.sa = JSON.parse(json) as ServiceAccount;
  }
  private async accessToken(): Promise<string> {
    if (this.token && this.token.expires > Date.now() + 60_000) return this.token.value;
    const key = await importPKCS8(this.sa.private_key, 'RS256');
    const now = Math.floor(Date.now() / 1000);
    const assertion = await new SignJWT({ scope: 'https://www.googleapis.com/auth/firebase.messaging' })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(this.sa.client_email).setAudience(this.tokenUrl).setIssuedAt(now).setExpirationTime(now + 3600)
      .sign(key);
    const res = await fetch(this.tokenUrl, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`FCM token exchange failed: HTTP ${res.status}`);
    const j = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: j.access_token, expires: Date.now() + j.expires_in * 1000 };
    return j.access_token;
  }
  async send(messages: PushMessage[]): Promise<PushResult[]> {
    const token = await this.accessToken();
    return Promise.all(messages.map(async (m) => {
      const res = await fetch(`${this.apiBase}/v1/projects/${this.sa.project_id}/messages:send`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ message: {
          token: m.token,
          notification: { title: m.title, ...(m.body ? { body: m.body } : {}) },
          data: Object.fromEntries(Object.entries(m.data).map(([k, v]) => [k, String(v)])),
          android: { priority: 'high', notification: { channel_id: 'mail', ...(m.group ? { tag: m.group } : {}) } },
        } }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) return { ok: true, disableToken: false };
      const text = await res.text().catch(() => '');
      return { ok: false, disableToken: res.status === 404 || /UNREGISTERED|registration-token-not-registered/.test(text), error: `HTTP ${res.status}` };
    }));
  }
}

export interface WebPushSubscription { endpoint: string; keys: { p256dh: string; auth: string } }

/** Only push services of the major browsers are contacted (the endpoint comes from the browser, so it is checked). */
export function parseWebPushToken(token: string, allowedHosts: string[]): WebPushSubscription | null {
  try {
    const s = JSON.parse(token) as WebPushSubscription;
    const u = new URL(s.endpoint);
    const host = u.hostname.toLowerCase();
    const okHost = allowedHosts.some((h) => host === h || host.endsWith(`.${h}`));
    const okScheme = u.protocol === 'https:' || (u.protocol === 'http:' && (host === '127.0.0.1' || host === 'localhost')); // plain http: local tests only
    if (!okHost || !okScheme || !/^[A-Za-z0-9_-]{40,200}$/.test(s.keys?.p256dh ?? '') || !/^[A-Za-z0-9_-]{10,50}$/.test(s.keys?.auth ?? '')) return null;
    return { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } };
  } catch {
    return null;
  }
}

/** Web Push (RFC 8030/8291/8292) for the installed web app; the payload is end-to-end encrypted to the browser. */
export class WebPushProvider implements PushProvider {
  constructor(private readonly v: { publicKey: string; privateKey: string; subject: string }, private readonly allowedHosts: string[]) {}
  async send(messages: PushMessage[]): Promise<PushResult[]> {
    return Promise.all(messages.map(async (m): Promise<PushResult> => {
      const sub = parseWebPushToken(m.token, this.allowedHosts);
      if (!sub) return { ok: false, disableToken: true, error: 'invalid web push subscription' };
      try {
        // The library encrypts the payload and signs the VAPID header; the request itself is sent with fetch.
        const req = webpush.generateRequestDetails(sub, JSON.stringify({ title: m.title, body: m.body ?? undefined, data: m.data, tag: m.group }), {
          vapidDetails: this.v, TTL: 24 * 3600, urgency: 'high', ...(m.group ? { topic: m.group.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) } : {}),
        });
        const res = await fetch(req.endpoint, { method: 'POST', headers: req.headers as Record<string, string>, body: req.body ? new Uint8Array(req.body) : undefined,
          redirect: 'error', signal: AbortSignal.timeout(15_000) });
        await res.arrayBuffer().catch(() => undefined);
        if (res.ok) return { ok: true, disableToken: false };
        return { ok: false, disableToken: res.status === 404 || res.status === 410, error: `web push failed (HTTP ${res.status})` };
      } catch (err) {
        return { ok: false, disableToken: false, error: `web push failed: ${(err as Error).message}`.slice(0, 200) };
      }
    }));
  }
}

export function pushProvider(cfg: Config, provider: 'expo' | 'fcm' | 'webpush'): PushProvider | null {
  if (provider === 'webpush') return cfg.push.webPush ? new WebPushProvider(cfg.push.webPush, cfg.push.webPushAllowedHosts) : null;
  if (cfg.push.provider === 'none') return null;
  if (provider === 'fcm') return cfg.push.fcmServiceAccountJson ? new FcmPushProvider(cfg.push.fcmServiceAccountJson, cfg.push.fcmApiBase, cfg.push.fcmTokenUrl) : null;
  return new ExpoPushProvider(cfg.push.expoUrl, cfg.push.expoAccessToken);
}
