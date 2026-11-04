import { useEffect, useState } from 'react';
import { Alert, View } from 'react-native';
import { Body, Button, Card, Message, Screen, Title, useTheme } from '../../components/ui';
import { api, type StorageInfo } from '../../lib/api';
import { fileSize } from '../../lib/format';

const RETENTION: Array<[number | null, string]> = [[null, 'Keep everything'], [30, '30 days'], [90, '90 days'], [180, '6 months'], [365, '1 year']];

export default function StorageScreen() {
  const t = useTheme();
  const [s, setS] = useState<StorageInfo | null>(null);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => api.storage().then((r) => setS(r.storage), (e: Error) => setMsg({ text: e.message, ok: false }));
  useEffect(() => { load(); }, []);
  if (!s) return <Screen><Message text={msg?.text} /></Screen>;
  const pct = s.quotaBytes ? Math.min(100, (s.usedBytes / s.quotaBytes) * 100) : 0;
  const color = s.state === 'full' ? t.danger : s.state === 'warning' ? t.warn : t.ok;
  const deletedOnServer = (s.mailboxes ?? []).reduce((a, m) => a + m.deletedOnServer, 0);

  const setRetention = async (days: number | null) => {
    setBusy(true);
    try {
      const r = await api.setStorageSettings(days);
      setS((cur) => (cur ? { ...cur, ...r.storage } : r.storage));
      setMsg({ text: days ? `Saved. Text of messages older than ${days} days is removed here over the next hour; it stays on your mail server and loads when you open the message.` : 'Saved.', ok: true });
    } catch (e) {
      setMsg({ text: (e as Error).message, ok: false });
    } finally {
      setBusy(false);
    }
  };

  const removeDeleted = () => Alert.alert(
    'Remove saved copies?',
    `${deletedOnServer} message${deletedOnServer === 1 ? ' was' : 's were'} already deleted on the mail server. The copies kept here are the only ones left. Removing them cannot be undone.`,
    [{ text: 'Cancel', style: 'cancel' }, { text: 'Remove', style: 'destructive', onPress: async () => {
      try {
        const r = await api.removeDeletedOnServer();
        setMsg({ text: `Removed ${r.removed} message${r.removed === 1 ? '' : 's'}.`, ok: true });
        load();
      } catch (e) {
        setMsg({ text: (e as Error).message, ok: false });
      }
    } }],
  );

  return (
    <Screen>
      <Title>Storage</Title>
      <Card>
        <Body style={{ fontWeight: '700' }}>{fileSize(s.usedBytes)} of {fileSize(s.quotaBytes)} used</Body>
        <View accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: Math.round(pct) }}
          style={{ height: 10, borderRadius: 5, backgroundColor: t.border, marginVertical: 8, overflow: 'hidden' }}>
          <View style={{ width: `${pct}%`, height: '100%', backgroundColor: color }} />
        </View>
        <Body muted style={{ fontSize: 13 }}>Message text {fileSize(s.bodyBytes)} · Files {fileSize(s.fileBytes)} · {s.messageCount} messages</Body>
        {s.state === 'full' ? (
          <Body style={{ color: t.danger, marginTop: 8 }}>Storage is full. New mail still arrives and you are still notified, but its text and attachments are no longer saved here — they are loaded from the mail server when you open them. Nothing is lost on your mail server.</Body>
        ) : s.state === 'warning' ? (
          <Body style={{ color: t.warn, marginTop: 8 }}>You are above 80 %. When storage is full, older text that is still on your mail server is removed here first.</Body>
        ) : null}
      </Card>

      <Card>
        <Body style={{ fontWeight: '700' }}>Keep message text on this platform for</Body>
        <Body muted style={{ fontSize: 13, marginBottom: 6 }}>Older text is removed here but stays on your mail server and loads when you open the message. Messages deleted on the server are never removed automatically.</Body>
        {RETENTION.map(([days, label]) => (
          <Button key={label} title={`${s.bodyRetentionDays === days ? '● ' : '○ '}${label}`} variant="link" disabled={busy} onPress={() => setRetention(days)} />
        ))}
      </Card>

      {(s.mailboxes ?? []).length ? (
        <Card>
          <Body style={{ fontWeight: '700' }}>By mailbox</Body>
          {s.mailboxes!.map((m) => (
            <View key={m.mailboxId} style={{ paddingVertical: 6, borderTopWidth: 1, borderColor: t.border }}>
              <Body>{m.email}</Body>
              <Body muted style={{ fontSize: 13 }}>{m.messages} messages · text {fileSize(m.textBytes)}{m.deletedOnServer ? ` · ${m.deletedOnServer} only kept here` : ''}</Body>
            </View>
          ))}
        </Card>
      ) : null}

      {deletedOnServer ? <Button title={`Remove ${deletedOnServer} messages already deleted on the server`} variant="secondary" onPress={removeDeleted} /> : null}
      <Message text={msg?.text} kind={msg?.ok ? 'ok' : 'error'} />
      <Body muted style={{ fontSize: 12, marginTop: 8 }}>Need more space? Ask the administrator to raise your limit.</Body>
    </Screen>
  );
}
