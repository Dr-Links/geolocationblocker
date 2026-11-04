import { MAILBOX_STATUS_TEXT, type MailboxDto } from '@app/shared';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable } from 'react-native';
import { api, type StorageInfo } from '../../lib/api';
import { Body, Button, Card, Screen, Title, useTheme } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { InstallApp } from '../../components/InstallApp';
import { daysLeft, formatDateTime } from '../../lib/format';

export default function Home() {
  const { state, reload, signOut } = useAuth();
  const t = useTheme();
  // Re-check status whenever the screen comes back into focus (suspension takes effect immediately).
  const [mailboxes, setMailboxes] = useState<MailboxDto[] | null>(null);
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  useFocusEffect(useCallback(() => {
    reload();
    api.storage().then((r) => setStorage(r.storage), () => undefined);
    api.mailboxes().then((r) => setMailboxes(r.mailboxes), () => undefined);
  }, [reload]));
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
      {storage && storage.state !== 'ok' ? (
        <Pressable accessibilityRole="button" onPress={() => router.push('/storage')}>
          <Card>
            <Body style={{ fontWeight: '600', color: storage.state === 'full' ? t.danger : t.warn }}>
              {storage.state === 'full' ? 'Your storage is full' : `Storage ${Math.floor((storage.usedBytes / storage.quotaBytes) * 100)} % used`}
            </Body>
            <Body muted style={{ fontSize: 13 }}>
              {storage.state === 'full' ? 'New mail still arrives, but its text is no longer saved here: it is loaded from the mail server when you open it. Tap to free up space.' : 'Tap to see what uses space.'}
            </Body>
          </Card>
        </Pressable>
      ) : null}
      <Button title="Open all inboxes" onPress={() => router.push('/inbox')} />
      <Button title="Write a new message" variant="secondary" onPress={() => router.push('/compose')} />
      <Button title="Outbox (scheduled / waiting / problems)" variant="secondary" onPress={() => router.push('/outbox')} />
      <Button title="Drafts" variant="secondary" onPress={() => router.push('/drafts')} />
      <Button title="Reminders" variant="link" onPress={() => router.push('/reminders')} />
      <Button title="Blocked senders" variant="link" onPress={() => router.push('/blocked')} />
      <Button title="Storage" variant="link" onPress={() => router.push('/storage')} />
      <Button title="Notifications" variant="link" onPress={() => router.push('/notifications')} />
      <Button title="Signatures" variant="link" onPress={() => router.push('/signatures')} />
      <Button title="Templates and quick replies" variant="link" onPress={() => router.push('/templates')} />
      <Card>
        <Body style={{ fontWeight: '600', marginBottom: 6 }}>Mailboxes</Body>
        {mailboxes === null ? <Body muted>Loading…</Body> : mailboxes.length === 0 ? <Body muted>No mailboxes connected yet.</Body> : null}
        {mailboxes?.map((m) => (
          <Pressable key={m.id} accessibilityRole="button" onPress={() => router.push({ pathname: '/mailbox/[id]', params: { id: m.id } })}
            style={{ paddingVertical: 10, borderTopWidth: 1, borderColor: t.border }}>
            <Body style={{ fontWeight: '600' }}>{m.displayName || m.email}</Body>
            <Body style={{ fontSize: 13, color: m.status === 'active' ? t.ok : m.status === 'disconnected' || m.status === 'paused_account' ? t.muted : t.danger }}>
              {m.displayName ? `${m.email} · ` : ''}{MAILBOX_STATUS_TEXT[m.status]}
            </Body>
          </Pressable>
        ))}
        <Button title="Add mailbox" onPress={() => router.push('/mailbox-add')} />
      </Card>
      <InstallApp />
      <Button title="Signed-in devices" variant="secondary" onPress={() => router.push('/sessions')} />
      <Button title="Change password" variant="secondary" onPress={() => router.push('/change-password')} />
      <Button title="Sign out" variant="link" onPress={signOut} />
    </Screen>
  );
}
