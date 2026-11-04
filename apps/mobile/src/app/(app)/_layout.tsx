import { Redirect, Stack } from 'expo-router';
import { useEffect } from 'react';
import { Text, View } from 'react-native';
import { useChangeFeed } from '../../lib/changes';
import { useConnectivity } from '../../lib/offline';
import { handleNotificationTaps, registerForPush } from '../../lib/push';
import { Loading, useTheme } from '../../components/ui';
import { useAuth } from '../../lib/auth';

/** Everything in (app) requires an active (approved, unexpired) account. The server enforces this too. */
export default function AppLayout() {
  const { state } = useAuth();
  const t = useTheme();
  const active = state.kind === 'signedIn' && state.account.displayStatus === 'active';
  const online = useConnectivity();
  useChangeFeed(active && online);
  useEffect(() => {
    if (!active) return;
    registerForPush().catch(() => undefined);
    return handleNotificationTaps();
  }, [active]);
  if (state.kind === 'loading') return <Loading />;
  if (state.kind !== 'signedIn' || state.account.displayStatus !== 'active') return <Redirect href="/" />;
  return (
    <View style={{ flex: 1 }}>
    {!online ? (
      <View accessibilityLiveRegion="polite" style={{ backgroundColor: t.warn, paddingVertical: 4, paddingHorizontal: 12 }}>
        <Text style={{ color: '#fff', fontSize: 13, textAlign: 'center' }}>Offline — showing saved mail. Your changes will be sent when you are back online.</Text>
      </View>
    ) : null}
    <Stack screenOptions={{ headerStyle: { backgroundColor: t.surface }, headerTintColor: t.text, contentStyle: { backgroundColor: t.bg } }}>
      <Stack.Screen name="home" options={{ title: 'Email Platform' }} />
      <Stack.Screen name="sessions" options={{ title: 'Signed-in devices' }} />
      <Stack.Screen name="change-password" options={{ title: 'Change password' }} />
      <Stack.Screen name="mailbox-add" options={{ title: 'Add mailbox' }} />
      <Stack.Screen name="mailbox/[id]" options={{ title: 'Mailbox' }} />
      <Stack.Screen name="inbox" options={{ title: 'All inboxes' }} />
      <Stack.Screen name="folders/[mailboxId]" options={{ title: 'Folders' }} />
      <Stack.Screen name="folder/[folderId]" options={{ title: 'Folder' }} />
      <Stack.Screen name="message/[id]" options={{ title: 'Message' }} />
      <Stack.Screen name="compose" options={{ title: 'New message' }} />
      <Stack.Screen name="thread/[id]" options={{ title: 'Conversation' }} />
      <Stack.Screen name="search" options={{ title: 'Search' }} />
      <Stack.Screen name="outbox" options={{ title: 'Outbox' }} />
      <Stack.Screen name="drafts" options={{ title: 'Drafts' }} />
      <Stack.Screen name="signatures" options={{ title: 'Signatures' }} />
      <Stack.Screen name="templates" options={{ title: 'Templates' }} />
      <Stack.Screen name="notifications" options={{ title: 'Notifications' }} />
      <Stack.Screen name="storage" options={{ title: 'Storage' }} />
    </Stack>
    </View>
  );
}
