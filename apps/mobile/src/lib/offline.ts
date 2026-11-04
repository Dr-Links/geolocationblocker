import NetInfo from '@react-native-community/netinfo';
import { useEffect, useState } from 'react';
import { ApiError, api } from './api';
import { cacheGet, cacheSet, queueAdd, queueAll, queueDelete, queueFail } from './localdb';

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
  await queueAdd(id, item.kind, item.payload, label);
  changed();
}

export async function queued(): Promise<QueuedRow[]> {
  try {
    return (await queueAll(false)).map(({ payload: _p, ...r }) => r);
  } catch {
    return [];
  }
}

export async function removeQueued(id: string) {
  await queueDelete(id);
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
      const rows = await queueAll(true);
      for (const r of rows) {
        try {
          const p = JSON.parse(r.payload);
          if (r.kind === 'action') await api.messageAction(p.messageId, p.action, { ...p.extra, clientOpId: r.id });
          else if (r.kind === 'send') await api.send(p);
          await queueDelete(r.id);
          done++;
        } catch (e) {
          if (isNetworkError(e)) break;
          await queueFail(r.id, (e as Error).message);
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
