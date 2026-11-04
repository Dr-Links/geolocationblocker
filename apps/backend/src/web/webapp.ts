import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import { FRAME_SCRIPT_HASHES } from '@app/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../lib/config.js';

/**
 * The web app's Content-Security-Policy. Scripts: only the app's own files plus the three fixed frame scripts
 * (by hash). Mail is shown in sandboxed srcdoc frames that inherit this policy and add their own stricter one.
 */
export const WEB_APP_CSP = [
  "default-src 'self'",
  `script-src 'self' '${FRAME_SCRIPT_HASHES.editor}' '${FRAME_SCRIPT_HASHES.bridge}' '${FRAME_SCRIPT_HASHES.mailLink}'`,
  "style-src 'self' 'unsafe-inline'",
  // Remote pictures in mail are blocked by the message frame's own policy until the user taps "Show images".
  "img-src 'self' data: blob: https: http:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function webAppDir(cfg: Config): string | null {
  const dir = cfg.webAppDir ? resolve(cfg.webAppDir) : null;
  return dir && existsSync(join(dir, 'index.html')) ? dir : null;
}

const isApi = (url: string) => url.startsWith('/v1/') || url === '/v1' || url.startsWith('/readyz') || url.startsWith('/healthz');

/** Serves the PWA (built with `expo export --platform web`) from the same origin as the API. */
export async function registerWebApp(app: FastifyInstance, dir: string) {
  await app.register(fastifyStatic, { root: dir, prefix: '/', index: ['index.html'], cacheControl: false, wildcard: true, serveDotFiles: false });
  app.addHook('onSend', async (req, reply) => {
    if (isApi(req.url)) return;
    reply.header('content-security-policy', WEB_APP_CSP);
    reply.header('cross-origin-opener-policy', 'same-origin');
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    const path = req.url.split('?')[0]!;
    if (path.startsWith('/_expo/static/')) reply.header('cache-control', 'public, max-age=31536000, immutable');
    else if (path === '/sw.js') { reply.header('cache-control', 'no-cache'); reply.header('service-worker-allowed', '/'); }
    else if (path.startsWith('/icons/') || path.startsWith('/assets/')) reply.header('cache-control', 'public, max-age=604800');
    else reply.header('cache-control', 'no-cache');
  });
}

/** App routes such as /inbox or /message/123 are handled by the web app itself. */
export function spaFallback(dir: string | null) {
  return (req: FastifyRequest, reply: FastifyReply) => {
    if (dir && req.method === 'GET' && !isApi(req.url) && !/\.[a-z0-9]{2,5}$/i.test(req.url.split('?')[0]!)) {
      return reply.type('text/html; charset=utf-8').sendFile('index.html');
    }
    return reply.code(404).send({ error: { code: 'not_found', message: 'Not found.' } });
  };
}
