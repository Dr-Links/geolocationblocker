import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Body, Button, Message, Screen, Title } from '../../components/ui';
import { api } from '../../lib/api';

export default function CheckEmail() {
  const { email } = useLocalSearchParams<{ email?: string }>();
  const [info, setInfo] = useState<string | null>(null);
  return (
    <Screen>
      <Title>Confirm your Gmail address</Title>
      <Body>We sent a confirmation link to {email ?? 'your Gmail address'}. Open it and press "Confirm email address".</Body>
      <Body muted style={{ marginTop: 12 }}>
        After that, your account waits for the administrator's approval. You'll get an email when it's approved, and your one-month access period starts then.
      </Body>
      <Message text={info} kind="ok" />
      {email ? <Button title="Send the link again" variant="secondary" onPress={async () => {
        const r = await api.resendVerification(email).catch((e: Error) => ({ message: e.message }));
        setInfo(r.message);
      }} /> : null}
      <Button title="Go to sign in" onPress={() => router.replace('/login')} />
    </Screen>
  );
}
