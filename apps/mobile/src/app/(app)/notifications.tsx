import type { MailboxDto } from '@app/shared';
import { useEffect, useState } from 'react';
import { Switch, View } from 'react-native';
import { Body, Button, Card, Message, Screen, Title } from '../../components/ui';
import { api } from '../../lib/api';
import { registerForPush } from '../../lib/push';

type Prefs = Awaited<ReturnType<typeof api.notificationPreferences>>;

export default function NotificationSettings() {
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [mailboxes, setMailboxes] = useState<MailboxDto[]>([]);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  useEffect(() => {
    api.notificationPreferences().then(setPrefs, (e: Error) => setMsg({ text: e.message, ok: false }));
    api.mailboxes().then((r) => setMailboxes(r.mailboxes.filter((m) => m.status !== 'disconnected')), () => undefined);
  }, []);
  if (!prefs) return <Screen><Message text={msg?.text} /></Screen>;
  const save = (next: Prefs) => {
    setPrefs(next);
    api.setNotificationPreferences(next).then(() => setMsg({ text: 'Saved.', ok: true }), (e: Error) => setMsg({ text: e.message, ok: false }));
  };
  const row = (label: string, value: boolean, onChange: (v: boolean) => void) => (
    <View key={label} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 8 }}>
      <View style={{ flex: 1 }}><Body>{label}</Body></View>
      <Switch value={value} onValueChange={onChange} accessibilityLabel={label} />
    </View>
  );
  const d = prefs.defaults;
  return (
    <Screen>
      <Title>Notifications</Title>
      <Body muted style={{ marginBottom: 12 }}>Notifications only say which mailbox received mail, e.g. "New email received at sales@company.com" — never the sender or the subject.</Body>
      <Card>
        {row('New mail', d.newMail, (v) => save({ ...prefs, defaults: { ...d, newMail: v } }))}
        {row('Messages that could not be sent', d.sendProblems, (v) => save({ ...prefs, defaults: { ...d, sendProblems: v } }))}
        {row('Mailbox needs attention (e.g. new password)', d.mailboxProblems, (v) => save({ ...prefs, defaults: { ...d, mailboxProblems: v } }))}
        {row('Follow-up reminders', d.reminders, (v) => save({ ...prefs, defaults: { ...d, reminders: v } }))}
      </Card>
      {d.newMail && mailboxes.length ? (
        <Card>
          <Body style={{ fontWeight: '700' }}>New mail, per mailbox</Body>
          {mailboxes.map((m) => {
            const own = prefs.mailboxes.find((x) => x.mailboxId === m.id);
            const on = own ? own.newMail : true;
            return row(m.email, on, (v) => save({ ...prefs, mailboxes: [...prefs.mailboxes.filter((x) => x.mailboxId !== m.id), { mailboxId: m.id, newMail: v }] }));
          })}
        </Card>
      ) : null}
      <Message text={msg?.text} kind={msg?.ok ? 'ok' : 'error'} />
      <Button title="Re-check notification permission" variant="secondary" onPress={async () => {
        const r = await registerForPush();
        setMsg({ text: r === 'registered' ? 'This phone will receive notifications.' : r === 'denied' ? 'Notifications are turned off for this app in your phone settings.' : 'Notifications are not available in this build.', ok: r === 'registered' });
      }} />
    </Screen>
  );
}
