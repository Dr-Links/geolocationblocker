import { deleteDatabaseAsync, openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';
import { getRandomBytes } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

const DB_NAME = 'mail-cache.db';
const KEY_NAME = 'local_db_key';
let opening: Promise<SQLiteDatabase> | null = null;

/**
 * The on-device cache of mail, drafts and queued actions. It is encrypted with SQLCipher using a random
 * key kept in the Android Keystore / iOS Keychain, and it is deleted when the user signs out.
 */
export function localDb(): Promise<SQLiteDatabase> {
  opening ??= (async () => {
    let key = await SecureStore.getItemAsync(KEY_NAME);
    if (!key) {
      key = Array.from(getRandomBytes(32), (b) => b.toString(16).padStart(2, '0')).join('');
      await SecureStore.setItemAsync(KEY_NAME, key);
    }
    const db = await openDatabaseAsync(DB_NAME);
    await db.execAsync(`PRAGMA key = "x'${key}'";`);
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS queue (id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, label TEXT,
                                        created_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, failed INTEGER NOT NULL DEFAULT 0);
    `);
    return db;
  })().catch((err) => {
    opening = null;
    throw err;
  });
  return opening;
}

/** Removes everything stored on this device (sign-out). */
export async function wipeLocalData(): Promise<void> {
  try {
    const db = await opening;
    await db?.closeAsync();
  } catch {
    // already closed
  }
  opening = null;
  await deleteDatabaseAsync(DB_NAME).catch(() => undefined);
  await SecureStore.deleteItemAsync(KEY_NAME).catch(() => undefined);
}

export async function cacheGet<T>(key: string): Promise<{ value: T; updatedAt: number } | null> {
  try {
    const db = await localDb();
    const row = await db.getFirstAsync<{ value: string; updated_at: number }>('SELECT value, updated_at FROM kv WHERE key = ?', [key]);
    return row ? { value: JSON.parse(row.value) as T, updatedAt: row.updated_at } : null;
  } catch {
    return null;
  }
}

export async function cacheSet(key: string, value: unknown): Promise<void> {
  try {
    const db = await localDb();
    await db.runAsync('INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)', [key, JSON.stringify(value), Date.now()]);
  } catch {
    // The cache is best effort; the app keeps working online without it.
  }
}
