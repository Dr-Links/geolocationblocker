import { checkPassword, normalizeGmail, PASSWORD_MIN_LENGTH, PASSWORD_PROBLEM_TEXT } from '@app/shared';
import { router } from 'expo-router';
import { useState } from 'react';
import { Body, Button, Field, Message, Screen, Title } from '../../components/ui';
import { api } from '../../lib/api';
import { deviceTimeZone } from '../../lib/format';

export default function Register() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    const g = normalizeGmail(email);
    if (!g.ok) return setError(g.reason === 'not_gmail' ? 'Please use a Gmail address (@gmail.com).' : 'Enter a valid email address.');
    const problem = checkPassword(password, g.display);
    if (problem) return setError(PASSWORD_PROBLEM_TEXT[problem]);
    if (password !== password2) return setError('The two passwords do not match.');
    setBusy(true);
    try {
      await api.register(g.display, password, deviceTimeZone() ?? 'UTC');
      router.replace({ pathname: '/check-email', params: { email: g.display } });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Title>Create your account</Title>
      <Body muted style={{ marginBottom: 20 }}>
        Your Gmail address is only your sign-in name. Emails from the mailboxes you connect later are never sent to it.
        After you confirm it, the administrator will review and approve your account.
      </Body>
      <Field label="Gmail address" value={email} onChangeText={setEmail} autoCapitalize="none" autoComplete="email" keyboardType="email-address" />
      <Field label={`Password (at least ${PASSWORD_MIN_LENGTH} characters)`} value={password} onChangeText={setPassword} secureTextEntry autoComplete="new-password" textContentType="newPassword" />
      <Field label="Repeat password" value={password2} onChangeText={setPassword2} secureTextEntry autoComplete="new-password" />
      <Message text={error} />
      <Button title="Create account" onPress={submit} busy={busy} disabled={!email || !password} />
    </Screen>
  );
}
