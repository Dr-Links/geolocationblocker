import { createHash, createHmac } from 'node:crypto';
import type { BlobStore } from './blobs.js';

export interface S3Options {
  endpoint: string;          // e.g. https://s3.eu-central-1.amazonaws.com or https://<account>.r2.cloudflarestorage.com
  region: string;            // e.g. eu-central-1; "auto" for Cloudflare R2
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix?: string;           // optional folder inside the bucket
  pathStyle?: boolean;       // https://endpoint/bucket/key (default) instead of https://bucket.endpoint/key
  timeoutMs?: number;
}

const sha256hex = (d: string | Buffer) => createHash('sha256').update(d).digest('hex');
const hmac = (k: Buffer | string, d: string) => createHmac('sha256', k).update(d).digest();
// RFC 3986 encoding as S3 expects it; '/' kept in paths.
const enc = (s: string, keepSlash: boolean) => {
  const e = encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return keepSlash ? e.replace(/%2F/g, '/') : e;
};

export interface SignInput {
  method: string;
  url: URL;
  headers: Record<string, string>;   // must include host; names lower-case
  payloadHash: string;
  date: Date;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** AWS Signature Version 4 for S3. Returns the Authorization header value. */
export function signV4(i: SignInput): string {
  const amzDate = i.date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const names = Object.keys(i.headers).map((h) => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(i.headers).map(([k, v]) => [k.toLowerCase(), v]));
  const canonicalHeaders = names.map((n) => `${n}:${String(lower[n]).trim().replace(/\s+/g, ' ')}\n`).join('');
  const signed = names.join(';');
  const pairs: Array<[string, string]> = [...i.url.searchParams.entries()].map(([k, v]) => [enc(k, false), enc(v, false)]);
  pairs.sort((p, q) => (p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : p[1] < q[1] ? -1 : p[1] > q[1] ? 1 : 0));
  const query = pairs.map(([k, v]) => `${k}=${v}`).join('&');
  const path = i.url.pathname.split('/').map((seg) => enc(decodeURIComponent(seg), false)).join('/');
  const canonical = [i.method, path || '/', query, canonicalHeaders, signed, i.payloadHash].join('\n');
  const scope = `${day}/${i.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${i.secretAccessKey}`, day), i.region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${i.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`;
}

/**
 * S3-compatible object storage (AWS S3, Cloudflare R2, Backblaze B2, Wasabi, MinIO...).
 * Objects are already encrypted with the user's key before they get here; the provider only sees ciphertext.
 */
export class S3BlobStore implements BlobStore {
  constructor(private readonly o: S3Options) {}

  private url(key: string): URL {
    if (!/^u\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/.test(key)) throw new Error('invalid blob key');
    const full = `${this.o.prefix ? `${this.o.prefix.replace(/^\/+|\/+$/g, '')}/` : ''}${key}`;
    const base = new URL(this.o.endpoint);
    if (this.o.pathStyle ?? true) return new URL(`${base.origin}/${this.o.bucket}/${enc(full, true)}`);
    return new URL(`${base.protocol}//${this.o.bucket}.${base.host}/${enc(full, true)}`);
  }

  /** The URL and headers of a signed request (exposed for tests). */
  build(method: 'PUT' | 'GET' | 'DELETE', key: string, body: Buffer | undefined, date = new Date()) {
    const url = this.url(key);
    const payloadHash = sha256hex(body ?? '');
    const headers: Record<string, string> = {
      host: url.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''),
    };
    if (body) {
      headers['content-type'] = 'application/octet-stream';
      headers['content-length'] = String(body.length);
    }
    const authorization = signV4({ method, url, headers, payloadHash, date, region: this.o.region,
      accessKeyId: this.o.accessKeyId, secretAccessKey: this.o.secretAccessKey });
    const { host: _host, ...sendHeaders } = headers;
    return { url, headers: { ...sendHeaders, authorization } as Record<string, string> };
  }

  private async request(method: 'PUT' | 'GET' | 'DELETE', key: string, body?: Buffer): Promise<Response> {
    const { url, headers } = this.build(method, key, body);
    return fetch(url, { method, headers, body: body ? new Uint8Array(body) : undefined, signal: AbortSignal.timeout(this.o.timeoutMs ?? 60_000) });
  }

  private static async fail(op: string, r: Response): Promise<never> {
    const text = (await r.text().catch(() => '')).slice(0, 300);
    const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? '';
    throw new Error(`object storage ${op} failed: HTTP ${r.status}${code ? ` ${code}` : ''}`);
  }

  async put(key: string, data: Buffer) {
    const r = await this.request('PUT', key, data);
    if (!r.ok) await S3BlobStore.fail('upload', r);
    await r.arrayBuffer();
  }

  async get(key: string) {
    const r = await this.request('GET', key);
    if (!r.ok) await S3BlobStore.fail('download', r);
    return Buffer.from(await r.arrayBuffer());
  }

  async delete(key: string) {
    const r = await this.request('DELETE', key);
    if (!r.ok && r.status !== 404) await S3BlobStore.fail('delete', r);
    await r.arrayBuffer();
  }
}
