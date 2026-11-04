import type { DraftDto } from '@app/shared';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, Pressable } from 'react-native';
import { Body, Card, Message, Screen, Title } from '../../components/ui';
import { api } from '../../lib/api';
import { formatDateTime } from '../../lib/format';

export default function Drafts() {
  const [drafts, setDrafts] = useState<DraftDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api.drafts().then((r) => setDrafts(r.drafts), (e: Error) => setError(e.message)), []);
  useFocusEffect(useCallback(() => { load(); }, [load]));
  return (
    <Screen>
      <Title>Drafts</Title>
      <Body muted style={{ marginBottom: 12 }}>Drafts are saved on the server, so they are available on all your devices.</Body>
      <Message text={error} />
      {drafts?.length === 0 ? <Body muted>No drafts.</Body> : null}
      {drafts?.map((d) => (
        <Pressable key={d.id} onPress={() => router.push({ pathname: '/compose', params: { draftId: d.id } })}
          onLongPress={() => Alert.alert('Delete draft?', d.subject || '(no subject)', [
            { text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: () => api.deleteDraft(d.id).then(load) }])}>
          <Card>
            <Body style={{ fontWeight: '700' }}>{d.subject || '(no subject)'}</Body>
            <Body muted numberOfLines={1}>To: {d.to.join(', ') || '—'}</Body>
            <Body muted style={{ fontSize: 12 }}>Saved {formatDateTime(d.updatedAt)}{d.updatedByDevice ? ` on ${d.updatedByDevice}` : ''}</Body>
          </Card>
        </Pressable>
      ))}
    </Screen>
  );
}
