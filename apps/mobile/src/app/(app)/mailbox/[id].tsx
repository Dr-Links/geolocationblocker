import { MAILBOX_STATUS_TEXT, type MailboxDto } from '@app/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { ConnectForm } from '../../../components/ConnectForm';
import { Body, Button, Card, Field, Loading, Message, Screen, Title, useTheme } from '../../../components/ui';
import { api } from '../../../lib/api';
import { formatDateTime } from '../../../lib/format';

type Events = Awaited<ReturnType<typeof api.mailbox>>['events'];

export default function MailboxDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useTheme();
  const [m, setM] = useState<MailboxDto | null>(null);
  const [events, setEvents] = useState<Events>([]);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [reconnect, setReconnect] = useState(false);
  const [disconnect, setDisconnect] = useState<null | 'keep' | 'delete'>(null);
  const [typed, setTyped] = useState('');

  const load = useCallback(() => api.mailbox(id).then((r) => { setM(r.mailbox); setEvents(r.events); }, (e: Error) => setMsg({ text: e.message, ok: false })), [id]);
  useEffect(() => { load(); }, [load]);
  if (!m) return msg ? <Screen><Message text={msg.text} /></Screen> : <Loading />;

  const statusColor = m.status === 'active' ? t.ok : m.status === 'auth_failed' || m.status === 'error' ? t.danger : t.muted;
  return (
    <Screen>
      <Title>{m.displayName || m.email}</Title>
      {m.displayName ? <Body muted>{m.email}</Body> : null}
      <Card>
        <Body style={{ fontWeight: '700', color: statusColor }}>{MAILBOX_STATUS_TEXT[m.status]}</Body>
        {m.statusDetail ? <Body style={{ marginTop: 6 }}>{m.statusDetail}</Body> : null}
        {m.status === 'error' && m.nextRetryAt ? <Body muted>Next automatic retry: {formatDateTime(m.nextRetryAt)}</Body> : null}
        <Body muted style={{ marginTop: 6 }}>Last verified: {formatDateTime(m.lastVerifiedAt)}</Body>
      </Card>
      <Message text={msg?.text} kind={msg?.ok ? 'ok' : 'error'} />

      {m.status !== 'disconnected' && !reconnect ? (
        <>
          {m.status === 'auth_failed' ? <Button title="Enter the new mailbox password" onPress={() => setReconnect(true)} /> : null}
          <Button title="Test connection now" variant="secondary" busy={busy} onPress={async () => {
            setBusy(true); setMsg(null);
            try { await api.testMailbox(m.id); setMsg({ text: 'Connection works.', ok: true }); } catch (e) { setMsg({ text: (e as Error).message, ok: false }); }
            await load(); setBusy(false);
          }} />
          {m.status !== 'auth_failed' ? <Button title="Change password or server settings" variant="secondary" onPress={() => setReconnect(true)} /> : null}
        </>
      ) : null}

      {reconnect ? (
        <Card>
          <Body style={{ fontWeight: '700', marginBottom: 8 }}>Update connection</Body>
          <Body muted style={{ marginBottom: 10 }}>Mailbox passwords are changed at your email provider. Enter the current one here.</Body>
          <ConnectForm mode="reconnect" email={m.email} initialSettings={m.settings}
            submit={(input) => api.updateMailboxConnection(m.id, input)}
            onDone={(updated) => { setM(updated); setReconnect(false); setMsg({ text: 'Reconnected.', ok: true }); load(); }} />
          <Button title="Cancel" variant="link" onPress={() => setReconnect(false)} />
        </Card>
      ) : null}

      {m.settings ? (
        <Card>
          <Body style={{ fontWeight: '700' }}>Server settings</Body>
          <Body muted>Incoming: {m.settings.imap.host}:{m.settings.imap.port} ({m.settings.imap.security === 'tls' ? 'SSL/TLS' : 'STARTTLS'})</Body>
          <Body muted>Outgoing: {m.settings.smtp.host}:{m.settings.smtp.port} ({m.settings.smtp.security === 'tls' ? 'SSL/TLS' : 'STARTTLS'})</Body>
          {m.settings.trustedCertificate.imap || m.settings.trustedCertificate.smtp ? <Body style={{ color: t.warn }}>Uses a certificate you chose to trust manually.</Body> : null}
        </Card>
      ) : null}

      {events.length ? (
        <Card>
          <Body style={{ fontWeight: '700', marginBottom: 6 }}>Recent activity</Body>
          {events.slice(0, 8).map((e, i) => (
            <Body key={i} muted style={{ fontSize: 13 }}>{formatDateTime(e.occurredAt)} · {e.detail ?? e.code}</Body>
          ))}
        </Card>
      ) : null}

      <Card>
        <Body style={{ fontWeight: '700' }}>Disconnect</Body>
        {!disconnect ? (
          <View>
            <Body muted>This never deletes the mailbox or its messages at your email provider.</Body>
            {m.status !== 'disconnected' ? <Button title="Disconnect, keep stored emails" variant="secondary" onPress={() => setDisconnect('keep')} /> : null}
            <Button title="Disconnect and delete stored data" variant="danger" onPress={() => setDisconnect('delete')} />
          </View>
        ) : (
          <View>
            <Body>{disconnect === 'keep'
              ? `Stop syncing ${m.email}. The saved password is deleted; emails already stored here stay readable.`
              : `Delete ${m.email} and everything stored on this platform for it (emails, drafts, attachments, settings). Your other mailboxes are not affected.`}</Body>
            <Field label="Type the mailbox address to confirm" value={typed} onChangeText={setTyped} autoCapitalize="none" autoCorrect={false} />
            <Button title={disconnect === 'keep' ? 'Disconnect' : 'Delete permanently'} variant="danger" disabled={typed.trim().toLowerCase() !== m.email} onPress={async () => {
              try { await api.disconnectMailbox(m.id, disconnect, typed.trim().toLowerCase()); router.replace('/home'); } catch (e) { setMsg({ text: (e as Error).message, ok: false }); }
            }} />
            <Button title="Cancel" variant="link" onPress={() => { setDisconnect(null); setTyped(''); }} />
          </View>
        )}
      </Card>
    </Screen>
  );
}
