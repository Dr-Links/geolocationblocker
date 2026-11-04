import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Body, Button, Card, Field, Message, Screen, Title, useTheme } from '../../components/ui';
import { api } from '../../lib/api';

export default function Blocked() {
  const t = useTheme();
  const [list, setList] = useState<Array<{ pattern: string }> | null>(null);
  const [pattern, setPattern] = useState('');
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const load = () => api.blockedSenders().then((r) => setList(r.blocked), (e: Error) => setMsg({ text: e.message, ok: false }));
  useEffect(() => { load(); }, []);
  const add = async () => {
    try {
      const r = await api.blockPattern(pattern);
      setPattern('');
      setMsg({ text: `Blocked ${r.pattern}.`, ok: true });
      load();
    } catch (e) {
      setMsg({ text: (e as Error).message, ok: false });
    }
  };
  return (
    <Screen>
      <Title>Blocked senders</Title>
      <Body muted style={{ marginBottom: 8 }}>New mail from these senders is moved to the Junk folder of your mailbox and you are not notified. Nothing is deleted.</Body>
      <Card>
        <Field label="Address or domain" value={pattern} onChangeText={setPattern} autoCapitalize="none" keyboardType="email-address" placeholder="name@example.com or example.com" />
        <Button title="Block" onPress={add} disabled={!pattern.trim()} />
      </Card>
      <Message text={msg?.text} kind={msg?.ok ? 'ok' : 'error'} />
      <Card>
        {!list ? <Body muted>Loading…</Body> : list.length === 0 ? <Body muted>Nobody blocked.</Body> : list.map((b) => (
          <View key={b.pattern} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 6, borderTopWidth: 1, borderColor: t.border }}>
            <View style={{ flex: 1 }}><Body>{b.pattern.startsWith('@') ? `Everyone at ${b.pattern.slice(1)}` : b.pattern}</Body></View>
            <Button title="Unblock" variant="link" onPress={async () => { await api.unblock(b.pattern).catch(() => undefined); load(); }} />
          </View>
        ))}
      </Card>
    </Screen>
  );
}
