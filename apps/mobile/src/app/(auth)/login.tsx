import { router } from 'expo-router';
import { useState } from 'react';
import { Body, Button, Field, Message, Screen, Title } from '../../components/ui';
import { ApiError, api } from '../../lib/api';
import { useAuth } from '../../lib/auth';

export default function Login() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unverified, setUnverified] = useState(false);
  const [info, setInfo] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true); setError(null); setInfo(null); setUnverified(false);
    try {
      await signIn(email.trim(), password);
      setPassword('');
      router.replace('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
      setUnverified(err instanceof ApiError && err.code === 'email_not_verified');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Title>Email Platform</Title>
      <Body muted style={{ marginBottom: 20 }}>Sign in with the Gmail address you registered with.</Body>
      <Field label="Gmail address" value={email} onChangeText={setEmail} autoCapitalize="none" autoComplete="email" keyboardType="email-address" textContentType="username" />
      <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="password" textContentType="password" onSubmitEditing={submit} />
      <Message text={error} />
      <Message text={info} kind="ok" />
      {unverified && (
        <Button title="Send a new confirmation link" variant="secondary" onPress={async () => {
          const r = await api.resendVerification(email.trim()).catch((e: Error) => ({ message: e.message }));
          setInfo(r.message);
        }} />
      )}
      <Button title="Sign in" onPress={submit} busy={busy} disabled={!email || !password} />
      <Button title="Forgot password?" variant="link" onPress={() => router.push('/forgot-password')} />
      <Button title="Create an account" variant="secondary" onPress={() => router.push('/register')} />
    </Screen>
  );
}
