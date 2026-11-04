/** Browser: the picked file is a blob: URL. */
export async function uploadBytes(uri: string, url: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  const blob = await (await fetch(uri)).blob();
  const res = await fetch(url, { method: 'PUT', body: blob, headers, credentials: 'same-origin' });
  return { status: res.status, body: await res.text() };
}
