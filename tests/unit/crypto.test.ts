import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "@/lib/crypto";

const original = { key: process.env.ENCRYPTION_KEY, prev: process.env.ENCRYPTION_KEY_PREVIOUS };
const newKey = () => randomBytes(32).toString("base64");

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restore("ENCRYPTION_KEY", original.key);
  restore("ENCRYPTION_KEY_PREVIOUS", original.prev);
});

describe("encryptSecret / decryptSecret", () => {
  it("round-trips", () => {
    const token = "ya29.a0AfH6SMB-very-secret-token";
    const enc = encryptSecret(token);
    expect(enc).not.toContain(token);
    expect(enc.startsWith("v1.")).toBe(true);
    expect(decryptSecret(enc)).toBe(token);
  });

  it("uses a random IV (same plaintext → different ciphertext)", () => {
    expect(encryptSecret("x")).not.toBe(encryptSecret("x"));
  });

  it("rejects tampered ciphertext", () => {
    const enc = encryptSecret("hello");
    const parts = enc.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decryptSecret(parts.join("."))).toThrow();
  });

  it("decrypts with the previous key during rotation", () => {
    const oldKey = newKey();
    process.env.ENCRYPTION_KEY = oldKey;
    const enc = encryptSecret("rotate-me");
    process.env.ENCRYPTION_KEY = newKey();
    expect(() => decryptSecret(enc)).toThrow();
    process.env.ENCRYPTION_KEY_PREVIOUS = oldKey;
    expect(decryptSecret(enc)).toBe("rotate-me");
  });

  it("rejects keys that are not 32 bytes", () => {
    process.env.ENCRYPTION_KEY = Buffer.from("short").toString("base64");
    expect(() => encryptSecret("x")).toThrow(/32 bytes/);
  });

  it("rejects unknown formats", () => {
    expect(() => decryptSecret("plaintext")).toThrow(/format/);
  });
});
