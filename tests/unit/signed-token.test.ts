import { describe, expect, it, vi } from "vitest";
import { signToken, verifyToken } from "@/lib/signed-token";

describe("signed tokens", () => {
  it("round-trips the payload", () => {
    const t = signToken({ w: "ws1", u: "u1" }, "purpose-a", 60);
    expect(verifyToken<{ w: string }>(t, "purpose-a")).toMatchObject({ w: "ws1", u: "u1" });
  });
  it("rejects tampering, wrong purpose, garbage and expiry", () => {
    const t = signToken({ w: "ws1" }, "p", 60);
    const [data, sig] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ w: "ws2", exp: 9999999999 })).toString("base64url");
    expect(verifyToken(`${forged}.${sig}`, "p")).toBeNull();
    expect(verifyToken(`${data}.${sig}x`, "p")).toBeNull();
    expect(verifyToken(t, "other-purpose")).toBeNull();
    expect(verifyToken("nope", "p")).toBeNull();
    expect(verifyToken(undefined, "p")).toBeNull();

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 61_000);
    expect(verifyToken(t, "p")).toBeNull();
    vi.useRealTimers();
  });
});
