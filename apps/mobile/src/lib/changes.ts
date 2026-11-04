import { AppState } from 'react-native';
import { useEffect } from 'react';
import { api } from './api';
import { cacheGet, cacheSet } from './localdb';

const listeners = new Set<(entities: Set<string>) => void>();

/** Screens subscribe to reload when another device (or the server) changed something they show. */
export function onRemoteChange(fn: (entities: Set<string>) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Pulls the change feed since the saved cursor and notifies screens about what changed. */
export async function pullChanges(): Promise<void> {
  const saved = await cacheGet<number>('sync_cursor');
  let cursor = saved?.value ?? 0;
  const touched = new Set<string>();
  for (let i = 0; i < 10; i++) {
    const r = await api.changes(cursor);
    if (r.resetRequired) touched.add('all');
    for (const ch of r.changes) touched.add(ch.entity);
    cursor = r.cursor;
    if (!r.hasMore) break;
  }
  await cacheSet('sync_cursor', cursor);
  if (touched.size) listeners.forEach((f) => f(touched));
}

/** While the app is in the foreground, checks for changes every 30 s and whenever it comes back to the front. */
export function useChangeFeed(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const run = () => { pullChanges().catch(() => undefined); };
    run();
    const timer = setInterval(run, 30_000);
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') run(); });
    return () => { clearInterval(timer); sub.remove(); };
  }, [enabled]);
}
