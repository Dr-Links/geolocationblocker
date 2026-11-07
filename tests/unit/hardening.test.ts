import { describe, expect, it } from "vitest";
import { ZodError, z } from "zod";
import { gate } from "@/auth.config";
import { buildCsp } from "@/lib/csp";
import { productionConfigProblems } from "@/lib/env";
import { apiHandler } from "@/server/api";
import { ForbiddenError, RateLimitError } from "@/server/errors";

const KEY = Buffer.alloc(32, 7).toString("base64");
const base = { NODE_ENV: "production", APP_URL: "https://app.example.com", DATABASE_URL: "postgres://x", AUTH_SECRET: "a".repeat(40), ENCRYPTION_KEY: KEY };

describe("CSP", () => {
  it("allows only nonce'd scripts, blocks framing and plugins", () => {
    const csp = buildCsp("abc123");
    expect(csp).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("upgrade-insecure-requests");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
  });
  it("dev mode allows eval and websockets (hot reload), without upgrading to https", () => {
    const csp = buildCsp("n", { dev: true });
    expect(csp).toContain("'unsafe-eval'");
    expect(csp).toContain("connect-src 'self' ws:");
    expect(csp).not.toContain("upgrade-insecure-requests");
  });
});

describe("route gate", () => {
  const url = (p: string) => new URL(p, "http://localhost:3000");
  const user = (platformRole: "USER" | "SUPER_ADMIN") => ({ user: { platformRole } });
  it("sends signed-out visitors to login with a callback", () => {
    const r = gate(null, url("/dashboard/posts?tab=failed"))!;
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.get("location")!);
    expect(loc.pathname).toBe("/login");
    expect(loc.searchParams.get("callbackUrl")).toBe("/dashboard/posts?tab=failed");
    expect(gate(null, url("/admin"))!.headers.get("location")).toContain("/login");
  });
  it("keeps non-admins out of /admin and lets admins in", () => {
    expect(new URL(gate(user("USER"), url("/admin/users"))!.headers.get("location")!).pathname).toBe("/dashboard");
    expect(gate(user("SUPER_ADMIN"), url("/admin/users"))).toBeNull();
  });
  it("lets public pages through and bounces signed-in users from login", () => {
    expect(gate(null, url("/"))).toBeNull();
    expect(gate(null, url("/invite/abc"))).toBeNull();
    expect(new URL(gate(user("USER"), url("/login"))!.headers.get("location")!).pathname).toBe("/dashboard");
  });
});

describe("production config check", () => {
  it("accepts a complete config with integrations off (all mocks)", () => {
    expect(productionConfigProblems(base)).toEqual([]);
  });
  it("flags weak secrets and a bad encryption key", () => {
    const p = productionConfigProblems({ ...base, AUTH_SECRET: "short-but-16chars", ENCRYPTION_KEY: "bm90LTMyLWJ5dGVz" });
    expect(p.join("\n")).toMatch(/AUTH_SECRET: use at least 32/);
    expect(p.join("\n")).toMatch(/ENCRYPTION_KEY: must be 32 bytes/);
  });
  it("flags half-configured integrations, naming what's missing", () => {
    const p = productionConfigProblems({ ...base, STRIPE_SECRET_KEY: "sk_test_123", X_CLIENT_ID: "abc" });
    expect(p).toContain("Stripe is half-configured: set STRIPE_WEBHOOK_SECRET too, or clear STRIPE_SECRET_KEY to use the mock");
    expect(p.some((x) => x.startsWith("X is half-configured: set X_CLIENT_SECRET"))).toBe(true);
  });
  it("flags a non-Stripe-looking key and the example admin password on a public URL", () => {
    const p = productionConfigProblems({ ...base, STRIPE_SECRET_KEY: "pk_live_oops", STRIPE_WEBHOOK_SECRET: "whsec_x", SEED_ADMIN_PASSWORD: "ChangeMe123!" });
    expect(p.join("\n")).toMatch(/doesn't look like a Stripe secret key/);
    expect(p.join("\n")).toMatch(/SEED_ADMIN_PASSWORD is still the example/);
  });
  it("reports missing required vars", () => {
    expect(productionConfigProblems({ NODE_ENV: "production" }).join("\n")).toMatch(/DATABASE_URL/);
  });
});

describe("apiHandler", () => {
  const run = (err: unknown) => apiHandler(async () => { throw err; })();
  it("maps app errors to their status with a safe message", async () => {
    const r = await run(new ForbiddenError());
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: "You don't have permission to do that", code: "FORBIDDEN" });
  });
  it("adds Retry-After on rate limits", async () => {
    const r = await run(new RateLimitError(42));
    expect([r.status, r.headers.get("retry-after")]).toEqual([429, "42"]);
  });
  it("turns validation errors into 400 with field errors", async () => {
    let zerr: ZodError | undefined;
    try { z.object({ a: z.string() }).parse({}); } catch (e) { zerr = e as ZodError; }
    const r = await run(zerr);
    expect(r.status).toBe(400);
    expect((await r.json()).fieldErrors.a).toBeTruthy();
  });
  it("masks unexpected errors", async () => {
    const r = await run(new Error("connection string postgres://secret leaked"));
    expect(r.status).toBe(500);
    expect(JSON.stringify(await r.json())).not.toContain("secret");
  });
});
