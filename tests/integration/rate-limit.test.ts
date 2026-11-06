import { afterAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { getRedis } from "@/lib/redis";
import { enforceRateLimit, rateLimit } from "@/server/rate-limit";
import { RateLimitError } from "@/server/errors";

afterAll(() => getRedis().disconnect());

describe("rateLimit (redis fixed window)", () => {
  it("allows up to the limit, then blocks with a retry-after", async () => {
    const key = `test:${randomBytes(4).toString("hex")}`;
    for (let i = 0; i < 3; i++) expect((await rateLimit(key, 3, 60)).allowed).toBe(true);
    const blocked = await rateLimit(key, 3, 60);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
    expect(blocked.retryAfterSec).toBeLessThanOrEqual(60);
    await expect(enforceRateLimit(key, 3, 60)).rejects.toBeInstanceOf(RateLimitError);
  });

  it("keys are independent", async () => {
    const a = `test:${randomBytes(4).toString("hex")}`;
    const b = `test:${randomBytes(4).toString("hex")}`;
    await rateLimit(a, 1, 60);
    expect((await rateLimit(a, 1, 60)).allowed).toBe(false);
    expect((await rateLimit(b, 1, 60)).allowed).toBe(true);
  });
});
