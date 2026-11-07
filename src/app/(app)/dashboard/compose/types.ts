export type GenType = "TEXT" | "IMAGE" | "VIDEO";
export type ComposerOptions = {
  types: Record<GenType, { providers: { provider: string; label: string; byok: boolean; models: string[] }[]; cost: number; preference: { provider: string; model?: string }; allowed: boolean }>;
  creditsLeft: number | null;
};
export type ComposerMedia = { id: string; kind: "IMAGE" | "VIDEO"; mimeType: string; width?: number | null; height?: number | null; durationMs?: number | null; sizeBytes?: number | null };
export type TargetAccount = { id: string; platform: string; label: string; displayName: string; isMock: boolean; status: string };
