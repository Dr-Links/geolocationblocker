// Web app: nothing is written to the browser's storage. Mail viewed in this tab is kept in memory only,
// so it disappears when the tab is closed and nothing is left behind on shared or public computers.
// (The phone apps use an encrypted on-device database instead.)
export interface QueueRow { id: string; kind: string; payload: string; label: string | null; created_at: number; attempts: number; last_error: string | null; failed: number }

const kv = new Map<string, { value: string; updatedAt: number }>();
const queue = new Map<string, QueueRow>();

export async function wipeLocalData(): Promise<void> {
  kv.clear();
  queue.clear();
}
export async function cacheGet<T>(key: string): Promise<{ value: T; updatedAt: number } | null> {
  const r = kv.get(key);
  return r ? { value: JSON.parse(r.value) as T, updatedAt: r.updatedAt } : null;
}
export async function cacheSet(key: string, value: unknown): Promise<void> {
  if (kv.size > 500) kv.delete(kv.keys().next().value as string);
  kv.set(key, { value: JSON.stringify(value), updatedAt: Date.now() });
}
export async function queueAdd(id: string, kind: string, payload: unknown, label: string) {
  if (!queue.has(id)) queue.set(id, { id, kind, payload: JSON.stringify(payload), label, created_at: Date.now(), attempts: 0, last_error: null, failed: 0 });
}
export async function queueAll(pendingOnly: boolean): Promise<QueueRow[]> {
  return [...queue.values()].filter((r) => !pendingOnly || !r.failed).sort((a, b) => a.created_at - b.created_at);
}
export async function queueDelete(id: string) {
  queue.delete(id);
}
export async function queueFail(id: string, error: string) {
  const r = queue.get(id);
  if (r) queue.set(id, { ...r, attempts: r.attempts + 1, last_error: error, failed: 1 });
}
