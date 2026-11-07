import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { ContentRefusedError, ProviderError } from "../errors";
import { aspectToSize, captionPrompt } from "../prompts";
import type { CallContext, GenerationOptions, ImageGenerator, MediaResult, TextGenerator, TextResult, VideoGenerator } from "../types";

/**
 * Zero-key generators so the whole pipeline works without credentials.
 * Test hooks in the prompt: "[mock:fail]" → retryable failure (exercises fallback),
 * "[mock:refuse]" → policy refusal (stops the chain).
 */

const delay = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    });
  });

const mockDelay = () => Number(process.env.MOCK_AI_DELAY_MS ?? 300);

function checkHooks(prompt: string) {
  if (prompt.includes("[mock:fail]")) throw new ProviderError("Mock provider simulated an outage", "MOCK", { retryable: true, code: "mock_fail" });
  if (prompt.includes("[mock:refuse]")) throw new ContentRefusedError("MOCK", "simulated");
}

const STOP = new Set("a an and are as at be but by for from has have in is it its of on or our that the this to was we were will with you your".split(" "));

function keywords(text: string, max = 4) {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 3 && !STOP.has(w));
  return [...new Set(words)].slice(0, max);
}

export class MockTextGenerator implements TextGenerator {
  readonly provider = "MOCK" as const;
  readonly type = "TEXT" as const;
  async generate(prompt: string, opts: GenerationOptions, ctx: CallContext): Promise<TextResult> {
    checkHooks(prompt);
    await delay(mockDelay(), ctx.signal);
    const { n, maxChars } = captionPrompt(prompt, opts);
    const brief = prompt.replace(/\[mock:[a-z]+\]/g, "").trim().replace(/\s+/g, " ");
    const tags = keywords(brief).map((k) => `#${k}`).join(" ");
    const openers = ["✨ ", "New: ", "Heads up! "];
    const closers = ["Tell us what you think 👇", "Link in bio.", "Don't miss it."];
    const subject = brief.length > 160 ? `${brief.slice(0, 157)}…` : brief;
    const variants = Array.from({ length: n }, (_, i) => {
      const text = `${openers[i % 3]}${subject.charAt(0).toUpperCase()}${subject.slice(1)}${/[.!?…]$/.test(subject) ? "" : "."} ${closers[i % 3]}${tags ? ` ${tags}` : ""}`;
      return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
    });
    return { kind: "text", variants };
  }
}

// ─── Minimal PNG encoder (RGB, 8-bit) ──────────────────────────────────────
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Diagonal two-colour gradient with soft "bokeh" circles, colours derived from the prompt. */
export function placeholderPng(seed: string, width: number, height: number): Buffer {
  const h = createHash("sha256").update(seed).digest();
  const c1 = [h[0]!, h[1]!, h[2]!];
  const c2 = [h[3]!, h[4]!, h[5]!];
  const circles = Array.from({ length: 5 }, (_, i) => ({
    x: (h[6 + i]! / 255) * width,
    y: (h[11 + i]! / 255) * height,
    r: (0.08 + (h[16 + i]! / 255) * 0.18) * Math.min(width, height),
  }));
  const row = 1 + width * 3;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) {
    raw[y * row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const t = (x / width + y / height) / 2;
      let glow = 0;
      for (const c of circles) {
        const d = Math.hypot(x - c.x, y - c.y);
        if (d < c.r) glow = Math.max(glow, 1 - d / c.r);
      }
      const o = y * row + 1 + x * 3;
      for (let k = 0; k < 3; k++) raw[o + k] = Math.min(255, Math.round(c1[k]! * (1 - t) + c2[k]! * t + glow * 60));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

export class MockImageGenerator implements ImageGenerator {
  readonly provider = "MOCK" as const;
  readonly type = "IMAGE" as const;
  async generate(prompt: string, opts: GenerationOptions, ctx: CallContext): Promise<MediaResult> {
    checkHooks(prompt);
    await delay(mockDelay(), ctx.signal);
    const { width, height } = aspectToSize(opts.aspectRatio, 1080);
    return { kind: "image", bytes: placeholderPng(prompt, width, height), mimeType: "image/png", width, height };
  }
}

const ASSET_DIR = path.join(process.cwd(), "src", "server", "ai", "assets");

export class MockVideoGenerator implements VideoGenerator {
  readonly provider = "MOCK" as const;
  readonly type = "VIDEO" as const;
  async generate(prompt: string, opts: GenerationOptions, ctx: CallContext): Promise<MediaResult> {
    checkHooks(prompt);
    await delay(mockDelay() * 3, ctx.signal);
    const { orientation } = aspectToSize(opts.aspectRatio);
    const vertical = orientation === "portrait";
    const bytes = await readFile(path.join(ASSET_DIR, vertical ? "mock-vertical.mp4" : "mock-landscape.mp4"));
    return { kind: "video", bytes, mimeType: "video/mp4", width: vertical ? 540 : 960, height: vertical ? 960 : 540, durationMs: 4000 };
  }
}
