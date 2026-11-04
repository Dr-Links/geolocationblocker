import type { TemplateDto } from '@app/shared';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, Text, TextInput, View } from 'react-native';
import { Body, Button, Card, Field, Message, Screen, Title, useTheme } from '../../components/ui';
import { api } from '../../lib/api';

export default function Templates() {
  const t = useTheme();
  const [list, setList] = useState<TemplateDto[]>([]);
  const [editing, setEditing] = useState<{ id?: string; kind: 'template' | 'quick_reply'; name: string; subject: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api.templates().then((r) => setList(r.templates), (e: Error) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);
  return (
    <Screen>
      <Title>Templates and quick replies</Title>
      <Message text={error} />
      {editing ? (
        <Card>
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
            {(['quick_reply', 'template'] as const).map((k) => (
              <Pressable key={k} onPress={() => setEditing({ ...editing, kind: k })}
                style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14, borderWidth: 1, borderColor: editing.kind === k ? t.primary : t.border, backgroundColor: editing.kind === k ? t.primary : 'transparent' }}>
                <Text style={{ color: editing.kind === k ? '#fff' : t.text }}>{k === 'quick_reply' ? 'Quick reply' : 'Template'}</Text>
              </Pressable>
            ))}
          </View>
          <Field label="Name" value={editing.name} onChangeText={(name) => setEditing({ ...editing, name })} />
          {editing.kind === 'template' ? <Field label="Subject (optional)" value={editing.subject} onChangeText={(subject) => setEditing({ ...editing, subject })} /> : null}
          <TextInput value={editing.text} onChangeText={(text) => setEditing({ ...editing, text })} multiline placeholder="Text"
            style={{ minHeight: 120, borderWidth: 1, borderColor: t.border, borderRadius: 8, padding: 10, color: t.text, textAlignVertical: 'top' }} />
          <Button title="Save" disabled={!editing.name.trim() || !editing.text.trim()} onPress={() => api.saveTemplate({ ...editing, subject: editing.subject || null })
            .then(() => { setEditing(null); load(); }, (e: Error) => setError(e.message))} />
          <Button title="Cancel" variant="link" onPress={() => setEditing(null)} />
        </Card>
      ) : <Button title="New" onPress={() => setEditing({ kind: 'quick_reply', name: '', subject: '', text: '' })} />}
      {list.map((tp) => (
        <Pressable key={tp.id} onPress={() => setEditing({ id: tp.id, kind: tp.kind, name: tp.name, subject: tp.subject ?? '', text: tp.text })}
          onLongPress={() => Alert.alert('Delete?', tp.name, [{ text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: () => api.deleteTemplate(tp.id).then(load) }])}>
          <Card>
            <Body style={{ fontWeight: '700' }}>{tp.kind === 'quick_reply' ? '⚡ ' : '📋 '}{tp.name}</Body>
            <Body muted numberOfLines={2}>{tp.text}</Body>
          </Card>
        </Pressable>
      ))}
    </Screen>
  );
}
