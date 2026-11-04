import type { FolderDto, MessageAction, MessageDetail } from '@app/shared';
import * as Clipboard from 'expo-clipboard';
import { File, Paths } from 'expo-file-system';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Linking, Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { Body, Button, Message, useTheme } from '../../../components/ui';
import { api, authHeaders } from '../../../lib/api';
import { randomUUID } from 'expo-crypto';
import { cached, enqueue, isNetworkError } from '../../../lib/offline';
import { fileSize, formatDateTime } from '../../../lib/format';

/** Wraps sanitised email HTML in a document whose Content-Security-Policy forbids scripts and (by default) remote loads. */
function emailDocument(html: string, allowRemote: boolean, dark: boolean) {
  const img = allowRemote ? 'img-src data: https: http:;' : 'img-src data:;';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; ${img} style-src 'unsafe-inline'; font-src data:;">
<style>body{margin:0;padding:12px 16px;font-family:-apple-system,Roboto,sans-serif;font-size:15px;line-height:1.45;word-wrap:break-word;
${dark ? 'background:#0f1720;color:#e4e7eb;' : 'background:#fff;color:#1f2933;'}}img{max-width:100%;height:auto}table{max-width:100%}
img[data-blocked-src]{display:inline-block;min-width:24px;min-height:12px;background:#9aa5b133}</style></head><body>${html}</body></html>`;
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export default function MessageView() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useTheme();
  const dark = t.bg === '#0f1720';
  const [m, setM] = useState<MessageDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [remote, setRemote] = useState(false);
  const [busy, setBusy] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [folders, setFolders] = useState<FolderDto[]>([]);
  const [details, setDetails] = useState(false);

  const load = useCallback(async (allowRemote = remote) => {
    try {
      const { value: r, stale } = await cached(`message:${id}`, () => api.message(id, allowRemote));
      setM(r.message);
      if (stale) setNote('Offline — this is the copy saved on your phone.');
      return r.message;
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  }, [id, remote]);

  useEffect(() => {
    (async () => {
      const msg = await load(false);
      if (msg && !msg.isSeen && msg.onServer) {
        const opId = randomUUID();
        api.messageAction(msg.id, 'mark_read', { clientOpId: opId }).then((r) => r.message && setM((cur) => (cur ? { ...cur, ...r.message } : cur)), (e) => {
          if (isNetworkError(e)) enqueue(opId, { kind: 'action', payload: { messageId: msg.id, action: 'mark_read', extra: {} } }, 'Mark as read').catch(() => undefined);
        });
      }
    })();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (action: MessageAction, extra: { folderId?: string; confirm?: boolean } = {}) => {
    setBusy(true); setNote(null);
    const opId = randomUUID();
    try {
      const r = await api.messageAction(id, action, { ...extra, clientOpId: opId });
      if (['archive', 'trash', 'spam', 'move', 'delete_forever', 'not_spam'].includes(action) && r.appliedOnServer) {
        router.back();
        return;
      }
      if (r.message) setM((cur) => (cur ? { ...cur, ...r.message } : cur));
      if (r.note) setNote(r.note);
    } catch (e) {
      if (isNetworkError(e)) {
        // Offline: remember the action (applied once when back online) and show it right away for flags.
        await enqueue(opId, { kind: 'action', payload: { messageId: id, action, extra } }, `${action.replace('_', ' ')}: ${m?.subject ?? ''}`);
        if (action === 'mark_read' || action === 'mark_unread' || action === 'flag' || action === 'unflag') {
          setM((cur) => (cur ? { ...cur, pendingSync: true, isSeen: action === 'mark_read' ? true : action === 'mark_unread' ? false : cur.isSeen,
            isFlagged: action === 'flag' ? true : action === 'unflag' ? false : cur.isFlagged } : cur));
        }
        setNote('Offline — this change will be sent when you are back online.');
      } else setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const openLink = (url: string) => {
    if (url.startsWith('about:')) return;
    Alert.alert('Open link?', `This link goes to:\n\n${url}\n\nOnly open links you trust.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Copy', onPress: () => Clipboard.setStringAsync(url) },
      { text: 'Open', onPress: () => Linking.openURL(url).catch(() => undefined) },
    ]);
  };

  const download = async (a: MessageDetail['attachments'][number]) => {
    const go = async () => {
      setBusy(true);
      try {
        const safe = a.filename.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) || 'attachment';
        const target = new File(Paths.cache, `${Date.now()}-${safe}`);
        const file = await File.downloadFileAsync(api.attachmentUrl(id, a.id), target, { headers: await authHeaders(), idempotent: true });
        if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(file.uri, { mimeType: a.mimeType, dialogTitle: a.filename });
      } catch (e) {
        setNote(`Download failed: ${(e as Error).message}`);
      } finally {
        setBusy(false);
      }
    };
    if (a.risk === 'dangerous') {
      Alert.alert('Potentially dangerous file', `"${a.filename}" is a type of file that can harm your device (for example a program or script). Only open it if you were expecting it from someone you trust.`,
        [{ text: 'Cancel', style: 'cancel' }, { text: 'Download anyway', style: 'destructive', onPress: go }]);
    } else go();
  };

  if (error) return <View style={{ flex: 1, padding: 20, backgroundColor: t.bg }}><Message text={error} /></View>;
  if (!m) return <View style={{ flex: 1, justifyContent: 'center', backgroundColor: t.bg }}><ActivityIndicator color={t.primary} /></View>;

  const inTrash = m.folders.some((f) => f.specialUse === 'trash');
  const inJunk = m.folders.some((f) => f.specialUse === 'junk');
  const authFail = m.authResults && (m.authResults.dmarc === 'fail' || m.authResults.spf === 'fail' || m.authResults.dkim === 'fail');
  const barBtn = (label: string, onPress: () => void, a11y?: string) => (
    <Pressable key={label} accessibilityRole="button" accessibilityLabel={a11y ?? label} disabled={busy || !m.onServer} onPress={onPress}
      style={{ paddingHorizontal: 10, paddingVertical: 8, opacity: busy || !m.onServer ? 0.5 : 1 }}>
      <Text style={{ color: t.primary, fontWeight: '600' }}>{label}</Text>
    </Pressable>
  );
  const people = (list: { address: string; name: string | null }[]) => list.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', ');

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <Stack.Screen options={{ title: m.mailbox.displayName || m.mailbox.email }} />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0, backgroundColor: t.surface, borderBottomWidth: 1, borderColor: t.border }}>
        {barBtn('Reply', () => router.push({ pathname: '/compose', params: { mode: 'reply', sourceMessageId: m.id } }))}
        {barBtn('Reply all', () => router.push({ pathname: '/compose', params: { mode: 'reply_all', sourceMessageId: m.id } }))}
        {barBtn('Forward', () => router.push({ pathname: '/compose', params: { mode: 'forward', sourceMessageId: m.id } }))}
        {barBtn(m.isSeen ? 'Mark unread' : 'Mark read', () => act(m.isSeen ? 'mark_unread' : 'mark_read'))}
        {barBtn(m.isFlagged ? '★ Unstar' : '☆ Star', () => act(m.isFlagged ? 'unflag' : 'flag'))}
        {barBtn('Archive', () => act('archive'))}
        {inTrash
          ? barBtn('Delete forever', () => Alert.alert('Delete forever?', 'This permanently deletes the message from your mail server. It cannot be undone.',
              [{ text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: () => act('delete_forever', { confirm: true }) }]))
          : barBtn('Trash', () => act('trash'))}
        {barBtn(inJunk ? 'Not spam' : 'Spam', () => act(inJunk ? 'not_spam' : 'spam'))}
        {barBtn('Move', async () => { const r = await api.folders(m.mailbox.id).catch(() => null); setFolders(r?.folders ?? []); setMoveOpen(true); })}
      </ScrollView>

      <View style={{ padding: 14, backgroundColor: t.surface, borderBottomWidth: 1, borderColor: t.border }}>
        <Text style={{ color: t.text, fontSize: 18, fontWeight: '700' }}>{m.subject || '(no subject)'}</Text>
        <Pressable onPress={() => setDetails(!details)} onLongPress={() => m.from && Clipboard.setStringAsync(m.from.address)} accessibilityHint="Shows all recipients. Long-press to copy the sender's address.">
          <Text style={{ color: t.text, marginTop: 6 }}>{m.from ? (m.from.name ? `${m.from.name} <${m.from.address}>` : m.from.address) : '(no sender)'}</Text>
          <Text style={{ color: t.muted, fontSize: 13 }}>{formatDateTime(m.receivedAt)} · to {m.mailbox.email}{details ? '' : ' · details ▾'}</Text>
          {details ? (
            <View style={{ marginTop: 6 }}>
              {m.to.length ? <Text selectable style={{ color: t.muted, fontSize: 13 }}>To: {people(m.to)}</Text> : null}
              {m.cc.length ? <Text selectable style={{ color: t.muted, fontSize: 13 }}>Cc: {people(m.cc)}</Text> : null}
              {m.replyTo.length ? <Text selectable style={{ color: t.muted, fontSize: 13 }}>Reply-to: {people(m.replyTo)}</Text> : null}
              <Text style={{ color: t.muted, fontSize: 13 }}>Folder: {m.folders.map((f) => f.name).join(', ') || '—'}</Text>
              {m.authResults ? <Text style={{ color: t.muted, fontSize: 13 }}>Sender checks: SPF {m.authResults.spf ?? '—'}, DKIM {m.authResults.dkim ?? '—'}, DMARC {m.authResults.dmarc ?? '—'}</Text> : null}
            </View>
          ) : null}
        </Pressable>
        {!m.onServer ? <Text style={{ color: t.warn, marginTop: 6 }}>This message was deleted on the mail server. You are viewing the copy stored on this platform.</Text> : null}
        {m.pendingSync ? <Text style={{ color: t.warn, marginTop: 6 }}>Your last change is waiting to be confirmed by the mail server.</Text> : null}
        {authFail ? <Text style={{ color: t.danger, marginTop: 6 }}>⚠ The sender of this message could not be verified. Be careful with links and attachments.</Text> : null}
        {note ? <Text style={{ color: t.warn, marginTop: 6 }}>{note}</Text> : null}
        {m.body?.hasRemoteContent && !m.body.remoteContentShown ? (
          <Button title="Show images" variant="secondary" onPress={() => { setRemote(true); load(true); }} />
        ) : null}
        {m.attachments.filter((a) => !a.isInline).map((a) => (
          <Pressable key={a.id} accessibilityRole="button" onPress={() => download(a)} style={{ marginTop: 8, padding: 10, borderRadius: 8, borderWidth: 1, borderColor: a.risk === 'dangerous' ? t.danger : t.border }}>
            <Text style={{ color: t.text }} numberOfLines={1}>📎 {a.filename}</Text>
            <Text style={{ color: a.risk === 'dangerous' ? t.danger : t.muted, fontSize: 12 }}>
              {fileSize(a.sizeBytes)} · {a.risk === 'dangerous' ? 'Potentially dangerous file type' : a.risk === 'elevated' ? 'Open with care' : 'Not scanned for viruses'}
            </Text>
          </Pressable>
        ))}
      </View>

      {m.body?.html ? (
        <WebView
          style={{ flex: 1, backgroundColor: t.bg }}
          originWhitelist={['about:*']}
          source={{ html: emailDocument(m.body.html, m.body.remoteContentShown, dark) }}
          javaScriptEnabled={false}
          domStorageEnabled={false}
          allowFileAccess={false}
          allowFileAccessFromFileURLs={false}
          allowUniversalAccessFromFileURLs={false}
          setSupportMultipleWindows={false}
          onShouldStartLoadWithRequest={(req) => {
            if (req.url.startsWith('about:')) return true;
            openLink(req.url);
            return false;
          }}
        />
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
          {m.body?.text ? <Text selectable style={{ color: t.text, fontSize: 15, lineHeight: 22 }}>{m.body.text}</Text>
            : <Body muted>{m.bodyError ?? 'This message has no text.'}</Body>}
        </ScrollView>
      )}

      <Modal visible={moveOpen} transparent animationType="slide" onRequestClose={() => setMoveOpen(false)}>
        <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: '#0006' }}>
          <View style={{ backgroundColor: t.surface, maxHeight: '70%', borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16 }}>
            <Text style={{ color: t.text, fontWeight: '700', fontSize: 16, marginBottom: 8 }}>Move to folder</Text>
            <ScrollView>
              {folders.filter((f) => f.selectable && !m.folders.some((x) => x.id === f.id)).map((f) => (
                <Pressable key={f.id} onPress={() => { setMoveOpen(false); act('move', { folderId: f.id }); }} style={{ paddingVertical: 12, borderBottomWidth: 1, borderColor: t.border }}>
                  <Text style={{ color: t.text }}>{f.path}</Text>
                </Pressable>
              ))}
            </ScrollView>
            <Button title="Cancel" variant="link" onPress={() => setMoveOpen(false)} />
          </View>
        </View>
      </Modal>
    </View>
  );
}

export { escapeHtml };
