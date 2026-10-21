import argon2 from 'argon2';

// OWASP baseline for argon2id: 19 MiB memory, 2 iterations, 1 lane.
const OPTIONS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, OPTIONS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/** Spend the same time as a real check when the account does not exist (prevents user enumeration by timing). */
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword('dummy-password-for-timing');
  await verifyPassword(await dummyHash, password);
}

export function needsRehash(hash: string): boolean {
  return argon2.needsRehash(hash, OPTIONS);
}
