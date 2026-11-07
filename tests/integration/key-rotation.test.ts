import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { db, systemDb } from "@/lib/db";
import { reencryptAllSecrets } from "@/server/ops/reencrypt";
import { cleanupTestData, makeTenant } from "./fixtures";

const ORIGINAL = { key: process.env.ENCRYPTION_KEY, prev: process.env.ENCRYPTION_KEY_PREVIOUS };
const NEW_KEY = Buffer.alloc(32, 9).toString("base64");

beforeAll(cleanupTestData);
afterEach(() => {
  process.env.ENCRYPTION_KEY = ORIGINAL.key;
  if (ORIGINAL.prev) process.env.ENCRYPTION_KEY_PREVIOUS = ORIGINAL.prev;
  else delete process.env.ENCRYPTION_KEY_PREVIOUS;
});
afterAll(async () => {
  await cleanupTestData();
  await db.$disconnect();
});

describe("ENCRYPTION_KEY rotation", () => {
  it("re-encrypts tokens and AI keys under the new key, so the old key can be retired", async () => {
    const t = await makeTenant("rotate");
    await systemDb.socialAccount.update({ where: { id: t.account.id }, data: { accessTokenEnc: encryptSecret("access-1"), refreshTokenEnc: encryptSecret("refresh-1") } });
    const cred = await systemDb.providerCredential.create({ data: { workspaceId: t.workspace.id, provider: "OPENAI", encryptedKey: encryptSecret("sk-byok"), last4: "byok" } });

    // Rotate: new key current, old key kept for reading.
    process.env.ENCRYPTION_KEY_PREVIOUS = ORIGINAL.key;
    process.env.ENCRYPTION_KEY = NEW_KEY;
    const only = { workspaceIds: [t.workspace.id] }; // other test files share this DB
    const first = await reencryptAllSecrets(only);
    expect(first.failed).toEqual([]);
    expect([first.socialAccounts, first.providerCredentials]).toEqual([1, 1]);
    expect((await reencryptAllSecrets(only)).socialAccounts).toBe(0); // idempotent

    // Old key gone: everything still decrypts.
    delete process.env.ENCRYPTION_KEY_PREVIOUS;
    const a = await systemDb.socialAccount.findUniqueOrThrow({ where: { id: t.account.id } });
    expect([decryptSecret(a.accessTokenEnc), decryptSecret(a.refreshTokenEnc!)]).toEqual(["access-1", "refresh-1"]);
    expect(decryptSecret((await systemDb.providerCredential.findUniqueOrThrow({ where: { id: cred.id } })).encryptedKey)).toBe("sk-byok");
  });

  it("reports secrets neither key can read instead of corrupting them", async () => {
    const t = await makeTenant("rotate-bad");
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 3).toString("base64"); // unrelated key, no PREVIOUS
    const stray = encryptSecret("from-a-lost-key");
    process.env.ENCRYPTION_KEY = ORIGINAL.key;
    await systemDb.socialAccount.update({ where: { id: t.account.id }, data: { accessTokenEnc: stray } });

    const r = await reencryptAllSecrets({ workspaceIds: [t.workspace.id] });
    expect(r.failed).toContain(`SocialAccount ${t.account.id}`);
    expect((await systemDb.socialAccount.findUniqueOrThrow({ where: { id: t.account.id } })).accessTokenEnc).toBe(stray);
  });
});
