import { Stack, useLocalSearchParams } from 'expo-router';
import { MessageList } from '../../../components/MessageList';

export default function FolderMessages() {
  const { folderId, name } = useLocalSearchParams<{ folderId: string; name?: string }>();
  return (
    <>
      <Stack.Screen options={{ title: name ?? 'Folder' }} />
      <MessageList query={{ view: 'folder', folderId }} showMailbox={false} empty="This folder is empty." />
    </>
  );
}
