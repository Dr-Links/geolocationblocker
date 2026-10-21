import { useState } from 'react';
import { Body, Button, Field, Message, Screen, Title } from '../../components/ui';
import { api } from '../../lib/api';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  return (
    <Screen>
      <Title>Reset your password</Title>
      <Body muted style={{ marginBottom: 20 }}>We'll email a reset link to your Gmail address. The link works once and expires in 30 minutes.</Body>
      <Field label="Gmail address" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" autoComplete="email" />
      <Message text={msg?.text} kind={msg?.ok ? 'ok' : 'error'} />
      <Button title="Send reset link" busy={busy} disabled={!email} onPress={async () => {
        setBusy(true);
        try {
          const r = await api.requestPasswordReset(email.trim());
          setMsg({ text: r.message, ok: true });
        } catch (e) {
          setMsg({ text: (e as Error).message, ok: false });
        } finally {
          setBusy(false);
        }
      }} />
    </Screen>
  );
}
