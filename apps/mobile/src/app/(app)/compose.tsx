import type { MailboxDto } from '@app/shared';
import { randomUUID } from 'expo-crypto';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, Text, TextInput, View } from 'react-native';
import { Body, Button, Field, Message, Screen, useTheme } from '../../components/ui';
import { ApiError, api } from '../../lib/api';
import { useUndo } from '../../lib/undo';

type Mode = 'new' | 'reply' | 'reply_all' | 'forward';
const split = (s: string) => s.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
const join = (list: { address: string; name: string | null }[]) => list.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', ');

export default function Compose() {
  const params = useLocalSearchParams<{ mode?: Mode; sourceMessageId?: string; mailboxId?: string }>();
  const mode: Mode = params.mode ?? 'new';
  const t = useTheme();
  const { offer } = useUndo();
  const [mailboxes, setMailboxes] = useState<MailboxDto[]>([]);
  const [fromId, setFromId] = useState<string | null>(params.mailboxId ?? null);
  const [suggestedFrom, setSuggestedFrom] = useState<string | null>(null);
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [bcc, setBcc] = useState('');
  const [showCc, setShowCc] = useState(false);
  const [subject, setSubject] = useState('');
  const [text, setText] = useState('');
  const [quote, setQuote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One key per compose screen: pressing Send again (or a network retry) never creates a second message.
  const idempotencyKey = useMemo(() => randomUUID(), []);

  useEffect(() => {
    api.mailboxes().then((r) => {
      const usable = r.mailboxes.filter((m) => m.status === 'active' || m.status === 'error');
      setMailboxes(usable);
      setFromId((cur) => cur ?? usable[0]?.id ?? null);
    }, (e: Error) => setError(e.message));
    if (mode !== 'new' && params.sourceMessageId) {
      api.composeSuggestion(params.sourceMessageId, mode).then((s) => {
        setFromId(s.mailboxId);
        setSuggestedFrom(s.mailboxId);
        setTo(join(s.to));
        setCc(join(s.cc));
        if (s.cc.length) setShowCc(true);
        setSubject(s.subject);
        setQuote(s.quoteAttribution);
      }, (e: Error) => setError(e.message));
    }
  }, [mode, params.sourceMessageId]);

  const from = mailboxes.find((m) => m.id === fromId);

  const submit = async (opts: { confirmVisibleRecipients?: boolean; allowDifferentSender?: boolean; moveToBcc?: boolean } = {}) => {
    if (!fromId) return setError('Connect a mailbox first.');
    setBusy(true); setError(null);
    let toList = split(to), ccList = split(cc), bccList = split(bcc);
    if (opts.moveToBcc) { bccList = [...bccList, ...toList, ...ccList]; toList = []; ccList = []; }
    try {
      const r = await api.send({
        mailboxId: fromId, mode, sourceMessageId: params.sourceMessageId, to: toList, cc: ccList, bcc: bccList, subject, text, idempotencyKey,
        confirmVisibleRecipients: opts.confirmVisibleRecipients || opts.moveToBcc, allowDifferentSender: opts.allowDifferentSender,
      });
      offer(r.outbound);
      router.back();
    } catch (e) {
      const details = e instanceof ApiError ? (e.details as { requires?: string } | undefined) : undefined;
      if (details?.requires === 'confirmVisibleRecipients') {
        Alert.alert('Recipients will see each other', (e as Error).message, [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Move all to Bcc', onPress: () => { setBcc([bcc, to, cc].filter(Boolean).join(', ')); setTo(''); setCc(''); submit({ ...opts, moveToBcc: true }); } },
          { text: 'Send as is', style: 'destructive', onPress: () => submit({ ...opts, confirmVisibleRecipients: true }) },
        ]);
      } else if (details?.requires === 'allowDifferentSender') {
        Alert.alert('Different sender', (e as Error).message, [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Send from this mailbox', onPress: () => submit({ ...opts, allowDifferentSender: true }) },
        ]);
      } else {
        setError((e as Error).message);
      }
    } finally {
      setBusy(false);
    }
  };

  const title = mode === 'reply' ? 'Reply' : mode === 'reply_all' ? 'Reply all' : mode === 'forward' ? 'Forward' : 'New message';
  return (
    <Screen>
      <Stack.Screen options={{ title }} />
      <Body style={{ fontWeight: '600', marginBottom: 6 }}>From</Body>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        {mailboxes.map((m) => (
          <Pressable key={m.id} accessibilityRole="radio" accessibilityState={{ selected: m.id === fromId }} onPress={() => setFromId(m.id)}
            style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14, borderWidth: 1, borderColor: m.id === fromId ? t.primary : t.border, backgroundColor: m.id === fromId ? t.primary : t.surface }}>
            <Text style={{ color: m.id === fromId ? '#fff' : t.text, fontSize: 13 }}>{m.displayName ? `${m.displayName} <${m.email}>` : m.email}</Text>
          </Pressable>
        ))}
      </View>
      {suggestedFrom && fromId !== suggestedFrom ? (
        <Body style={{ color: t.warn, marginBottom: 10 }}>You are not replying from the mailbox that received the original message.</Body>
      ) : null}
      {from?.status === 'error' ? <Body style={{ color: t.warn, marginBottom: 10 }}>This mailbox has a connection problem; the message will be sent when it is resolved.</Body> : null}
      <Field label="To" value={to} onChangeText={setTo} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" placeholder="name@example.com, …" />
      {showCc ? (
        <>
          <Field label="Cc" value={cc} onChangeText={setCc} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" />
          <Field label="Bcc (hidden from other recipients)" value={bcc} onChangeText={setBcc} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" />
        </>
      ) : <Button title="Add Cc / Bcc" variant="link" onPress={() => setShowCc(true)} />}
      <Field label="Subject" value={subject} onChangeText={setSubject} />
      <Text style={{ color: t.text, fontWeight: '600', marginBottom: 6 }}>Message</Text>
      <TextInput value={text} onChangeText={setText} multiline textAlignVertical="top" accessibilityLabel="Message"
        style={{ minHeight: 200, borderWidth: 1, borderColor: t.border, borderRadius: 8, padding: 12, color: t.text, backgroundColor: t.surface, fontSize: 16 }} />
      {quote ? <Body muted style={{ marginTop: 8, fontSize: 13 }}>{mode === 'forward' ? 'The original message will be included below.' : `"${quote}" and the original text will be quoted below.`}</Body> : null}
      <Message text={error} />
      <Button title="Send" onPress={() => {
        if (!subject.trim()) {
          Alert.alert('No subject', 'Send without a subject?', [{ text: 'Cancel', style: 'cancel' }, { text: 'Send', onPress: () => submit() }]);
        } else submit();
      }} busy={busy} disabled={!fromId || !(to || cc || bcc)} />
      <Body muted style={{ marginTop: 8, fontSize: 12, textAlign: 'center' }}>You can undo for a few seconds after pressing Send.</Body>
    </Screen>
  );
}
