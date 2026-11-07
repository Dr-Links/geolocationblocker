import type { AiProvider } from "@prisma/client";
import { z } from "zod";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { systemDb, withTenantTx, type Tx } from "@/lib/db";
import { logger } from "@/lib/logger";
import { assertFeature } from "@/server/billing/entitlements";
import { NotFoundError } from "@/server/errors";
import { recordAudit } from "@/server/services/audit";
import { assertCan } from "@/server/tenancy/guard";
import type { TenantContext } from "@/server/tenancy/types";
import { PROVIDERS, REAL_PROVIDERS } from "./catalog";

/**
 * Provider API keys, encrypted at rest (AES-256-GCM).
 *  - Platform keys: ProviderCredential with workspaceId = NULL (Admin → AI),
 *    falling back to env vars (ANTHROPIC_API_KEY, …).
 *  - BYOK: ProviderCredential owned by a workspace. RLS keeps it tenant-private.
 * Keys are never returned to the browser; only the last 4 characters are shown.
 */

export const apiKeySchema = z
  .string()
  .trim()
  .min(8, "That doesn't look like an API key")
  .max(500)
  .regex(/^[\x21-\x7e]+$/, "API keys can't contain spaces or special characters");

export const realProviderSchema = z.enum(REAL_PROVIDERS as [AiProvider, ...AiProvider[]]);

const last4 = (k: string) => k.slice(-4);

function safeDecrypt(enc: string, where: string) {
  try {
    return decryptSecret(enc);
  } catch (err) {
    logger.error({ err, where }, "failed to decrypt stored API key (wrong ENCRYPTION_KEY?)");
    return null;
  }
}

// ─── Platform keys (SUPER_ADMIN) ───────────────────────────────────────────

export async function getPlatformKey(provider: AiProvider): Promise<{ key: string; source: "db" | "env" } | null> {
  if (provider === "MOCK") return null;
  const row = await systemDb.providerCredential.findFirst({ where: { workspaceId: null, provider } });
  if (row) {
    const key = safeDecrypt(row.encryptedKey, `platform:${provider}`);
    if (key) return { key, source: "db" };
  }
  const env = PROVIDERS[provider].envKey;
  const fromEnv = env ? process.env[env]?.trim() : undefined;
  return fromEnv ? { key: fromEnv, source: "env" } : null;
}

export async function listPlatformKeyStatus() {
  const rows = await systemDb.providerCredential.findMany({ where: { workspaceId: null } });
  return REAL_PROVIDERS.map((p) => {
    const row = rows.find((r) => r.provider === p);
    const env = PROVIDERS[p].envKey;
    const hasEnv = !!(env && process.env[env]?.trim());
    return { provider: p, label: PROVIDERS[p].label, db: row ? { last4: row.last4, updatedAt: row.updatedAt } : null, env: hasEnv, envKey: env };
  });
}

export async function setPlatformKey(adminId: string, provider: AiProvider, rawKey: string) {
  const p = realProviderSchema.parse(provider);
  const key = apiKeySchema.parse(rawKey);
  const existing = await systemDb.providerCredential.findFirst({ where: { workspaceId: null, provider: p } });
  const data = { encryptedKey: encryptSecret(key), last4: last4(key) };
  if (existing) await systemDb.providerCredential.update({ where: { id: existing.id }, data });
  else await systemDb.providerCredential.create({ data: { provider: p, ...data } });
  await recordAudit({ action: "admin.ai.platform_key.set", actorId: adminId, metadata: { provider: p, last4: data.last4 } });
}

export async function removePlatformKey(adminId: string, provider: AiProvider) {
  const p = realProviderSchema.parse(provider);
  const { count } = await systemDb.providerCredential.deleteMany({ where: { workspaceId: null, provider: p } });
  if (!count) throw new NotFoundError("No stored key for that provider");
  await recordAudit({ action: "admin.ai.platform_key.remove", actorId: adminId, metadata: { provider: p } });
}

// ─── Workspace keys (BYOK) ─────────────────────────────────────────────────

/** Decrypted BYOK keys for a workspace, inside a tenant transaction. */
export async function getWorkspaceKeys(tx: Tx, workspaceId: string): Promise<Partial<Record<AiProvider, string>>> {
  const rows = await tx.providerCredential.findMany({ where: { workspaceId } });
  const out: Partial<Record<AiProvider, string>> = {};
  for (const r of rows) {
    const k = safeDecrypt(r.encryptedKey, `byok:${workspaceId}:${r.provider}`);
    if (k) out[r.provider] = k;
  }
  return out;
}

export async function listWorkspaceKeys(ctx: TenantContext) {
  const rows = await ctx.db.providerCredential.findMany({ where: { workspaceId: ctx.workspaceId }, orderBy: { provider: "asc" } });
  return rows.map((r) => ({ provider: r.provider, last4: r.last4, updatedAt: r.updatedAt }));
}

export async function setWorkspaceKey(ctx: TenantContext, provider: AiProvider, rawKey: string) {
  assertCan(ctx, "settings.ai");
  const p = realProviderSchema.parse(provider);
  const key = apiKeySchema.parse(rawKey);
  await withTenantTx(ctx.workspaceId, async (tx) => {
    await assertFeature(tx, ctx.workspaceId, "byok");
    const data = { encryptedKey: encryptSecret(key), last4: last4(key) };
    const existing = await tx.providerCredential.findFirst({ where: { workspaceId: ctx.workspaceId, provider: p } });
    if (existing) await tx.providerCredential.update({ where: { id: existing.id }, data });
    else await tx.providerCredential.create({ data: { workspaceId: ctx.workspaceId, provider: p, ...data } });
    await recordAudit({ action: "ai.byok.set", actorId: ctx.userId, workspaceId: ctx.workspaceId, metadata: { provider: p, last4: data.last4 } }, tx);
  });
}

export async function removeWorkspaceKey(ctx: TenantContext, provider: AiProvider) {
  assertCan(ctx, "settings.ai");
  const p = realProviderSchema.parse(provider);
  await withTenantTx(ctx.workspaceId, async (tx) => {
    const { count } = await tx.providerCredential.deleteMany({ where: { workspaceId: ctx.workspaceId, provider: p } });
    if (!count) throw new NotFoundError("No key stored for that provider");
    await recordAudit({ action: "ai.byok.remove", actorId: ctx.userId, workspaceId: ctx.workspaceId, metadata: { provider: p } }, tx);
  });
}
