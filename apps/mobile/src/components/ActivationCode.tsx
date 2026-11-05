import { useState } from 'react';
import { Body, Button, Card, Field, Message } from './ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime } from '../lib/format';

/** Enter the activation code received from the administrator. One code activates one account, once. */
export function ActivationCodeForm({ title = 'Have an activation code?', hint }: { title?: string; hint?: string }) {
  const { reload, state } = useAuth();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const tz = state.kind === 'signedIn' ? state.account.timezone : undefined;
  const submit = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await api.activateWithCode(code);
      setCode('');
      setMsg({ text: `Activated. Your access runs until ${formatDateTime(r.accessExpiresAt, tz)}.`, ok: true });
      await reload();
    } catch (e) {
      setMsg({ text: (e as Error).message, ok: false });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <Body style={{ fontWeight: '700' }}>{title}</Body>
      {hint ? <Body muted style={{ fontSize: 13, marginBottom: 6 }}>{hint}</Body> : null}
      <Field label="Activation code" value={code} onChangeText={setCode} autoCapitalize="characters" autoCorrect={false} placeholder="AWM-XXXX-XXXX-XXXX-XXXX" onSubmitEditing={submit} />
      <Message text={msg?.text} kind={msg?.ok ? 'ok' : 'error'} />
      <Button title="Activate" busy={busy} disabled={code.replace(/[^A-Za-z0-9]/g, '').length < 16} onPress={submit} />
    </Card>
  );
}
