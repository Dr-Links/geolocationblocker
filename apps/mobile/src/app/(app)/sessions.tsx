import type { SessionInfo } from '@app/shared';
import { useCallback, useEffect, useState } from 'react';
import { Alert, View } from 'react-native';
import { Body, Button, Card, Message, Screen } from '../../components/ui';
import { api } from '../../lib/api';
import { formatDateTime } from '../../lib/format';

export default function Sessions() {
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api.sessions().then((r) => setSessions(r.sessions), (e: Error) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);

  const revoke = (s: SessionInfo) =>
    Alert.alert('Sign out device?', `${s.deviceName ?? s.platform ?? 'This device'} will need to sign in again.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: () => api.revokeSession(s.id).then(load, (e: Error) => setError(e.message)) },
    ]);

  return (
    <Screen>
      <Message text={error} />
      {sessions?.map((s) => (
        <Card key={s.id}>
          <Body style={{ fontWeight: '600' }}>{s.deviceName ?? s.platform ?? 'Unknown device'}{s.current ? ' (this device)' : ''}</Body>
          <Body muted>Signed in {formatDateTime(s.createdAt)}</Body>
          <Body muted>Last active {formatDateTime(s.lastUsedAt)}</Body>
          {!s.current && <View style={{ marginTop: 4 }}><Button title="Sign out this device" variant="secondary" onPress={() => revoke(s)} /></View>}
        </Card>
      ))}
    </Screen>
  );
}
