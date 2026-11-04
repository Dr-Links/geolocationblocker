import { Alert, type AlertButton } from 'react-native';

interface InstallEvent extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }
let deferred: InstallEvent | null = null;
const listeners = new Set<() => void>();
let done = false;

/** Runs once in the web app: service worker (offline app + notifications), install prompt, browser dialogs. */
export function setupWeb(): void {
  if (done || typeof window === 'undefined') return;
  done = true;
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
  }
  window.addEventListener('beforeinstallprompt', (ev) => {
    ev.preventDefault();
    deferred = ev as InstallEvent;
    listeners.forEach((f) => f());
  });
  window.addEventListener('appinstalled', () => { deferred = null; listeners.forEach((f) => f()); });

  // React Native's Alert does nothing in a browser; use the browser's own dialogs so confirmations still work.
  Alert.alert = (title: string, message?: string, buttons?: AlertButton[]) => {
    const text = message ? `${title}\n\n${message}` : title;
    const actions = (buttons ?? []).filter((b) => b.style !== 'cancel');
    if (!buttons || buttons.length <= 1) {
      window.alert(text);
      buttons?.[0]?.onPress?.();
      return;
    }
    // One question per real choice, in order; the first one accepted runs.
    for (const b of actions) {
      const q = actions.length === 1 ? text : `${text}\n\n→ ${b.text}?`;
      if (window.confirm(q)) {
        b.onPress?.();
        return;
      }
    }
    buttons.find((b) => b.style === 'cancel')?.onPress?.();
  };
}

export function canInstall(): boolean {
  return deferred !== null;
}

export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false;
  await deferred.prompt();
  const r = await deferred.userChoice;
  deferred = null;
  listeners.forEach((f) => f());
  return r.outcome === 'accepted';
}

const standalone = () => window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;

/** iPhone/iPad have no install button: explain "Add to Home Screen" (needed there for notifications too). */
export function installHint(): string | null {
  if (typeof navigator === 'undefined' || standalone()) return null;
  if (/iPhone|iPad|iPod/.test(navigator.userAgent)) return 'To install: tap the Share button in Safari, then "Add to Home Screen". This is also needed for notifications on iPhone.';
  return null;
}

export function onInstallAvailable(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
