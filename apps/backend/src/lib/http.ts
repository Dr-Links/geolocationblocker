import formbody from '@fastify/formbody';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Config } from './config.js';
import { AppError } from './errors.js';

/** Common Fastify setup: logging with redaction, security headers, rate limits, error mapping. */
export async function createHttp(
  cfg: Config,
  opts: { notFound?: (req: FastifyRequest, reply: FastifyReply) => unknown } = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    trustProxy: cfg.trustProxy,
    bodyLimit: 64 * 1024,
    logger: cfg.env === 'test' ? false : {
      level: cfg.env === 'production' ? 'info' : 'debug',
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]',
          '*.password', '*.newPassword', '*.currentPassword', '*.refreshToken', '*.token', '*.code', '*.recoveryCode'],
        censor: '[redacted]',
      },
    },
  });

  await app.register(formbody);
  if (cfg.httpRateLimit) await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute' });

  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    if (cfg.env === 'production') reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      if (err.headers) reply.headers(err.headers);
      return reply.code(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    const e = err as { statusCode?: number; validation?: unknown; message: string };
    if (e.statusCode === 429) {
      return reply.code(429).send({ error: { code: 'too_many_attempts', message: 'Too many requests. Please wait and try again.' } });
    }
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      return reply.code(e.statusCode).send({ error: { code: 'validation_failed', message: 'The request could not be processed.' } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'internal_error', message: 'Something went wrong. Please try again.' } });
  });

  app.setNotFoundHandler(opts.notFound ?? ((_req, reply) => reply.code(404).send({ error: { code: 'not_found', message: 'Not found.' } })));
  return app;
}
