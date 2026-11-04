import type { MailboxDto, MessageSummary, SavedSearch, SearchFilters } from '@app/shared';
import { router, Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, FlatList, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Button, Field, Message, useTheme } from '../../components/ui';
import { api } from '../../lib/api';
import { shortDate } from '../../lib/format';

const FOLDERS: Array<[NonNullable<SearchFilters['in']>, string]> = [['any', 'All folders'], ['inbox', 'Inbox'], ['sent', 'Sent'], ['archive', 'Archive'], ['junk', 'Spam'], ['trash', 'Trash']];

export default function Search() {
  const t = useTheme();
  const [f, setF] = useState<SearchFilters>({ in: 'any' });
  const [advanced, setAdvanced] = useState(false);
  const [results, setResults] = useState<MessageSummary[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedSearch[]>([]);
  const [mailboxes, setMailboxes] = useState<MailboxDto[]>([]);
  const [busy, setBusy] = useState(false);
  const [saveName, setSaveName] = useState<string | null>(null);

  useEffect(() => {
    api.savedSearches().then((r) => setSaved(r.savedSearches), () => undefined);
    api.mailboxes().then((r) => setMailboxes(r.mailboxes), () => undefined);
  }, []);

  const run = async (filters = f) => {
    setBusy(true); setError(null);
    try {
      const r = await api.search(filters);
      setResults(r.results);
      setNote(r.note);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const toggle = (k: 'unread' | 'flagged' | 'hasAttachments') => setF({ ...f, [k]: f[k] === '1' ? undefined : '1' });
  const chip = (label: string, on: boolean, onPress: () => void) => (
    <Pressable key={label} accessibilityRole="button" accessibilityState={{ selected: on }} onPress={onPress}
      style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14, borderWidth: 1, borderColor: on ? t.primary : t.border, backgroundColor: on ? t.primary : t.surface }}>
      <Text style={{ color: on ? '#fff' : t.text, fontSize: 13 }}>{label}</Text>
    </Pressable>
  );

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <Stack.Screen options={{ title: 'Search' }} />
      <View style={{ padding: 12, backgroundColor: t.surface, borderBottomWidth: 1, borderColor: t.border }}>
        <TextInput value={f.q ?? ''} onChangeText={(q) => setF({ ...f, q })} placeholder="Search all mailboxes" placeholderTextColor={t.muted}
          returnKeyType="search" onSubmitEditing={() => run()} accessibilityLabel="Search words"
          style={{ borderWidth: 1, borderColor: t.border, borderRadius: 8, padding: 10, color: t.text, fontSize: 16 }} />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, paddingTop: 8 }}>
          {chip('Unread', f.unread === '1', () => toggle('unread'))}
          {chip('★ Starred', f.flagged === '1', () => toggle('flagged'))}
          {chip('📎 Attachments', f.hasAttachments === '1', () => toggle('hasAttachments'))}
          {chip(advanced ? 'Fewer options' : 'More options', advanced, () => setAdvanced(!advanced))}
        </ScrollView>
        {advanced ? (
          <View style={{ paddingTop: 8 }}>
            <Field label="From (name or address)" value={f.from ?? ''} onChangeText={(from) => setF({ ...f, from })} autoCapitalize="none" />
            <Field label="To (name or address)" value={f.to ?? ''} onChangeText={(to) => setF({ ...f, to })} autoCapitalize="none" />
            <Field label="Subject contains" value={f.subject ?? ''} onChangeText={(subject) => setF({ ...f, subject })} />
            <Field label="Received on or after (YYYY-MM-DD)" value={f.dateFrom ?? ''} onChangeText={(dateFrom) => setF({ ...f, dateFrom })} placeholder="2026-01-31" />
            <Field label="Received before (YYYY-MM-DD)" value={f.dateTo ?? ''} onChangeText={(dateTo) => setF({ ...f, dateTo })} />
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, marginBottom: 8 }}>
              {FOLDERS.map(([k, label]) => chip(label, (f.in ?? 'any') === k, () => setF({ ...f, in: k })))}
            </ScrollView>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
              {chip('All mailboxes', !f.mailboxId, () => setF({ ...f, mailboxId: undefined }))}
              {mailboxes.map((m) => chip(m.displayName || m.email, f.mailboxId === m.id, () => setF({ ...f, mailboxId: m.id })))}
            </ScrollView>
          </View>
        ) : null}
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <View style={{ flex: 1 }}><Button title="Search" onPress={() => run()} busy={busy} /></View>
          <View style={{ flex: 1 }}><Button title="Save search" variant="secondary" onPress={() => setSaveName(f.q || f.from || f.subject || 'My search')} /></View>
        </View>
        {saveName !== null ? (
          <View style={{ paddingTop: 8 }}>
            <Field label="Name for this search" value={saveName} onChangeText={setSaveName} />
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <View style={{ flex: 1 }}><Button title="Save" disabled={!saveName.trim()} onPress={() => {
                api.saveSearch(saveName.trim(), f).then(() => { setSaveName(null); return api.savedSearches().then((r) => setSaved(r.savedSearches)); }, (e: Error) => setError(e.message));
              }} /></View>
              <View style={{ flex: 1 }}><Button title="Cancel" variant="link" onPress={() => setSaveName(null)} /></View>
            </View>
          </View>
        ) : null}
        {saved.length ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, paddingTop: 8 }}>
            {saved.map((s) => (
              <Pressable key={s.id} onPress={() => { setF(s.query); run(s.query); }} onLongPress={() => Alert.alert('Delete saved search?', s.name, [
                { text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: () => api.deleteSavedSearch(s.id).then(() => setSaved(saved.filter((x) => x.id !== s.id))) }])}
                style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14, borderWidth: 1, borderColor: t.border }}>
                <Text style={{ color: t.text, fontSize: 13 }}>🔖 {s.name}</Text>
              </Pressable>
            ))}
          </ScrollView>
        ) : null}
      </View>
      <Message text={error} />
      <FlatList
        data={results ?? []}
        keyExtractor={(m) => m.id}
        ListEmptyComponent={results ? (
          <View style={{ padding: 20 }}>
            <Text style={{ color: t.muted, textAlign: 'center' }}>No matches in the mail stored here.</Text>
            {f.q && mailboxes.length ? (
              <Button title="Search older mail on the server" variant="secondary" onPress={async () => {
                setBusy(true);
                let imported = 0;
                for (const m of mailboxes.filter((x) => x.status === 'active' && (!f.mailboxId || x.id === f.mailboxId))) {
                  const r = await api.serverSearch(m.id, f.q!).catch(() => null);
                  imported += r?.imported ?? 0;
                }
                setBusy(false);
                setNote(`${imported} older message(s) found on your mail servers and added.`);
                run();
              }} />
            ) : null}
          </View>
        ) : undefined}
        ListFooterComponent={note && results?.length ? <Text style={{ color: t.muted, fontSize: 12, padding: 12 }}>{note}</Text> : undefined}
        renderItem={({ item: m }) => (
          <Pressable onPress={() => router.push({ pathname: '/message/[id]', params: { id: m.id } })}
            style={{ backgroundColor: t.surface, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderColor: t.border }}>
            <View style={{ flexDirection: 'row' }}>
              <Text numberOfLines={1} style={{ flex: 1, color: t.text, fontWeight: m.isSeen ? '400' : '700' }}>{m.from?.name || m.from?.address}</Text>
              <Text style={{ color: t.muted, fontSize: 12 }}>{shortDate(m.receivedAt)}</Text>
            </View>
            <Text numberOfLines={1} style={{ color: t.text }}>{m.subject || '(no subject)'}</Text>
            <Text style={{ fontSize: 11, color: t.primary }}>{m.mailbox.displayName || m.mailbox.email}</Text>
          </Pressable>
        )}
      />
    </View>
  );
}
