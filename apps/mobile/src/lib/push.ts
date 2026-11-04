import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { Platform } from 'react-native';
import { api } from './api';

// Show notifications while the app is open too (the server already decided this one is wanted).
Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

/**
 * Asks for permission and registers this phone with the server. Notifications only ever say which of your
 * mailboxes received mail ("New email received at sales@…"), never the sender or subject.
 */
export async function registerForPush(): Promise<'registered' | 'denied' | 'unavailable'> {
  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('mail', { name: 'New mail', importance: Notifications.AndroidImportance.HIGH });
    }
    let perm = await Notifications.getPermissionsAsync();
    if (!perm.granted) perm = await Notifications.requestPermissionsAsync();
    if (!perm.granted) return 'denied';
    const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId;
    if (!projectId) return 'unavailable'; // set by `eas init`; needed for Expo push tokens
    const { data } = await Notifications.getExpoPushTokenAsync({ projectId });
    await api.registerPushToken(data, 'expo');
    return 'registered';
  } catch {
    return 'unavailable';
  }
}

/** Opens the right screen when a notification is tapped. */
export function handleNotificationTaps(): () => void {
  const sub = Notifications.addNotificationResponseReceivedListener((resp) => {
    const d = resp.notification.request.content.data as { type?: string; messageId?: string; mailboxId?: string; outboundId?: string } | undefined;
    if (d?.type === 'new_mail' && d.messageId) router.push({ pathname: '/message/[id]', params: { id: d.messageId } });
    else if (d?.type === 'new_mail') router.push('/inbox');
    else if (d?.type === 'send_problem') router.push('/outbox');
    else if (d?.type === 'mailbox_problem' && d.mailboxId) router.push({ pathname: '/mailbox/[id]', params: { id: d.mailboxId } });
  });
  return () => sub.remove();
}
