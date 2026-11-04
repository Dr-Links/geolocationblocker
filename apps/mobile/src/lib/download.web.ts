/** Browser: fetches with the session's token and hands the file to the browser's normal download. */
export async function saveDownload(url: string, headers: Record<string, string>, filename: string, _mimeType: string) {
  const res = await fetch(url, { headers, credentials: 'same-origin' });
  if (!res.ok) {
    const b = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(b.error?.message ?? `HTTP ${res.status}`);
  }
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = filename.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) || 'attachment';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
}
