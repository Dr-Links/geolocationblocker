import type { MailboxDto, SignatureDto, TemplateDto, UploadDto } from '@app/shared';
import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { randomUUID } from 'expo-crypto';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Modal, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { RichEditor, type RichEditorHandle } from '../../components/RichEditor';
import { Body, Button, Field, Message, Screen, useTheme } from '../../components/ui';
import { ApiError, api } from '../../lib/api';
import { deviceTimeZone, fileSize, formatDateTime } from '../../lib/format';
import { useUndo } from '../../lib/undo';
import { enqueue, isNetworkError } from '../../lib/offline';

type Mode = 'new' | 'reply' | 'reply_all' | 'forward';
const split = (s: string) => s.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
const join = (list: { address: string; name: string | null }[]) => list.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', ');
const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!).replace(/\n/g, '<br>');
const AUTOSAVE_MS = 4000;

export default function Compose() {
  const params = useLocalSearchParams<{ mode?: Mode; sourceMessageId?: string; mailboxId?: string; draftId?: string }>();
  const t = useTheme();
  const { offer } = useUndo();
  const editor = useRef<RichEditorHandle>(null);
  const [mode, setMode] = useState<Mode>(params.mode ?? 'new');
  const [sourceMessageId, setSourceMessageId] = useState<string | undefined>(params.sourceMessageId);
  const [mailboxes, setMailboxes] = useState<MailboxDto[]>([]);
  const [fromId, setFromId] = useState<string | null>(params.mailboxId ?? null);
  const [suggestedFrom, setSuggestedFrom] = useState<string | null>(null);
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [bcc, setBcc] = useState('');
  const [showCc, setShowCc] = useState(false);
  const [subject, setSubject] = useState('');
  const [html, setHtml] = useState('');
  const [text, setText] = useState('');
  const [initialHtml, setInitialHtml] = useState('');
  const [editorKey, setEditorKey] = useState(0);
  const [attachments, setAttachments] = useState<UploadDto[]>([]);
  const [signatures, setSignatures] = useState<SignatureDto[]>([]);
  const [signature, setSignature] = useState<'default' | 'none' | string>('default');
  const [templates, setTemplates] = useState<TemplateDto[]>([]);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [includeOriginal, setIncludeOriginal] = useState(true);
  const [sendAt, setSendAt] = useState<Date | null>(null);
  const [iosPicker, setIosPicker] = useState(false);
  const [quote, setQuote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ id: string; version: number } | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'offline'>('idle');
  const dirty = useRef(false);
  const sent = useRef(false);
  const idempotencyKey = useMemo(() => randomUUID(), []);
  const tz = deviceTimeZone() ?? 'UTC';

  useEffect(() => {
    api.mailboxes().then((r) => {
      const usable = r.mailboxes.filter((m) => m.status === 'active' || m.status === 'error');
      setMailboxes(usable);
      setFromId((cur) => cur ?? usable[0]?.id ?? null);
    }, (e: Error) => setError(e.message));
    api.signatures().then((r) => setSignatures(r.signatures), () => undefined);
    api.templates().then((r) => setTemplates(r.templates), () => undefined);
    if (params.draftId) {
      api.draft(params.draftId).then(({ draft: d }) => {
        setDraft({ id: d.id, version: d.version });
        setFromId(d.mailboxId); setMode(d.mode); setSourceMessageId(d.sourceMessageId ?? undefined);
        setTo(d.to.join(', ')); setCc(d.cc.join(', ')); setBcc(d.bcc.join(', ')); if (d.cc.length || d.bcc.length) setShowCc(true);
        setSubject(d.subject); setText(d.text); setHtml(d.html ?? escapeHtml(d.text));
        setInitialHtml(d.html ?? escapeHtml(d.text)); setEditorKey((k) => k + 1);
        if (d.signatureId) setSignature(d.signatureId);
      }, (e: Error) => setError(e.message));
    } else if (mode !== 'new' && params.sourceMessageId) {
      api.composeSuggestion(params.sourceMessageId, mode).then((s) => {
        setFromId(s.mailboxId); setSuggestedFrom(s.mailboxId);
        setTo(join(s.to)); setCc(join(s.cc)); if (s.cc.length) setShowCc(true);
        setSubject(s.subject); setQuote(s.quoteAttribution);
      }, (e: Error) => setError(e.message));
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const signatureId = signature === 'default' ? undefined : signature === 'none' ? null : signature;
  const payload = () => ({
    mailboxId: fromId!, mode, sourceMessageId: sourceMessageId ?? null, to: split(to), cc: split(cc), bcc: split(bcc),
    subject, text, html: html || null, signatureId: signatureId ?? null, uploadIds: attachments.map((a) => a.id), device: 'phone',
  });

  // Autosave: the first save creates the draft with a device-chosen id (safe to retry), later saves send the version we last saw.
  const save = useCallback(async () => {
    if (!fromId || sent.current || !dirty.current) return;
    dirty.current = false;
    setSaveState('saving');
    try {
      if (!draft) {
        const id = randomUUID();
        const r = await api.createDraft({ id, ...payload() });
        setDraft({ id: r.draft.id, version: r.draft.version });
      } else {
        const r = await api.updateDraft(draft.id, { ...payload(), version: draft.version });
        setDraft({ id: r.draft.id, version: r.draft.version });
      }
      setSaveState('saved');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'conflict' && draft) {
        const current = (e.details as { current?: { version: number; html: string | null; text: string; subject: string } })?.current;
        Alert.alert('Changed on another device', 'This draft was edited somewhere else since you opened it.', [
          { text: 'Keep mine as a copy', onPress: async () => {
            const r = await api.createDraft({ id: randomUUID(), ...payload(), subject: `${subject} (copy)` }).catch(() => null);
            if (r) setDraft({ id: r.draft.id, version: r.draft.version });
          } },
          { text: 'Use the other version', onPress: () => {
            if (!current) return;
            setDraft({ id: draft.id, version: current.version });
            setSubject(current.subject); setText(current.text);
            setHtml(current.html ?? escapeHtml(current.text)); setInitialHtml(current.html ?? escapeHtml(current.text)); setEditorKey((k) => k + 1);
          } },
        ]);
      } else {
        dirty.current = true;
        setSaveState('offline');
      }
    }
  }, [draft, fromId, mode, sourceMessageId, to, cc, bcc, subject, text, html, signature, attachments]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    dirty.current = true;
    const timer = setTimeout(save, AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [to, cc, bcc, subject, html, signature, attachments, fromId]); // eslint-disable-line react-hooks/exhaustive-deps

  const addFiles = async () => {
    const r = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
    if (r.canceled) return;
    setBusy(true);
    for (const a of r.assets) {
      try {
        const up = await api.uploadFile(a.uri, a.name);
        setAttachments((cur) => [...cur, up]);
        if (up.risk === 'dangerous') Alert.alert('Risky file', `"${up.filename}" looks like a program or a disguised file. Many mail servers and recipients will reject it.`);
      } catch (e) {
        setError(`${a.name}: ${(e as Error).message}`);
      }
    }
    setBusy(false);
  };

  const addInlineImage = async () => {
    const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], base64: true, quality: 0.8 });
    if (r.canceled || !r.assets[0]) return;
    const a = r.assets[0];
    setBusy(true);
    try {
      const name = a.fileName ?? 'image.jpg';
      const up = await api.uploadFile(a.uri, name, true);
      editor.current?.insertImage(`data:${a.mimeType ?? 'image/jpeg'};base64,${a.base64 ?? ''}`, up.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const pickSendTime = () => {
    const start = sendAt ?? new Date(Date.now() + 3600_000);
    if (Platform.OS === 'android') {
      DateTimePickerAndroid.open({ value: start, mode: 'date', minimumDate: new Date(), onChange: (ev, date) => {
        if (ev.type !== 'set' || !date) return;
        DateTimePickerAndroid.open({ value: date, mode: 'time', onChange: (ev2, time) => {
          if (ev2.type === 'set' && time) setSendAt(time);
        } });
      } });
    } else setIosPicker(true);
  };

  const submit = async (opts: { confirmVisibleRecipients?: boolean; allowDifferentSender?: boolean } = {}) => {
    if (!fromId) return setError('Connect a mailbox first.');
    setBusy(true); setError(null);
    const input = {
      mailboxId: fromId, mode, sourceMessageId, to: split(to), cc: split(cc), bcc: split(bcc), subject, text, html: html || null,
      idempotencyKey, uploadIds: attachments.map((a) => a.id), signatureId, includeOriginalAttachments: includeOriginal,
      draftId: draft?.id, sendAt: sendAt?.toISOString(), timeZone: sendAt ? tz : undefined, ...opts,
    };
    try {
      const r = await api.send({
        mailboxId: fromId, mode, sourceMessageId, to: split(to), cc: split(cc), bcc: split(bcc), subject, text, html: html || null,
        idempotencyKey, uploadIds: attachments.map((a) => a.id), signatureId, includeOriginalAttachments: includeOriginal,
        draftId: draft?.id, sendAt: sendAt?.toISOString(), timeZone: sendAt ? tz : undefined, ...opts,
      });
      sent.current = true;
      if (!sendAt) offer(r.outbound);
      router.back();
    } catch (e) {
      if (isNetworkError(e)) {
        // Offline: keep it in the phone's outbox. The same idempotency key means it is sent once, never twice.
        await enqueue(idempotencyKey, { kind: 'send', payload: input }, subject || '(no subject)');
        sent.current = true;
        Alert.alert('Saved in your outbox', 'You are offline. The message will be sent when you are back online. It has not been sent yet.');
        router.back();
        return;
      }
      const details = e instanceof ApiError ? (e.details as { requires?: string } | undefined) : undefined;
      if (details?.requires === 'confirmVisibleRecipients') {
        Alert.alert('Recipients will see each other', (e as Error).message, [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Move all to Bcc', onPress: () => { setBcc([bcc, to, cc].filter(Boolean).join(', ')); setTo(''); setCc(''); setShowCc(true); } },
          { text: 'Send as is', style: 'destructive', onPress: () => submit({ ...opts, confirmVisibleRecipients: true }) },
        ]);
      } else if (details?.requires === 'allowDifferentSender') {
        Alert.alert('Different sender', (e as Error).message, [
          { text: 'Cancel', style: 'cancel' }, { text: 'Send from this mailbox', onPress: () => submit({ ...opts, allowDifferentSender: true }) },
        ]);
      } else setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const chip = (label: string, on: boolean, onPress: () => void) => (
    <Pressable key={label} accessibilityRole="radio" accessibilityState={{ selected: on }} onPress={onPress}
      style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14, borderWidth: 1, borderColor: on ? t.primary : t.border, backgroundColor: on ? t.primary : t.surface }}>
      <Text style={{ color: on ? '#fff' : t.text, fontSize: 13 }}>{label}</Text>
    </Pressable>
  );
  const title = mode === 'reply' ? 'Reply' : mode === 'reply_all' ? 'Reply all' : mode === 'forward' ? 'Forward' : 'New message';
  const from = mailboxes.find((m) => m.id === fromId);

  return (
    <Screen>
      <Stack.Screen options={{ title, headerRight: () => (
        <Text style={{ color: t.muted, fontSize: 12 }}>{saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Draft saved' : saveState === 'offline' ? 'Not saved (offline)' : ''}</Text>
      ) }} />
      <Body style={{ fontWeight: '600', marginBottom: 6 }}>From</Body>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        {mailboxes.map((m) => chip(m.displayName ? `${m.displayName} <${m.email}>` : m.email, m.id === fromId, () => setFromId(m.id)))}
      </View>
      {suggestedFrom && fromId !== suggestedFrom ? <Body style={{ color: t.warn, marginBottom: 10 }}>You are not replying from the mailbox that received the original message.</Body> : null}
      {from?.status === 'error' ? <Body style={{ color: t.warn, marginBottom: 10 }}>This mailbox has a connection problem; the message will be sent when it is resolved.</Body> : null}
      <Field label="To" value={to} onChangeText={setTo} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" placeholder="name@example.com, …" />
      {showCc ? (
        <>
          <Field label="Cc" value={cc} onChangeText={setCc} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" />
          <Field label="Bcc (hidden from other recipients)" value={bcc} onChangeText={setBcc} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" />
        </>
      ) : <Button title="Add Cc / Bcc" variant="link" onPress={() => setShowCc(true)} />}
      <Field label="Subject" value={subject} onChangeText={setSubject} />

      <RichEditor key={editorKey} ref={editor} initialHtml={initialHtml} onChange={(h, tx) => { setHtml(h); setText(tx); }} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
        {chip('📎 Attach files', false, addFiles)}
        {chip('🖼 Insert picture', false, addInlineImage)}
        {chip('📋 Templates', false, () => setTemplatesOpen(true))}
      </View>
      {attachments.map((a) => (
        <View key={a.id} style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8, padding: 8, borderRadius: 8, borderWidth: 1, borderColor: a.risk === 'dangerous' ? t.danger : t.border }}>
          <Text style={{ flex: 1, color: t.text }} numberOfLines={1}>📎 {a.filename} · {fileSize(a.sizeBytes)}{a.risk === 'dangerous' ? ' · risky file' : ''}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${a.filename}`} onPress={() => setAttachments((cur) => cur.filter((x) => x.id !== a.id))}>
            <Text style={{ color: t.danger, fontWeight: '700', paddingHorizontal: 8 }}>✕</Text>
          </Pressable>
        </View>
      ))}
      {mode === 'forward' ? (
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>{chip(includeOriginal ? '✓ Include original attachments' : 'Include original attachments', includeOriginal, () => setIncludeOriginal(!includeOriginal))}</View>
      ) : null}

      <Body style={{ fontWeight: '600', marginTop: 14, marginBottom: 6 }}>Signature</Body>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {chip('Mailbox default', signature === 'default', () => setSignature('default'))}
        {chip('None', signature === 'none', () => setSignature('none'))}
        {signatures.map((s) => chip(s.name, signature === s.id, () => setSignature(s.id)))}
      </View>
      {quote ? <Body muted style={{ marginTop: 8, fontSize: 13 }}>{mode === 'forward' ? 'The original message will be included below your text.' : `"${quote}" and the original text will be quoted below.`}</Body> : null}

      <Message text={error} />
      {sendAt ? (
        <Body style={{ marginTop: 10 }}>Scheduled for {formatDateTime(sendAt.toISOString(), tz)} ({tz}). <Text style={{ color: t.primary }} onPress={() => setSendAt(null)}>Send now instead</Text></Body>
      ) : null}
      <Button title={sendAt ? 'Schedule' : 'Send'} busy={busy} disabled={!fromId || !(to || cc || bcc)} onPress={() => {
        if (!subject.trim()) Alert.alert('No subject', 'Send without a subject?', [{ text: 'Cancel', style: 'cancel' }, { text: 'Send', onPress: () => submit() }]);
        else submit();
      }} />
      <Button title={sendAt ? 'Change send time' : 'Send later…'} variant="secondary" onPress={pickSendTime} />
      <Button title="Discard draft" variant="link" onPress={() => Alert.alert('Discard this draft?', undefined, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Discard', style: 'destructive', onPress: async () => { sent.current = true; if (draft) await api.deleteDraft(draft.id).catch(() => undefined); router.back(); } },
      ])} />
      {!sendAt ? <Body muted style={{ marginTop: 4, fontSize: 12, textAlign: 'center' }}>You can undo for a few seconds after pressing Send.</Body> : null}

      <Modal visible={templatesOpen} transparent animationType="slide" onRequestClose={() => setTemplatesOpen(false)}>
        <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: '#0006' }}>
          <View style={{ backgroundColor: t.surface, maxHeight: '70%', borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16 }}>
            <Text style={{ color: t.text, fontWeight: '700', fontSize: 16, marginBottom: 8 }}>Insert template or quick reply</Text>
            <ScrollView>
              {templates.length === 0 ? <Body muted>No templates yet. Create them under Templates on the home screen.</Body> : null}
              {templates.map((tp) => (
                <Pressable key={tp.id} onPress={() => {
                  setTemplatesOpen(false);
                  if (tp.kind === 'template' && tp.subject && !subject) setSubject(tp.subject);
                  editor.current?.insertText(tp.text);
                }} style={{ paddingVertical: 12, borderBottomWidth: 1, borderColor: t.border }}>
                  <Text style={{ color: t.text, fontWeight: '600' }}>{tp.kind === 'quick_reply' ? '⚡ ' : '📋 '}{tp.name}</Text>
                  <Text style={{ color: t.muted }} numberOfLines={1}>{tp.text}</Text>
                </Pressable>
              ))}
            </ScrollView>
            <Button title="Close" variant="link" onPress={() => setTemplatesOpen(false)} />
          </View>
        </View>
      </Modal>
      {iosPicker ? (
        <Modal transparent animationType="slide" onRequestClose={() => setIosPicker(false)}>
          <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: '#0006' }}>
            <View style={{ backgroundColor: t.surface, padding: 16 }}>
              <DateTimePicker value={sendAt ?? new Date(Date.now() + 3600_000)} mode="datetime" minimumDate={new Date()} onChange={(_e, d) => d && setSendAt(d)} />
              <Button title="Done" onPress={() => setIosPicker(false)} />
            </View>
          </View>
        </Modal>
      ) : null}
    </Screen>
  );
}
