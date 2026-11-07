import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Platform keys come from env here (no DB rows) — mock the DB lookup.
vi.mock("@/lib/db", () => ({ systemDb: { providerCredential: { findFirst: vi.fn().mockResolvedValue(null) } } }));

const { planCandidates } = await import("@/server/ai/router");

const ENV = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_AI_API_KEY", "HUGGINGFACE_API_TOKEN", "AI_FALLBACK_TO_MOCK"];
beforeEach(() => ENV.forEach((k) => delete process.env[k]));
afterEach(() => ENV.forEach((k) => delete process.env[k]));

const plan = (over: Partial<Parameters<typeof planCandidates>[0]> = {}) =>
  planCandidates({ type: "TEXT", preferred: "AUTO", byokKeys: {}, byokAllowed: false, ...over });

describe("planCandidates", () => {
  it("no keys anywhere → mock only", async () => {
    expect((await plan()).map((c) => c.provider)).toEqual(["MOCK"]);
  });

  it("AUTO uses configured providers in default order, no mock once real ones exist", async () => {
    process.env.OPENAI_API_KEY = "sk-openai";
    process.env.ANTHROPIC_API_KEY = "sk-ant";
    const c = await plan();
    expect(c.map((x) => x.provider)).toEqual(["ANTHROPIC", "OPENAI"]);
    expect(c[0]).toMatchObject({ model: "claude-opus-5-5", apiKey: "sk-ant", byok: false });
  });

  it("preferred provider goes first and gets the requested model; fallbacks use defaults", async () => {
    process.env.OPENAI_API_KEY = "sk-openai";
    process.env.ANTHROPIC_API_KEY = "sk-ant";
    const c = await plan({ preferred: "OPENAI", model: "gpt-custom" });
    expect(c.map((x) => [x.provider, x.model])).toEqual([["OPENAI", "gpt-custom"], ["ANTHROPIC", "claude-opus-5-5"]]);
  });

  it("AI_FALLBACK_TO_MOCK=true appends mock as a last resort", async () => {
    process.env.OPENAI_API_KEY = "sk-openai";
    process.env.AI_FALLBACK_TO_MOCK = "true";
    expect((await plan()).map((c) => c.provider)).toEqual(["OPENAI", "MOCK"]);
  });

  it("choosing MOCK explicitly never calls real providers", async () => {
    process.env.OPENAI_API_KEY = "sk-openai";
    expect((await plan({ preferred: "MOCK" })).map((c) => c.provider)).toEqual(["MOCK"]);
  });

  it("BYOK key wins over the platform key, only when the plan allows BYOK", async () => {
    process.env.OPENAI_API_KEY = "sk-platform";
    const allowed = await plan({ preferred: "OPENAI", byokKeys: { OPENAI: "sk-own" }, byokAllowed: true });
    expect(allowed[0]).toMatchObject({ provider: "OPENAI", apiKey: "sk-own", byok: true });
    const notAllowed = await plan({ preferred: "OPENAI", byokKeys: { OPENAI: "sk-own" }, byokAllowed: false });
    expect(notAllowed[0]).toMatchObject({ apiKey: "sk-platform", byok: false });
  });

  it("BYOK alone (no platform key) makes a provider available", async () => {
    const c = await plan({ byokKeys: { GOOGLE: "g-own" }, byokAllowed: true });
    expect(c.map((x) => [x.provider, x.byok])).toEqual([["GOOGLE", true]]);
  });

  it("skips providers that can't do the type (Anthropic has no image model)", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant";
    expect((await plan({ type: "IMAGE" })).map((c) => c.provider)).toEqual(["MOCK"]);
  });
});
