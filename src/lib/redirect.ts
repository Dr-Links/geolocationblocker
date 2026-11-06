/**
 * Only allow same-origin relative paths as post-login redirects (prevents open redirects).
 * Accepts a relative path, or an absolute URL whose origin matches APP_URL.
 */
export function safeRedirectPath(input: unknown, fallback = "/dashboard"): string {
  if (typeof input !== "string" || input.length === 0) return fallback;
  let path = input;
  if (/^https?:\/\//i.test(input)) {
    try {
      const url = new URL(input);
      const app = new URL(process.env.APP_URL ?? "http://localhost:3000");
      if (url.origin !== app.origin) return fallback;
      path = url.pathname + url.search;
    } catch {
      return fallback;
    }
  }
  if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\")) return fallback;
  return path;
}
