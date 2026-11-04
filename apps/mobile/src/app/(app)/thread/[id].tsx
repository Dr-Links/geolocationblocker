import type { MessageSummary } from '@app/shared';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { Message, useTheme } from '../../../components/ui';
import { api } from '../../../lib/api';
import { formatDateTime } from '../../../lib/format';

/** A conversation: every message, oldest first, each labelled with the mailbox that holds it. */
export default function Thread() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useTheme();
  const [data, setData] = useState<{ subject: string | null; messages: MessageSummary[]; mailboxes: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.thread(id).then(setData, (e: Error) => setError(e.message)); }, [id]);
  if (error) return <View style={{ padding: 16 }}><Message text={error} /></View>;
  if (!data) return null;
  return (
    <ScrollView style={{ flex: 1, backgroundColor: t.bg }} contentContainerStyle={{ padding: 12 }}>
      <Stack.Screen options={{ title: data.subject || 'Conversation' }} />
      <Text style={{ color: t.text, fontSize: 18, fontWeight: '700', marginBottom: 4 }}>{data.subject || '(no subject)'}</Text>
      {data.mailboxes.length > 1 ? <Text style={{ color: t.warn, marginBottom: 8 }}>This conversation spans several of your mailboxes: {data.mailboxes.join(', ')}</Text> : null}
      {data.messages.map((m) => (
        <Pressable key={m.id} accessibilityRole="button" onPress={() => router.push({ pathname: '/message/[id]', params: { id: m.id } })}
          style={{ backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, borderRadius: 10, padding: 12, marginBottom: 10 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <Text style={{ color: t.text, fontWeight: m.isSeen ? '400' : '700', flex: 1 }} numberOfLines={1}>{m.from?.name || m.from?.address || '(no sender)'}</Text>
            <Text style={{ color: t.muted, fontSize: 12 }}>{formatDateTime(m.receivedAt)}</Text>
          </View>
          <Text style={{ color: t.primary, fontSize: 12, marginTop: 2 }}>{m.mailbox.displayName || m.mailbox.email}</Text>
          <Text style={{ color: t.muted, marginTop: 4 }} numberOfLines={3}>{m.snippet ?? ''}</Text>
          {!m.onServer ? <Text style={{ color: t.muted, fontSize: 11, marginTop: 4 }}>Deleted on server · stored copy</Text> : null}
        </Pressable>
      ))}
    </ScrollView>
  );
}
