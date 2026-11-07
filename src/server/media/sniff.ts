/**
 * Identify an uploaded file from its bytes (never trust the browser's MIME
 * type or the file name) and read the dimensions/duration that platform
 * validation needs. Only the formats every supported platform accepts are
 * allowed: JPEG, PNG, GIF, WebP images; MP4/MOV videos. Anything else
 * (SVG, HTML, executables, polyglots that don't start with a known
 * signature) is rejected, so a "picture" can never be served as script.
 */

export type SniffResult =
  | { kind: "IMAGE"; mimeType: "image/jpeg" | "image/png" | "image/gif" | "image/webp"; width: number | null; height: number | null; durationMs: null }
  | { kind: "VIDEO"; mimeType: "video/mp4" | "video/quicktime"; width: number | null; height: number | null; durationMs: number | null };

const ascii = (b: Buffer, start: number, len: number) => b.toString("latin1", start, start + len);

function pngSize(b: Buffer) {
  // 8-byte signature, then the IHDR chunk: length(4) "IHDR"(4) width(4) height(4)
  return b.length >= 24 && ascii(b, 12, 4) === "IHDR" ? { width: b.readUInt32BE(16), height: b.readUInt32BE(20) } : null;
}

function gifSize(b: Buffer) {
  return b.length >= 10 ? { width: b.readUInt16LE(6), height: b.readUInt16LE(8) } : null;
}

function jpegSize(b: Buffer) {
  // Walk segments until a Start-Of-Frame marker (SOF0..SOF15 except DHT/JPG/DAC).
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = b.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

function webpSize(b: Buffer) {
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8 " && b.length >= 30) return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  if (chunk === "VP8L" && b.length >= 25) {
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X" && b.length >= 30) return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  return null;
}

/** Find a box by path (e.g. ["moov","mvhd"]) in an ISO-BMFF (MP4/MOV) buffer. */
function findBox(b: Buffer, path: string[], start = 0, end = b.length): { start: number; end: number } | null {
  let i = start;
  while (i + 8 <= end) {
    let size = b.readUInt32BE(i);
    const type = ascii(b, i + 4, 4);
    let header = 8;
    if (size === 1 && i + 16 <= end) { size = Number(b.readBigUInt64BE(i + 8)); header = 16; }
    else if (size === 0) size = end - i;
    if (size < header || i + size > end) return null;
    if (type === path[0]) {
      return path.length === 1 ? { start: i + header, end: i + size } : findBox(b, path.slice(1), i + header, i + size);
    }
    i += size;
  }
  return null;
}

function mp4Info(b: Buffer) {
  let durationMs: number | null = null;
  const mvhd = findBox(b, ["moov", "mvhd"]);
  if (mvhd) {
    const v = b[mvhd.start]!;
    const timescale = v === 1 ? b.readUInt32BE(mvhd.start + 20) : b.readUInt32BE(mvhd.start + 12);
    const duration = v === 1 ? Number(b.readBigUInt64BE(mvhd.start + 24)) : b.readUInt32BE(mvhd.start + 16);
    if (timescale > 0) durationMs = Math.round((duration / timescale) * 1000);
  }
  // Use the first track with a non-zero size (the video track); tkhd ends with width/height as 16.16 fixed point.
  let width: number | null = null;
  let height: number | null = null;
  const moov = findBox(b, ["moov"]);
  if (moov) {
    let i = moov.start;
    while (i + 8 <= moov.end && width === null) {
      const size = b.readUInt32BE(i);
      if (size < 8) break;
      if (ascii(b, i + 4, 4) === "trak") {
        const tkhd = findBox(b, ["tkhd"], i + 8, i + size);
        if (tkhd && tkhd.end - tkhd.start >= 84) {
          const w = b.readUInt32BE(tkhd.end - 8) / 65536;
          const h = b.readUInt32BE(tkhd.end - 4) / 65536;
          if (w > 0 && h > 0) { width = Math.round(w); height = Math.round(h); }
        }
      }
      i += size;
    }
  }
  return { width, height, durationMs };
}

export function sniffMedia(b: Buffer): SniffResult | null {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: "IMAGE", mimeType: "image/jpeg", ...(jpegSize(b) ?? { width: null, height: null }), durationMs: null };
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { kind: "IMAGE", mimeType: "image/png", ...(pngSize(b) ?? { width: null, height: null }), durationMs: null };
  if (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a") return { kind: "IMAGE", mimeType: "image/gif", ...(gifSize(b) ?? { width: null, height: null }), durationMs: null };
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return { kind: "IMAGE", mimeType: "image/webp", ...(webpSize(b) ?? { width: null, height: null }), durationMs: null };
  if (ascii(b, 4, 4) === "ftyp") {
    const brand = ascii(b, 8, 4);
    return { kind: "VIDEO", mimeType: brand === "qt  " ? "video/quicktime" : "video/mp4", ...mp4Info(b) };
  }
  return null;
}
