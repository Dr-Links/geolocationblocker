import type { MessageSummary } from '@app/shared';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { api, type MessageListQuery } from '../lib/api';
import { shortDate } from '../lib/format';
import { Message, useTheme } from './ui';

/** Infinite message list used by the unified inbox, folders and flagged views. */
export function MessageList({ query, showMailbox, empty }: { query: MessageListQuery; showMailbox: boolean; empty: string }) {
  const t = useTheme();
  const [items, setItems] = useState<MessageSummary[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify(query);

  const load = useCallback(async (more: boolean) => {
    try {
      const r = await api.messages({ ...query, before: more ? cursor : null });
      setItems((prev) => (more ? [...(prev ?? []), ...r.messages] : r.messages));
      setCursor(r.nextCursor);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, cursor]);

  useFocusEffect(useCallback(() => { load(false); }, [key])); // eslint-disable-line react-hooks/exhaustive-deps

  if (items === null && !error) return <View style={{ flex: 1, justifyContent: 'center' }}><ActivityIndicator color={t.primary} /></View>;
  return (
    <FlatList
      style={{ flex: 1, backgroundColor: t.bg }}
      data={items ?? []}
      keyExtractor={(m) => m.id}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(false); setRefreshing(false); }} />}
      onEndReachedThreshold={0.5}
      onEndReached={async () => {
        if (!cursor || loadingMore) return;
        setLoadingMore(true); await load(true); setLoadingMore(false);
      }}
      ListHeaderComponent={error ? <View style={{ padding: 16 }}><Message text={error} /></View> : undefined}
      ListEmptyComponent={<Text style={{ color: t.muted, padding: 24, textAlign: 'center' }}>{empty}</Text>}
      ListFooterComponent={loadingMore ? <ActivityIndicator style={{ margin: 16 }} color={t.primary} /> : undefined}
      renderItem={({ item: m }) => (
        <Pressable accessibilityRole="button" onPress={() => router.push({ pathname: '/message/[id]', params: { id: m.id } })}
          style={({ pressed }) => ({ backgroundColor: pressed ? t.border : t.surface, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderColor: t.border })}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            {!m.isSeen ? <View accessibilityLabel="Unread" style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: t.primary }} /> : null}
            <Text numberOfLines={1} style={{ flex: 1, color: t.text, fontWeight: m.isSeen ? '400' : '700', fontSize: 15 }}>
              {m.from?.name || m.from?.address || '(no sender)'}
            </Text>
            {m.priority === 'high' ? <Text style={{ color: t.danger, fontWeight: '700' }}>!</Text> : null}
            {m.isFlagged ? <Text accessibilityLabel="Starred" style={{ color: t.warn }}>★</Text> : null}
            {m.hasAttachments ? <Text accessibilityLabel="Has attachments" style={{ color: t.muted }}>📎</Text> : null}
            <Text style={{ color: t.muted, fontSize: 12 }}>{shortDate(m.receivedAt)}</Text>
          </View>
          <Text numberOfLines={1} style={{ color: t.text, fontWeight: m.isSeen ? '400' : '600', marginTop: 2 }}>{m.subject || '(no subject)'}</Text>
          <Text numberOfLines={1} style={{ color: t.muted, fontSize: 13, marginTop: 2 }}>{m.snippet ?? ''}</Text>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
            {showMailbox ? (
              <Text style={{ fontSize: 11, color: t.primary, borderWidth: 1, borderColor: m.mailbox.labelColor ?? t.primary, borderRadius: 4, paddingHorizontal: 4 }}>
                {m.mailbox.displayName || m.mailbox.email}
              </Text>
            ) : null}
            {m.pendingSync ? <Text style={{ fontSize: 11, color: t.warn }}>Syncing change…</Text> : null}
            {!m.onServer ? <Text style={{ fontSize: 11, color: t.muted }}>Deleted on server · stored copy</Text> : null}
          </View>
        </Pressable>
      )}
    />
  );
}
