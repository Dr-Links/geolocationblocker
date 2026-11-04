import { attachmentRisk } from '../sync/parse.js';

/**
 * Detects the real type of uploaded content from its first bytes. Filenames and declared MIME types
 * come from the device and are not trusted on their own.
 */
export function detectType(data: Buffer, filename: string): { mime: string; executable: boolean } {
  const b = data.subarray(0, 16);
  const ascii = data.subarray(0, 512).toString('latin1');
  const ext = (filename.toLowerCase().match(/\.([a-z0-9]{1,8})$/)?.[1]) ?? '';
  const starts = (...bytes: number[]) => bytes.every((v, i) => b[i] === v);
  if (starts(0x4d, 0x5a)) return { mime: 'application/x-msdownload', executable: true };            // MZ: Windows program
  if (starts(0x7f, 0x45, 0x4c, 0x46)) return { mime: 'application/x-executable', executable: true }; // ELF
  if (starts(0xcf, 0xfa, 0xed, 0xfe) || starts(0xce, 0xfa, 0xed, 0xfe) || starts(0xca, 0xfe, 0xba, 0xbe)) return { mime: 'application/x-mach-binary', executable: true };
  if (ascii.startsWith('#!')) return { mime: 'text/x-script', executable: true };
  if (ascii.startsWith('%PDF-')) return { mime: 'application/pdf', executable: false };
  if (starts(0x89, 0x50, 0x4e, 0x47)) return { mime: 'image/png', executable: false };
  if (starts(0xff, 0xd8, 0xff)) return { mime: 'image/jpeg', executable: false };
  if (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')) return { mime: 'image/gif', executable: false };
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return { mime: 'image/webp', executable: false };
  if (ascii.slice(4, 8) === 'ftyp') return { mime: /heic|heif/.test(ascii.slice(8, 12)) ? 'image/heic' : 'video/mp4', executable: false };
  if (starts(0x50, 0x4b, 0x03, 0x04)) {
    const office: Record<string, string> = {
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet',
      apk: 'application/vnd.android.package-archive', jar: 'application/java-archive',
    };
    return { mime: office[ext] ?? 'application/zip', executable: ext === 'apk' || ext === 'jar' };
  }
  if (starts(0xd0, 0xcf, 0x11, 0xe0)) return { mime: ext === 'msi' ? 'application/x-msi' : 'application/x-ole-storage', executable: ext === 'msi' };
  if (ascii.startsWith('Rar!')) return { mime: 'application/vnd.rar', executable: false };
  if (starts(0x37, 0x7a, 0xbc, 0xaf)) return { mime: 'application/x-7z-compressed', executable: false };
  if (starts(0x1f, 0x8b)) return { mime: 'application/gzip', executable: false };
  if (/^\s*(<!doctype html|<html|<script)/i.test(ascii)) return { mime: 'text/html', executable: false };
  if (/^\s*<svg|^\s*<\?xml[^>]*>\s*<svg/i.test(ascii)) return { mime: 'image/svg+xml', executable: false };
  const sample = data.subarray(0, 4096);
  if (sample.length && !sample.includes(0)) return { mime: 'text/plain', executable: false };
  return { mime: 'application/octet-stream', executable: false };
}

const EXPECTED: Record<string, string[]> = {
  pdf: ['application/pdf'], png: ['image/png'], jpg: ['image/jpeg'], jpeg: ['image/jpeg'], gif: ['image/gif'], webp: ['image/webp'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'], xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  pptx: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'], txt: ['text/plain'], csv: ['text/plain'],
  zip: ['application/zip'], doc: ['application/x-ole-storage'], xls: ['application/x-ole-storage'],
};

/** Risk of an uploaded file: executables and files disguised as another type are "dangerous". */
export function uploadRisk(filename: string, detected: { mime: string; executable: boolean }): 'low' | 'elevated' | 'dangerous' {
  if (detected.executable) return 'dangerous';
  const byName = attachmentRisk(filename);
  if (byName === 'dangerous') return 'dangerous';
  const ext = filename.toLowerCase().match(/\.([a-z0-9]{1,8})$/)?.[1] ?? '';
  const expected = EXPECTED[ext];
  if (expected && !expected.includes(detected.mime)) return 'dangerous'; // e.g. "invoice.pdf" that is not a PDF
  if (byName === 'elevated' || detected.mime === 'text/html' || detected.mime === 'image/svg+xml') return 'elevated';
  return 'low';
}
