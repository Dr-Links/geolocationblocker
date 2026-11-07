/**
 * Content-Security-Policy for HTML responses (built per request in middleware).
 *
 * - Scripts: only those carrying this request's nonce, plus what they load
 *   ('strict-dynamic'). Next.js reads the nonce from the request's CSP header
 *   and applies it to its own <script> tags, so no inline script runs otherwise.
 * - Styles: 'unsafe-inline' because React `style={}` attributes (progress bars,
 *   chart colours) can't carry a nonce. Style injection is far lower risk than
 *   script injection, and no user content is ever rendered as raw HTML.
 * - Images/media: our own origin plus https: (S3/R2 signed URLs and platform
 *   avatars are redirect targets, and their hosts vary per deployment).
 * - form-action: our origin plus the app-sign-in OAuth providers, because
 *   browsers apply form-action to the redirect after a form POST.
 */
export function buildCsp(nonce: string, opts: { dev?: boolean } = {}) {
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", ...(opts.dev ? ["'unsafe-eval'"] : [])],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:", "https:"],
    "media-src": ["'self'", "blob:", "https:"],
    "font-src": ["'self'", "data:"],
    "connect-src": ["'self'", ...(opts.dev ? ["ws:"] : [])],
    "frame-ancestors": ["'none'"],
    "frame-src": ["'none'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'", "https://accounts.google.com", "https://github.com"],
    ...(opts.dev ? {} : { "upgrade-insecure-requests": [] }),
  };
  return Object.entries(directives)
    .map(([k, v]) => (v.length ? `${k} ${v.join(" ")}` : k))
    .join("; ");
}
