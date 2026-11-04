import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

/** Phones: downloads to the app's cache, then opens the share sheet (open with / save to Files). */
export async function saveDownload(url: string, headers: Record<string, string>, filename: string, mimeType: string) {
  const safe = filename.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) || 'attachment';
  const target = new File(Paths.cache, `${Date.now()}-${safe}`);
  const file = await File.downloadFileAsync(url, target, { headers, idempotent: true });
  if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(file.uri, { mimeType, dialogTitle: filename });
}
