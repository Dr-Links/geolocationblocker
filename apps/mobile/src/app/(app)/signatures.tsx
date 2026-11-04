import type { MailboxDto, SignatureDto } from '@app/shared';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, Text, TextInput, View } from 'react-native';
import { Body, Button, Card, Field, Message, Screen, Title, useTheme } from '../../components/ui';
import { api } from '../../lib/api';

export default function Signatures() {
  const t = useTheme();
  const [list, setList] = useState<SignatureDto[]>([]);
  const [mailboxes, setMailboxes] = useState<MailboxDto[]>([]);
  const [editing, setEditing] = useState<{ id?: string; name: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.signatures().then((r) => setList(r.signatures), (e: Error) => setError(e.message));
    api.mailboxes().then((r) => setMailboxes(r.mailboxes.filter((m) => m.status !== 'disconnected')), () => undefined);
  }, []);
  useEffect(() => { load(); }, [load]);
  return (
    <Screen>
      <Title>Signatures</Title>
      <Message text={error} />
      {editing ? (
        <Card>
          <Field label="Name" value={editing.name} onChangeText={(name) => setEditing({ ...editing, name })} />
          <Text style={{ color: t.text, fontWeight: '600', marginBottom: 6 }}>Signature text</Text>
          <TextInput value={editing.text} onChangeText={(text) => setEditing({ ...editing, text })} multiline
            style={{ minHeight: 100, borderWidth: 1, borderColor: t.border, borderRadius: 8, padding: 10, color: t.text, textAlignVertical: 'top' }} />
          <Button title="Save" disabled={!editing.name.trim()} onPress={() => api.saveSignature(editing).then(() => { setEditing(null); load(); }, (e: Error) => setError(e.message))} />
          <Button title="Cancel" variant="link" onPress={() => setEditing(null)} />
        </Card>
      ) : <Button title="New signature" onPress={() => setEditing({ name: '', text: '' })} />}
      {list.map((s) => (
        <Card key={s.id}>
          <Body style={{ fontWeight: '700' }}>{s.name}</Body>
          <Body muted>{s.text}</Body>
          <Body style={{ marginTop: 8, fontWeight: '600' }}>Default for:</Body>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
            {mailboxes.map((m) => {
              const on = s.defaultFor.includes(m.id);
              return (
                <Pressable key={m.id} onPress={() => api.setDefaultSignature(m.id, on ? null : s.id).then(load)}
                  style={{ paddingHorizontal: 8, paddingVertical: 4, borderRadius: 12, borderWidth: 1, borderColor: on ? t.primary : t.border, backgroundColor: on ? t.primary : 'transparent' }}>
                  <Text style={{ color: on ? '#fff' : t.text, fontSize: 12 }}>{m.email}</Text>
                </Pressable>
              );
            })}
          </View>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <View style={{ flex: 1 }}><Button title="Edit" variant="secondary" onPress={() => setEditing({ id: s.id, name: s.name, text: s.text })} /></View>
            <View style={{ flex: 1 }}><Button title="Delete" variant="link" onPress={() => Alert.alert('Delete signature?', s.name, [
              { text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: () => api.deleteSignature(s.id).then(load) }])} /></View>
          </View>
        </Card>
      ))}
    </Screen>
  );
}
