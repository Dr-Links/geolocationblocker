import type { FolderDto } from '@app/shared';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, Text } from 'react-native';
import { Body, Message, Screen, useTheme } from '../../../components/ui';
import { api } from '../../../lib/api';

const LABEL: Record<string, string> = { inbox: 'Inbox', sent: 'Sent', drafts: 'Drafts', trash: 'Trash', junk: 'Spam', archive: 'Archive', all: 'All mail', flagged: 'Flagged' };

export default function Folders() {
  const { mailboxId, email } = useLocalSearchParams<{ mailboxId: string; email?: string }>();
  const t = useTheme();
  const [folders, setFolders] = useState<FolderDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.folders(mailboxId).then((r) => setFolders(r.folders), (e: Error) => setError(e.message)); }, [mailboxId]);
  return (
    <Screen>
      <Stack.Screen options={{ title: email ?? 'Folders' }} />
      <Message text={error} />
      {folders?.length === 0 ? <Body muted>Folders appear after the first sync (within a minute or two).</Body> : null}
      {folders?.filter((f) => f.selectable).map((f) => (
        <Pressable key={f.id} accessibilityRole="button" onPress={() => router.push({ pathname: '/folder/[folderId]', params: { folderId: f.id, name: (f.specialUse && LABEL[f.specialUse]) || f.name } })}
          style={{ paddingVertical: 14, borderBottomWidth: 1, borderColor: t.border, flexDirection: 'row' }}>
          <Text style={{ flex: 1, color: t.text, fontSize: 16, fontWeight: f.unread ? '700' : '400' }}>{(f.specialUse && LABEL[f.specialUse]) || f.path}</Text>
          {f.unread ? <Text style={{ color: t.primary, fontWeight: '700' }}>{f.unread}</Text> : null}
          {!f.syncComplete ? <Text style={{ color: t.muted, fontSize: 12, marginLeft: 8 }}>syncing…</Text> : null}
        </Pressable>
      ))}
    </Screen>
  );
}
