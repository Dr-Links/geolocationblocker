import { router } from 'expo-router';
import { api } from './api';

// Web app notifications use the browser's Web Push. They say only which mailbox received mail, never the
// sender or subject. On iPhone/iPad they work in iOS 16.4+ once the app is added to the home screen.

const b64ToBytes = (s: string) => {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

export function pushSupported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export async function registerForPush(): Promise<'registered' | 'denied' | 'unavailable'> {
  try {
    if (!pushSupported()) return 'unavailable';
    const { webPushPublicKey } = await api.config();
    if (!webPushPublicKey) return 'unavailable';
    const perm = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    if (perm !== 'granted') return 'denied';
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(webPushPublicKey) });
    await api.registerPushToken(JSON.stringify(sub.toJSON()), 'webpush');
    return 'registered';
  } catch {
    return 'unavailable';
  }
}

/** Stops this browser's notifications (sign-out). */
export async function unsubscribeLocalPush(): Promise<void> {
  try {
    if (!pushSupported()) return;
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    await sub?.unsubscribe();
  } catch {
    // ignore
  }
}

/** The service worker tells the open app which notification was clicked. */
export function handleNotificationTaps(): () => void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return () => undefined;
  const onMsg = (ev: MessageEvent) => {
    const d = (ev.data as { awmNotification?: { type?: string; messageId?: string; mailboxId?: string } })?.awmNotification;
    if (!d) return;
    if ((d.type === 'new_mail' || d.type === 'reminder') && d.messageId) router.push({ pathname: '/message/[id]', params: { id: d.messageId } });
    else if (d.type === 'new_mail') router.push('/inbox');
    else if (d.type === 'send_problem') router.push('/outbox');
    else if (d.type === 'mailbox_problem' && d.mailboxId) router.push({ pathname: '/mailbox/[id]', params: { id: d.mailboxId } });
    else if (d.type === 'storage') router.push('/storage');
  };
  navigator.serviceWorker.addEventListener('message', onMsg);
  return () => navigator.serviceWorker.removeEventListener('message', onMsg);
}
