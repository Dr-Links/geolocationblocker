import type { ThreadSummary } from '@app/shared';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { api } from '../lib/api';
import { shortDate } from '../lib/format';
import { Message, useTheme } from './ui';

type Query = Parameters<typeof api.threads>[0];

/** Conversation list: one row per conversation, newest first. */
export function ThreadList({ query, showMailbox, empty }: { query: Query; showMailbox: boolean; empty: string }) {
  const t = useTheme();
  const [items, setItems] = useState<ThreadSummary[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify(query);
  const load = useCallback(async (more: boolean) => {
    try {
      const r = await api.threads({ ...query, before: more ? cursor : null });
      setItems((prev) => (more ? [...(prev ?? []), ...r.threads] : r.threads));
      setCursor(r.nextCursor);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [key, cursor]); // eslint-disable-line react-hooks/exhaustive-deps
  useFocusEffect(useCallback(() => { load(false); }, [key])); // eslint-disable-line react-hooks/exhaustive-deps

  if (items === null && !error) return <View style={{ flex: 1, justifyContent: 'center' }}><ActivityIndicator color={t.primary} /></View>;
  return (
    <FlatList
      style={{ flex: 1, backgroundColor: t.bg }}
      data={items ?? []}
      keyExtractor={(x) => x.id}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(false); setRefreshing(false); }} />}
      onEndReached={() => { if (cursor) load(true); }}
      ListHeaderComponent={error ? <View style={{ padding: 16 }}><Message text={error} /></View> : undefined}
      ListEmptyComponent={<Text style={{ color: t.muted, padding: 24, textAlign: 'center' }}>{empty}</Text>}
      renderItem={({ item: th }) => {
        const m = th.latest;
        const unread = th.unreadCount > 0;
        return (
          <Pressable accessibilityRole="button" onPress={() => (th.messageCount > 1
              ? router.push({ pathname: '/thread/[id]', params: { id: th.id } })
              : router.push({ pathname: '/message/[id]', params: { id: m.id } }))}
            style={({ pressed }) => ({ backgroundColor: pressed ? t.border : t.surface, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderColor: t.border })}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              {unread ? <View accessibilityLabel="Unread" style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: t.primary }} /> : null}
              <Text numberOfLines={1} style={{ flex: 1, color: t.text, fontWeight: unread ? '700' : '400', fontSize: 15 }}>
                {th.participants.length ? th.participants.join(', ') : m.from?.name || m.from?.address || '(no sender)'}
              </Text>
              {th.messageCount > 1 ? <Text style={{ color: t.muted, fontSize: 12 }}>{th.messageCount}</Text> : null}
              {th.isFlagged ? <Text style={{ color: t.warn }}>★</Text> : null}
              {th.hasAttachments ? <Text style={{ color: t.muted }}>📎</Text> : null}
              <Text style={{ color: t.muted, fontSize: 12 }}>{shortDate(m.receivedAt)}</Text>
            </View>
            <Text numberOfLines={1} style={{ color: t.text, fontWeight: unread ? '600' : '400', marginTop: 2 }}>{m.subject || '(no subject)'}</Text>
            <Text numberOfLines={1} style={{ color: t.muted, fontSize: 13, marginTop: 2 }}>{m.snippet ?? ''}</Text>
            {showMailbox ? (
              <View style={{ flexDirection: 'row', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
                {th.mailboxes.map((mb) => (
                  <Text key={mb} style={{ fontSize: 11, color: t.primary, borderWidth: 1, borderColor: t.primary, borderRadius: 4, paddingHorizontal: 4 }}>{mb}</Text>
                ))}
              </View>
            ) : null}
          </Pressable>
        );
      }}
    />
  );
}
