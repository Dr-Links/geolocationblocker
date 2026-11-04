import NetInfo from '@react-native-community/netinfo';
import { useEffect, useState } from 'react';
import { ApiError, api } from './api';
import { cacheGet, cacheSet, localDb } from './localdb';

export const isNetworkError = (e: unknown) => e instanceof ApiError && e.code === 'network_error';

/**
 * Loads data from the server and keeps a copy on the device; when offline, returns the saved copy instead.
 * `stale` tells the screen to say "Offline — showing saved copy".
 */
export async function cached<T>(key: string, load: () => Promise<T>): Promise<{ value: T; stale: boolean; savedAt?: number }> {
  try {
    const value = await load();
    await cacheSet(key, value);
    return { value, stale: false };
  } catch (e) {
    if (!isNetworkError(e)) throw e;
    const saved = await cacheGet<T>(key);
    if (!saved) throw e;
    return { value: saved.value, stale: true, savedAt: saved.updatedAt };
  }
}

// ---------------------------------------------------------------------------
// Queue of actions taken offline. Each carries the id the server uses to apply it only once
// (clientOpId for message actions, idempotencyKey for sends, the draft id for drafts).
// ---------------------------------------------------------------------------

type QueueItem =
  | { kind: 'action'; payload: { messageId: string; action: Parameters<typeof api.messageAction>[1]; extra: Parameters<typeof api.messageAction>[2] } }
  | { kind: 'send'; payload: Parameters<typeof api.send>[0] };

export interface QueuedRow { id: string; kind: string; label: string | null; created_at: number; attempts: number; last_error: string | null; failed: number }

const listeners = new Set<() => void>();
export const onQueueChange = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
const changed = () => listeners.forEach((f) => f());

export async function enqueue(id: string, item: QueueItem, label: string) {
  const db = await localDb();
  await db.runAsync('INSERT OR IGNORE INTO queue (id, kind, payload, label, created_at) VALUES (?, ?, ?, ?, ?)',
    [id, item.kind, JSON.stringify(item.payload), label, Date.now()]);
  changed();
}

export async function queued(): Promise<QueuedRow[]> {
  try {
    const db = await localDb();
    return await db.getAllAsync<QueuedRow>('SELECT id, kind, label, created_at, attempts, last_error, failed FROM queue ORDER BY created_at');
  } catch {
    return [];
  }
}

export async function removeQueued(id: string) {
  const db = await localDb();
  await db.runAsync('DELETE FROM queue WHERE id = ?', [id]);
  changed();
}

let flushing: Promise<number> | null = null;

/**
 * Sends queued actions in the order they were made. Stops at the first network error (still offline).
 * A refusal by the server (e.g. the message no longer exists) is kept as "failed" so the user sees it.
 */
export function flushQueue(): Promise<number> {
  flushing ??= (async () => {
    let done = 0;
    try {
      const db = await localDb();
      const rows = await db.getAllAsync<{ id: string; kind: string; payload: string; attempts: number }>(
        'SELECT id, kind, payload, attempts FROM queue WHERE failed = 0 ORDER BY created_at');
      for (const r of rows) {
        try {
          const p = JSON.parse(r.payload);
          if (r.kind === 'action') await api.messageAction(p.messageId, p.action, { ...p.extra, clientOpId: r.id });
          else if (r.kind === 'send') await api.send(p);
          await db.runAsync('DELETE FROM queue WHERE id = ?', [r.id]);
          done++;
        } catch (e) {
          if (isNetworkError(e)) break;
          await db.runAsync('UPDATE queue SET attempts = attempts + 1, last_error = ?, failed = 1 WHERE id = ?', [(e as Error).message, r.id]);
        }
      }
    } finally {
      flushing = null;
      changed();
    }
    return done;
  })();
  return flushing;
}

/** Flushes the queue whenever the phone comes back online. Returns whether it is online now. */
export function useConnectivity(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const unsub = NetInfo.addEventListener((s) => {
      const on = s.isConnected !== false && s.isInternetReachable !== false;
      setOnline(on);
      if (on) flushQueue().catch(() => undefined);
    });
    const timer = setInterval(() => { flushQueue().catch(() => undefined); }, 30_000);
    return () => { unsub(); clearInterval(timer); };
  }, []);
  return online;
}

export function useQueue(): QueuedRow[] {
  const [rows, setRows] = useState<QueuedRow[]>([]);
  useEffect(() => {
    const load = () => { queued().then(setRows); };
    load();
    return onQueueChange(load);
  }, []);
  return rows;
}
