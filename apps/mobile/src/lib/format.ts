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
