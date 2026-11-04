import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, View } from 'react-native';
import { Body, Button, Card, Message, Screen, Title, useTheme } from '../../components/ui';
import { api } from '../../lib/api';
import { formatDateTime } from '../../lib/format';

type Item = Awaited<ReturnType<typeof api.reminders>>['reminders'][number];

export default function Reminders() {
  const t = useTheme();
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => { api.reminders().then((r) => setItems(r.reminders), (e: Error) => setError(e.message)); }, []);
  useFocusEffect(load);
  const pending = items?.filter((i) => i.status === 'pending') ?? [];
  const past = items?.filter((i) => i.status !== 'pending') ?? [];
  const row = (i: Item) => (
    <Pressable key={i.id} accessibilityRole="button" onPress={() => router.push({ pathname: '/message/[id]', params: { id: i.message.id } })}
      style={{ paddingVertical: 10, borderTopWidth: 1, borderColor: t.border }}>
      <Body style={{ fontWeight: '600' }} numberOfLines={1}>{i.message.subject || '(no subject)'}</Body>
      <Body muted style={{ fontSize: 13 }} numberOfLines={1}>{i.message.from?.name || i.message.from?.address || ''} · {i.message.mailbox.email}</Body>
      <Body style={{ fontSize: 13, color: i.status === 'pending' ? t.text : t.muted }}>
        {i.status === 'pending' ? `⏰ ${formatDateTime(i.remindAt)}${i.onlyIfNoReply ? ' · only if nobody replies' : ''}`
          : i.status === 'replied' ? 'Cancelled: someone replied' : `Reminded ${formatDateTime(i.firedAt ?? i.remindAt)}`}
      </Body>
    </Pressable>
  );
  return (
    <Screen>
      <Title>Reminders</Title>
      <Message text={error} />
      <Body muted style={{ marginBottom: 8 }}>Open a message and tap "Remind me" to add one. The notification only says which mailbox the message is in.</Body>
      <Card>
        <Body style={{ fontWeight: '700' }}>Upcoming ({pending.length})</Body>
        {pending.length ? pending.map(row) : <Body muted>None.</Body>}
      </Card>
      {past.length ? <Card><Body style={{ fontWeight: '700' }}>Last 30 days</Body>{past.map(row)}</Card> : null}
      <View style={{ height: 8 }} />
      <Button title="Refresh" variant="link" onPress={load} />
    </Screen>
  );
}
