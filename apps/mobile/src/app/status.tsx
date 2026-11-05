import { Redirect } from 'expo-router';
import { useState } from 'react';
import { Body, Button, Card, Loading, Screen, Title, useTheme } from '../components/ui';
import { useAuth } from '../lib/auth';
import { formatDateTime } from '../lib/format';
import { ActivationCodeForm } from '../components/ActivationCode';

const COPY: Record<string, { title: string; body: string }> = {
  pending: {
    title: 'Waiting for approval',
    body: 'Your email address is confirmed. Enter the activation code you received from the administrator below, or wait for the administrator to approve your account (you will get an email at your Gmail address).',
  },
  expired: {
    title: 'Your access period has ended',
    body: 'Your account is paused because its access period ended. Nothing has been deleted. Enter a new activation code below, or contact the administrator to renew; everything will be as you left it.',
  },
  suspended: {
    title: 'Account suspended',
    body: 'The administrator has suspended your account. Your data has not been deleted. Contact the administrator to restore access.',
  },
  rejected: {
    title: 'Registration not approved',
    body: 'Your registration was not approved. Contact the administrator if you think this is a mistake.',
  },
};

export default function Status() {
  const { state, reload, signOut } = useAuth();
  const t = useTheme();
  const [busy, setBusy] = useState(false);
  if (state.kind === 'loading') return <Loading />;
  if (state.kind !== 'signedIn') return <Redirect href="/" />;
  const a = state.account;
  if (a.displayStatus === 'active') return <Redirect href="/home" />;
  const copy = COPY[a.displayStatus] ?? COPY.suspended!;
  return (
    <Screen>
      <Title>{copy.title}</Title>
      <Card>
        <Body>{copy.body}</Body>
        {a.displayStatus === 'expired' && a.accessExpiresAt ? (
          <Body muted style={{ marginTop: 10 }}>Ended on {formatDateTime(a.accessExpiresAt, a.timezone)}.</Body>
        ) : null}
      </Card>
      {a.displayStatus === 'pending' || a.displayStatus === 'expired' ? <ActivationCodeForm title={a.displayStatus === 'expired' ? 'Renew with a code' : 'Activate with a code'} /> : null}
      <Body muted>Signed in as {a.email}</Body>
      <Button title="Check again" busy={busy} onPress={async () => { setBusy(true); await reload(); setBusy(false); }} />
      <Button title="Sign out" variant="link" onPress={signOut} />
      <Body muted style={{ marginTop: 16, color: t.muted, fontSize: 13 }}>Status: {a.displayStatus}</Body>
    </Screen>
  );
}
