import { checkPassword, PASSWORD_MIN_LENGTH, PASSWORD_PROBLEM_TEXT } from '@app/shared';
import { useState } from 'react';
import { Body, Button, Field, Message, Screen } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';

export default function ChangePassword() {
  const { state } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [next2, setNext2] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const email = state.kind === 'signedIn' ? state.account.email : undefined;

  const submit = async () => {
    const problem = checkPassword(next, email);
    if (problem) return setMsg({ text: PASSWORD_PROBLEM_TEXT[problem], ok: false });
    if (next !== next2) return setMsg({ text: 'The two new passwords do not match.', ok: false });
    setBusy(true);
    try {
      const r = await api.changePassword(current, next);
      setMsg({ text: r.message, ok: true });
      setCurrent(''); setNext(''); setNext2('');
    } catch (e) {
      setMsg({ text: (e as Error).message, ok: false });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Body muted style={{ marginBottom: 16 }}>This changes your platform password only. Mailbox passwords are changed with your email provider.</Body>
      <Field label="Current password" value={current} onChangeText={setCurrent} secureTextEntry autoComplete="password" />
      <Field label={`New password (at least ${PASSWORD_MIN_LENGTH} characters)`} value={next} onChangeText={setNext} secureTextEntry autoComplete="new-password" />
      <Field label="Repeat new password" value={next2} onChangeText={setNext2} secureTextEntry autoComplete="new-password" />
      <Message text={msg?.text} kind={msg?.ok ? 'ok' : 'error'} />
      <Button title="Change password" onPress={submit} busy={busy} disabled={!current || !next} />
    </Screen>
  );
}
