import { getCalendars } from 'expo-localization';

export function deviceTimeZone(): string | null {
  try {
    return getCalendars()[0]?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
  } catch {
    return null;
  }
}

export function formatDateTime(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat(undefined, {
      year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit',
      ...(timeZone ? { timeZone } : {}),
    }).format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleString();
  }
}

export function daysLeft(iso: string | null): number | null {
  if (!iso) return null;
  return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000));
}

/** "14:05" today, "Mon" this week, otherwise "12 Mar". */
export function shortDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  try {
    if (d.toDateString() === now.toDateString()) return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(d);
    if (now.getTime() - d.getTime() < 6 * 86_400_000) return new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(d);
    return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) }).format(d);
  } catch {
    return d.toLocaleDateString();
  }
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
