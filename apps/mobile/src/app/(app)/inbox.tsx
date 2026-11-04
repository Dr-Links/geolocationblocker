import type { MailboxDto } from '@app/shared';
import { router, Stack, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { MessageList } from '../../components/MessageList';
import { ThreadList } from '../../components/ThreadList';
import { useTheme } from '../../components/ui';
import { api } from '../../lib/api';

/** Unified inbox: the inboxes of all connected mailboxes, each message labelled with its mailbox. */
export default function UnifiedInbox() {
  const t = useTheme();
  const [mailboxes, setMailboxes] = useState<MailboxDto[]>([]);
  const [filter, setFilter] = useState<string | null>(null);
  const [view, setView] = useState<'inbox' | 'sent' | 'flagged'>('inbox');
  const [unread, setUnread] = useState(false);
  const [conversations, setConversations] = useState(true);
  useFocusEffect(useCallback(() => { api.mailboxes().then((r) => setMailboxes(r.mailboxes.filter((m) => m.status !== 'disconnected')), () => undefined); }, []));

  const chip = (label: string, selected: boolean, onPress: () => void) => (
    <Pressable key={label} accessibilityRole="button" accessibilityState={{ selected }} onPress={onPress}
      style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, borderWidth: 1, borderColor: selected ? t.primary : t.border, backgroundColor: selected ? t.primary : t.surface }}>
      <Text style={{ color: selected ? '#fff' : t.text, fontSize: 13 }}>{label}</Text>
    </Pressable>
  );
  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <Stack.Screen options={{ title: view === 'flagged' ? 'Starred' : view === 'sent' ? 'All sent' : 'All inboxes' }} />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 8, padding: 10 }}>
        {chip('Inbox', view === 'inbox', () => setView('inbox'))}
        {chip('Sent', view === 'sent', () => setView('sent'))}
        {chip('★ Starred', view === 'flagged', () => setView('flagged'))}
        {chip('Unread only', unread, () => setUnread(!unread))}
        {chip(conversations ? 'Conversations' : 'Single messages', conversations, () => setConversations(!conversations))}
        {chip('🔍 Search', false, () => router.push('/search'))}
        {chip('All mailboxes', filter === null, () => setFilter(null))}
        {mailboxes.map((m) => chip(m.displayName || m.email, filter === m.id, () => setFilter(m.id)))}
      </ScrollView>
      {conversations
        ? <ThreadList query={{ view, mailboxId: filter ?? undefined, unread }} showMailbox={!filter} empty="No messages here yet. New mail appears within a minute or two." />
        : <MessageList query={{ view, mailboxId: filter ?? undefined, unread }} showMailbox={!filter} empty="No messages here yet. New mail appears within a minute or two." />}
    </View>
  );
}
