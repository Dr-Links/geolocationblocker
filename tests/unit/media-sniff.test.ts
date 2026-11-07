import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { placeholderPng } from "@/server/ai/providers/mock";
import { sniffMedia } from "@/server/media/sniff";

const fx = (f: string) => readFileSync(path.join(__dirname, "../fixtures/media", f));
const asset = (f: string) => readFileSync(path.join(__dirname, "../../src/server/ai/assets", f));

describe("sniffMedia (by bytes, real encoder output)", () => {
  it.each([
    ["png", placeholderPng("seed", 1080, 1350), "image/png", 1080, 1350],
    ["jpeg", fx("img.jpg"), "image/jpeg", 300, 200],
    ["gif", fx("img.gif"), "image/gif", 120, 80],
    ["webp (lossy VP8)", fx("img-lossy.webp"), "image/webp", 64, 48],
    ["webp (lossless VP8L)", fx("img-lossless.webp"), "image/webp", 64, 32], // ffmpeg rounds to even sizes; matches ffprobe,
  ])("%s → type and dimensions", (_n, bytes, mime, w, h) => {
    expect(sniffMedia(bytes)).toEqual({ kind: "IMAGE", mimeType: mime, width: w, height: h, durationMs: null });
  });

  it.each([
    ["mp4 landscape", asset("mock-landscape.mp4"), "video/mp4", 960, 540, 4000],
    ["mp4 vertical", asset("mock-vertical.mp4"), "video/mp4", 540, 960, 4000],
    ["mov", fx("clip.mov"), "video/quicktime", 320, 240, 2000],
  ])("%s → type, dimensions and duration", (_n, bytes, mime, w, h, ms) => {
    expect(sniffMedia(bytes)).toEqual({ kind: "VIDEO", mimeType: mime, width: w, height: h, durationMs: ms });
  });

  it("rejects SVG, HTML, text and truncated files whatever their name claims", () => {
    expect(sniffMedia(fx("evil.svg"))).toBeNull();
    expect(sniffMedia(Buffer.from("<!doctype html><script>alert(1)</script>"))).toBeNull();
    expect(sniffMedia(Buffer.from("just some text here"))).toBeNull();
    expect(sniffMedia(Buffer.from([0xff, 0xd8]))).toBeNull();
  });

  it("survives a corrupt container without throwing (dimensions unknown)", () => {
    const head = asset("mock-landscape.mp4").subarray(0, 40);
    expect(sniffMedia(head)).toMatchObject({ kind: "VIDEO", width: null, durationMs: null });
    const badJpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02]), Buffer.alloc(20)]);
    expect(sniffMedia(badJpeg)).toMatchObject({ kind: "IMAGE", mimeType: "image/jpeg", width: null });
  });
});
