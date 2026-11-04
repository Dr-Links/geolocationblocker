import { OUTBOUND_STATUS_TEXT, type OutboundDto } from '@app/shared';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, View } from 'react-native';
import { Body, Button, Card, Message, Screen, Title, useTheme } from '../../components/ui';
import { api } from '../../lib/api';
import { formatDateTime } from '../../lib/format';

export default function Outbox() {
  const t = useTheme();
  const [items, setItems] = useState<OutboundDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api.outbox('outbox').then((r) => setItems(r.outbound), (e: Error) => setError(e.message)), []);
  useFocusEffect(useCallback(() => { load(); const i = setInterval(load, 5000); return () => clearInterval(i); }, [load]));

  const retry = (o: OutboundDto) => {
    if (o.status === 'uncertain') {
      Alert.alert('Send again?', 'This message may already have been delivered. Sending again could deliver it twice.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Send again', style: 'destructive', onPress: () => api.retrySend(o.id, true).then(load, (e: Error) => setError(e.message)) },
      ]);
    } else api.retrySend(o.id).then(load, (e: Error) => setError(e.message));
  };

  return (
    <Screen>
      <Title>Outbox</Title>
      <Message text={error} />
      {items?.length === 0 ? <Body muted>Nothing waiting. Sent messages appear in Sent.</Body> : null}
      {items?.map((o) => {
        const problem = ['failed', 'uncertain', 'paused_suspended'].includes(o.status);
        return (
          <Card key={o.id}>
            <Body style={{ fontWeight: '700' }}>{o.subject || '(no subject)'}</Body>
            <Body muted>To {o.toSummary ?? `${o.recipientCount} recipient(s)`} · from {o.mailbox.email}</Body>
            <Body style={{ color: problem ? t.danger : t.text, marginTop: 4 }}>{OUTBOUND_STATUS_TEXT[o.status]}</Body>
            {o.lastErrorMessage ? <Body muted style={{ fontSize: 13 }}>{o.lastErrorMessage}</Body> : null}
            {o.status === 'queued' && o.nextAttemptAt ? <Body muted style={{ fontSize: 13 }}>Next try: {formatDateTime(o.nextAttemptAt)}</Body> : null}
            {o.status === 'scheduled' && o.scheduledAt ? <Body muted style={{ fontSize: 13 }}>Will be sent {formatDateTime(o.scheduledAt)}</Body> : null}
            {o.status === 'scheduled' ? (
              <View>
                <Button title="Edit" variant="secondary" onPress={() => api.editOutbound(o.id).then((r) => router.push({ pathname: '/compose', params: { draftId: r.draft.id } }), (e: Error) => setError(e.message))} />
                <Button title="Cancel sending" variant="link" onPress={() => api.discardSend(o.id).then(load, (e: Error) => setError(e.message))} />
              </View>
            ) : null}
            {problem ? (
              <View>
                <Button title={o.status === 'paused_suspended' ? 'Send now' : 'Try again'} variant="secondary" onPress={() => retry(o)} />
                <Button title="Discard" variant="link" onPress={() => api.discardSend(o.id).then(load, (e: Error) => setError(e.message))} />
              </View>
            ) : null}
          </Card>
        );
      })}
    </Screen>
  );
}
