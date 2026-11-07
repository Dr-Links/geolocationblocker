import { decryptSecret, encryptSecret, isEncryptedWithCurrentKey } from "@/lib/crypto";
import { systemDb } from "@/lib/db";

/**
 * Key rotation, step 2: re-encrypt every stored secret (social tokens, AI
 * keys) under the current ENCRYPTION_KEY, using ENCRYPTION_KEY_PREVIOUS to
 * read the old ones. Idempotent: rows already on the current key are skipped.
 * Once it reports 0 failures, ENCRYPTION_KEY_PREVIOUS can be removed.
 * `workspaceIds` limits it to some workspaces (tests; staged rollouts).
 */
export async function reencryptAllSecrets(opts: { workspaceIds?: string[] } = {}) {
  const scope = opts.workspaceIds ? { workspaceId: { in: opts.workspaceIds } } : {};
  const report = { socialAccounts: 0, providerCredentials: 0, alreadyCurrent: 0, failed: [] as string[] };
  const rotate = (v: string) => (isEncryptedWithCurrentKey(v) ? null : encryptSecret(decryptSecret(v)));

  for (const a of await systemDb.socialAccount.findMany({ where: scope, select: { id: true, accessTokenEnc: true, refreshTokenEnc: true } })) {
    try {
      const access = rotate(a.accessTokenEnc);
      const refresh = a.refreshTokenEnc ? rotate(a.refreshTokenEnc) : null;
      if (!access && !refresh) { report.alreadyCurrent++; continue; }
      await systemDb.socialAccount.update({
        where: { id: a.id },
        data: { ...(access ? { accessTokenEnc: access } : {}), ...(refresh ? { refreshTokenEnc: refresh } : {}) },
      });
      report.socialAccounts++;
    } catch {
      report.failed.push(`SocialAccount ${a.id}`);
    }
  }
  for (const c of await systemDb.providerCredential.findMany({ where: scope, select: { id: true, encryptedKey: true } })) {
    try {
      const next = rotate(c.encryptedKey);
      if (!next) { report.alreadyCurrent++; continue; }
      await systemDb.providerCredential.update({ where: { id: c.id }, data: { encryptedKey: next } });
      report.providerCredentials++;
    } catch {
      report.failed.push(`ProviderCredential ${c.id}`);
    }
  }
  return report;
}
