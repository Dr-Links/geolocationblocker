/**
 * Re-encrypt stored secrets under the current ENCRYPTION_KEY (see docs/OPERATIONS.md#rotating-encryption_key).
 *   ENCRYPTION_KEY=<new> ENCRYPTION_KEY_PREVIOUS=<old> DATABASE_URL=<owner or app url> npm run keys:reencrypt
 */
import { db } from "@/lib/db";
import { reencryptAllSecrets } from "@/server/ops/reencrypt";

try {
  const r = await reencryptAllSecrets();
  console.log(JSON.stringify(r, null, 2));
  if (r.failed.length) {
    console.error(`${r.failed.length} secret(s) couldn't be decrypted with ENCRYPTION_KEY or ENCRYPTION_KEY_PREVIOUS. Keep ENCRYPTION_KEY_PREVIOUS until they're resolved (or those accounts are reconnected).`);
    process.exitCode = 1;
  } else {
    console.log("All secrets are on the current key. ENCRYPTION_KEY_PREVIOUS can now be removed (restart app and worker).");
  }
} finally {
  await db.$disconnect();
}
