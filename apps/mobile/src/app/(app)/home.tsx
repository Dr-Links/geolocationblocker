import { router, useFocusEffect } from 'expo-router';
import { useCallback } from 'react';
import { Body, Button, Card, Screen, Title, useTheme } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { daysLeft, formatDateTime } from '../../lib/format';

export default function Home() {
  const { state, reload, signOut } = useAuth();
  const t = useTheme();
  // Re-check status whenever the screen comes back into focus (suspension takes effect immediately).
  useFocusEffect(useCallback(() => { reload(); }, [reload]));
  if (state.kind !== 'signedIn') return null;
  const a = state.account;
  const left = daysLeft(a.accessExpiresAt);
  return (
    <Screen>
      <Title>Welcome</Title>
      <Body muted style={{ marginBottom: 16 }}>{a.email}</Body>
      <Card>
        <Body style={{ fontWeight: '600' }}>Access period</Body>
        <Body>Active until {formatDateTime(a.accessExpiresAt, a.timezone)}</Body>
        {left !== null && left <= 3 ? (
          <Body style={{ color: t.warn, marginTop: 6 }}>Ends in {left} day{left === 1 ? '' : 's'}. Contact the administrator to renew.</Body>
        ) : null}
      </Card>
      <Card>
        <Body style={{ fontWeight: '600' }}>Mailboxes</Body>
        <Body muted>Connecting your business mailboxes arrives in the next update (Milestone 2).</Body>
      </Card>
      <Button title="Signed-in devices" variant="secondary" onPress={() => router.push('/sessions')} />
      <Button title="Change password" variant="secondary" onPress={() => router.push('/change-password')} />
      <Button title="Sign out" variant="link" onPress={signOut} />
    </Screen>
  );
}
