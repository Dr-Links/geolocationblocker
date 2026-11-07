import { describe, expect, it, vi } from "vitest";
import { AnthropicTextGenerator } from "@/server/ai/providers/anthropic";
import { GoogleImageGenerator, GoogleTextGenerator, GoogleVideoGenerator } from "@/server/ai/providers/google";
import { HuggingFaceImageGenerator, HuggingFaceTextGenerator } from "@/server/ai/providers/huggingface";
import { MockImageGenerator, MockTextGenerator, MockVideoGenerator } from "@/server/ai/providers/mock";
import { OpenAIImageGenerator, OpenAITextGenerator, OpenAIVideoGenerator } from "@/server/ai/providers/openai";
import { ContentRefusedError, ProviderError, toProviderError } from "@/server/ai/errors";
import { captionPrompt, parseVariants } from "@/server/ai/prompts";

process.env.MOCK_AI_DELAY_MS = "0";
const ctx = (model = "m") => ({ apiKey: "sk-test-1234", model });

describe("prompts", () => {
  it("parses JSON, fenced JSON and plain text; enforces count and length", () => {
    expect(parseVariants('{"variants":["a","b","c","d"]}', 2, 100)).toEqual(["a", "b"]);
    expect(parseVariants('```json\n{"variants":["x"]}\n```', 1, 100)).toEqual(["x"]);
    expect(parseVariants("Just a caption", 1, 100)).toEqual(["Just a caption"]);
    expect(parseVariants('{"variants":["' + "y".repeat(50) + '"]}', 1, 10)[0]).toHaveLength(10);
  });
  it("applies platform rules", () => {
    expect(captionPrompt("brief", { platform: "X" }).maxChars).toBe(280);
    expect(captionPrompt("brief", { platform: "X" }).system).toContain("X");
    expect(captionPrompt("brief", { variants: 9 }).n).toBe(3);
  });
});

describe("error classification", () => {
  it.each([
    [{ status: 429 }, true],
    [{ status: 529 }, true],
    [{ status: 500 }, true],
    [{ status: 401 }, true], // bad key → try another provider
    [{ status: 400 }, false],
    [{ status: 404 }, false],
    [{ name: "AbortError", message: "aborted" }, true],
    [new Error("ECONNRESET"), true],
  ])("%o → retryable %s", (err, retryable) => {
    expect(toProviderError("OPENAI", err).retryable).toBe(retryable);
  });
});

describe("mock generators", () => {
  it("text: respects variant count and platform limit", async () => {
    const r = await new MockTextGenerator().generate("Launch of our new cold brew coffee in Brooklyn", { variants: 3, platform: "X" }, ctx());
    expect(r.variants).toHaveLength(3);
    expect(r.variants.every((v) => v.length <= 280)).toBe(true);
    expect(r.variants[0]).toMatch(/#/);
  });
  it("image: valid PNG at the requested aspect ratio", async () => {
    const r = await new MockImageGenerator().generate("sunset", { aspectRatio: "9:16" }, ctx());
    expect(r.bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(r.bytes.readUInt32BE(16)).toBe(608); // IHDR width
    expect(r.bytes.readUInt32BE(20)).toBe(1080); // IHDR height
    expect([r.width, r.height]).toEqual([608, 1080]);
  });
  it("video: returns an mp4 clip matching orientation", async () => {
    const r = await new MockVideoGenerator().generate("clip", { aspectRatio: "9:16" }, ctx());
    expect(r.mimeType).toBe("video/mp4");
    expect(r.bytes.subarray(4, 8).toString()).toBe("ftyp");
    expect(r.height).toBeGreaterThan(r.width!);
  });
  it("test hooks: [mock:fail] is retryable, [mock:refuse] is a refusal", async () => {
    await expect(new MockTextGenerator().generate("x [mock:fail]", {}, ctx())).rejects.toMatchObject({ retryable: true });
    await expect(new MockTextGenerator().generate("x [mock:refuse]", {}, ctx())).rejects.toBeInstanceOf(ContentRefusedError);
  });
});

describe("Anthropic adapter", () => {
  const fakeClient = (res: unknown) => {
    const create = vi.fn().mockImplementation(async () => (res instanceof Error ? Promise.reject(res) : res));
    return { create, factory: (key: string) => ({ beta: { messages: { create } }, key }) as never };
  };

  it("sends structured output + low effort, and server-side fallbacks for supported models", async () => {
    const { create, factory } = fakeClient({ stop_reason: "end_turn", content: [{ type: "text", text: '{"variants":["Hello #coffee"]}' }] });
    const r = await new AnthropicTextGenerator(factory).generate("coffee launch", { platform: "INSTAGRAM" }, ctx("claude-opus-5-5"));
    expect(r.variants).toEqual(["Hello #coffee"]);
    const body = create.mock.calls[0]![0];
    expect(body).toMatchObject({ model: "claude-opus-5-5", output_config: { effort: "low", format: { type: "json_schema" } }, fallbacks: "default", betas: ["server-side-fallback-2026-07-01"] });
    expect(body.system).toContain("Instagram");
    expect(body).not.toHaveProperty("thinking"); // Opus 5.5: thinking can't be disabled; effort is the control
  });

  it("omits fallbacks for models without server-side fallback support", async () => {
    const { create, factory } = fakeClient({ stop_reason: "end_turn", content: [{ type: "text", text: '{"variants":["hi"]}' }] });
    await new AnthropicTextGenerator(factory).generate("x brief", {}, ctx("claude-haiku-5-5"));
    expect(create.mock.calls[0]![0]).not.toHaveProperty("fallbacks");
  });

  it("refusal stop_reason → ContentRefusedError (not retryable)", async () => {
    const { factory } = fakeClient({ stop_reason: "refusal", stop_details: { category: "cyber" }, content: [] });
    const err = await new AnthropicTextGenerator(factory).generate("x brief", {}, ctx("claude-opus-5-5")).catch((e) => e);
    expect(err).toBeInstanceOf(ContentRefusedError);
    expect(err.retryable).toBe(false);
  });

  it("overloaded (529) → retryable ProviderError", async () => {
    const { factory } = fakeClient(Object.assign(new Error("Overloaded"), { status: 529 }));
    await expect(new AnthropicTextGenerator(factory).generate("x brief", {}, ctx())).rejects.toMatchObject({ retryable: true, provider: "ANTHROPIC" });
  });
});

describe("OpenAI adapters", () => {
  it("text via Responses API with json_schema", async () => {
    const create = vi.fn().mockResolvedValue({ output_text: '{"variants":["A","B"]}' });
    const r = await new OpenAITextGenerator(() => ({ responses: { create } }) as never).generate("brief", { variants: 2 }, ctx("gpt-5.5"));
    expect(r.variants).toEqual(["A", "B"]);
    expect(create.mock.calls[0]![0]).toMatchObject({ model: "gpt-5.5", text: { format: { type: "json_schema", strict: true } } });
  });
  it("image: maps aspect ratio to a supported size and decodes base64", async () => {
    const generate = vi.fn().mockResolvedValue({ data: [{ b64_json: Buffer.from("png-bytes").toString("base64") }] });
    const r = await new OpenAIImageGenerator(() => ({ images: { generate } }) as never).generate("cat", { aspectRatio: "9:16" }, ctx("gpt-image-1"));
    expect(generate.mock.calls[0]![0]).toMatchObject({ size: "1024x1536", model: "gpt-image-1" });
    expect(r.bytes.toString()).toBe("png-bytes");
  });
  it("policy violation → refusal", async () => {
    const generate = vi.fn().mockRejectedValue(Object.assign(new Error("blocked"), { status: 400, code: "content_policy_violation" }));
    await expect(new OpenAIImageGenerator(() => ({ images: { generate } }) as never).generate("x", {}, ctx())).rejects.toBeInstanceOf(ContentRefusedError);
  });
  it("video: polls until completed, then downloads", async () => {
    const statuses = ["queued", "in_progress", "completed"];
    const videos = {
      create: vi.fn().mockResolvedValue({ id: "v1", status: "queued" }),
      retrieve: vi.fn().mockImplementation(async () => ({ id: "v1", status: statuses.shift() === "queued" ? "in_progress" : "completed" })),
      downloadContent: vi.fn().mockResolvedValue({ arrayBuffer: async () => new TextEncoder().encode("mp4").buffer }),
    };
    const r = await new OpenAIVideoGenerator(() => ({ videos }) as never, 1).generate("waves", { aspectRatio: "9:16", durationSec: 8 }, ctx("sora-2"));
    expect(videos.create.mock.calls[0]![0]).toMatchObject({ model: "sora-2", size: "720x1280", seconds: "8" });
    expect(r.bytes.toString()).toBe("mp4");
  });
  it("video: a failed job is not retried on the same provider", async () => {
    const videos = { create: vi.fn().mockResolvedValue({ id: "v1", status: "failed", error: { message: "nope" } }) };
    await expect(new OpenAIVideoGenerator(() => ({ videos }) as never, 1).generate("x", {}, ctx())).rejects.toMatchObject({ retryable: false });
  });
});

describe("Google adapters", () => {
  it("text: JSON response + safety block → refusal", async () => {
    const ok = { models: { generateContent: vi.fn().mockResolvedValue({ text: '{"variants":["G"]}', candidates: [{ finishReason: "STOP" }] }) } };
    expect((await new GoogleTextGenerator(() => ok as never).generate("b", {}, ctx())).variants).toEqual(["G"]);
    expect(ok.models.generateContent.mock.calls[0]![0].config).toMatchObject({ responseMimeType: "application/json" });
    const blocked = { models: { generateContent: vi.fn().mockResolvedValue({ promptFeedback: { blockReason: "SAFETY" } }) } };
    await expect(new GoogleTextGenerator(() => blocked as never).generate("b", {}, ctx())).rejects.toBeInstanceOf(ContentRefusedError);
  });
  it("image: maps 4:5 to the nearest supported ratio", async () => {
    const generateImages = vi.fn().mockResolvedValue({ generatedImages: [{ image: { imageBytes: Buffer.from("img").toString("base64"), mimeType: "image/png" } }] });
    const r = await new GoogleImageGenerator(() => ({ models: { generateImages } }) as never).generate("b", { aspectRatio: "4:5" }, ctx());
    expect(generateImages.mock.calls[0]![0].config.aspectRatio).toBe("3:4");
    expect(r.bytes.toString()).toBe("img");
  });
  it("video: polls the operation and downloads the file URI with the API key", async () => {
    let n = 0;
    const client = {
      models: { generateVideos: vi.fn().mockResolvedValue({ done: false }) },
      operations: { getVideosOperation: vi.fn().mockImplementation(async () => (++n < 2 ? { done: false } : { done: true, response: { generatedVideos: [{ video: { uri: "https://files.example/v.mp4" } }] } })) },
    };
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new TextEncoder().encode("veo").buffer });
    const r = await new GoogleVideoGenerator(() => client as never, 1, 60_000, fetchImpl as never).generate("b", { aspectRatio: "9:16" }, ctx());
    expect(fetchImpl.mock.calls[0]![1].headers["x-goog-api-key"]).toBe("sk-test-1234");
    expect(r.bytes.toString()).toBe("veo");
  });
});

describe("Hugging Face adapters", () => {
  it("text via chatCompletion; image via textToImage blob", async () => {
    const chatCompletion = vi.fn().mockResolvedValue({ choices: [{ message: { content: '{"variants":["H"]}' } }] });
    expect((await new HuggingFaceTextGenerator(() => ({ chatCompletion }) as never).generate("b", {}, ctx())).variants).toEqual(["H"]);
    const textToImage = vi.fn().mockResolvedValue(new Blob(["jpeg"], { type: "image/jpeg" }));
    const r = await new HuggingFaceImageGenerator(() => ({ textToImage }) as never).generate("b", { aspectRatio: "16:9" }, ctx());
    expect(r.mimeType).toBe("image/jpeg");
    expect(textToImage.mock.calls[0]![0].parameters.width % 8).toBe(0);
  });
  it("wraps SDK errors as ProviderError", async () => {
    const chatCompletion = vi.fn().mockRejectedValue(Object.assign(new Error("rate"), { statusCode: 429 }));
    const err = await new HuggingFaceTextGenerator(() => ({ chatCompletion }) as never).generate("b", {}, ctx()).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.retryable).toBe(true);
  });
});
