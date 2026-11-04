import { File } from 'expo-file-system';

/** Phones: streams the picked file from disk to the server. */
export async function uploadBytes(uri: string, url: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  const res = await new File(uri).upload(url, { httpMethod: 'PUT', headers });
  return { status: res.status, body: res.body };
}
