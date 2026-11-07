import { randomBytes } from "node:crypto";
import type { SocialAccount, SocialPlatform } from "@prisma/client";
import { z } from "zod";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { systemDb, withTenantTx, type Tx } from "@/lib/db";
import { logger } from "@/lib/logger";
import { PLATFORM_KEYS } from "@/lib/platforms";
import { signToken, verifyToken } from "@/lib/signed-token";
import { assertWithinLimit } from "@/server/billing/entitlements";
import { ConflictError, ForbiddenError, LimitExceededError, NotFoundError } from "@/server/errors";
import { recordAudit } from "@/server/services/audit";
import { getStorage } from "@/server/storage";
import { assertCan } from "@/server/tenancy/guard";
import type { TenantContext } from "@/server/tenancy/types";
import { pkcePair } from "./oauth";
import { publisherForAccount, publisherForConnect } from "./registry";
import { PublishError, type AccountCredentials, type PublishInput, type PublishMedia, type ValidationResult } from "./types";

export const OAUTH_COOKIE = "pp_oauth";
const OAUTH_PURPOSE = "social-oauth";
const OAUTH_TTL_SEC = 10 * 60;
const REFRESH_SKEW_MS = 5 * 60_000;

export const platformSchema = z.enum(PLATFORM_KEYS as [SocialPlatform, ...SocialPlatform[]]);

export const redirectUriFor = (platform: SocialPlatform) => `${process.env.APP_URL ?? "http://localhost:3000"}/api/social/callback/${platform.toLowerCase()}`;

interface OAuthState {
  s: string; // state
  v: string; // PKCE verifier
  p: SocialPlatform;
  w: string; // workspaceId
  u: string; // userId
}

// ─── Connect (OAuth) ────────────────────────────────────────────────────────

/** Step 1: returns the provider URL and a signed, short-lived cookie binding state+PKCE to this user/workspace. */
export async function startConnect(ctx: TenantContext, rawPlatform: string) {
  assertCan(ctx, "accounts.manage");
  const platform = platformSchema.parse(rawPlatform.toUpperCase());
  // Fast feedback at the limit, but don't block RECONNECTING an existing account on this
  // platform (e.g. an expired one). The callback enforces the limit per account authoritatively.
  await withTenantTx(ctx.workspaceId, async (tx) => {
    const existing = await tx.socialAccount.count({ where: { workspaceId: ctx.workspaceId, platform, status: { not: "DISCONNECTED" } } });
    if (!existing) await assertWithinLimit(tx, ctx.workspaceId, "maxSocialAccounts");
  });
  const { verifier, challenge } = pkcePair();
  const state = randomBytes(24).toString("base64url");
  const cookie = signToken<OAuthState>({ s: state, v: verifier, p: platform, w: ctx.workspaceId, u: ctx.userId }, OAUTH_PURPOSE, OAUTH_TTL_SEC);
  const publisher = publisherForConnect(platform);
  return { url: publisher.authorizeUrl({ state, redirectUri: redirectUriFor(platform), codeChallenge: challenge }), cookie, isMock: publisher.isMock };
}

export interface CompleteResult {
  platform: SocialPlatform;
  connected: string[];
  skipped: string[];
}

/** Step 2: the OAuth callback. Verifies state/PKCE binding, exchanges the code, stores encrypted tokens. */
export async function completeConnect(
  ctx: TenantContext,
  rawPlatform: string,
  params: { code?: string | null; state?: string | null; error?: string | null; cookie?: string | null },
): Promise<CompleteResult> {
  assertCan(ctx, "accounts.manage");
  const platform = platformSchema.parse(rawPlatform.toUpperCase());
  if (params.error) throw new ConflictError(params.error === "access_denied" ? "Connection was cancelled." : `The platform returned an error: ${params.error}`);
  const t = verifyToken<OAuthState>(params.cookie, OAUTH_PURPOSE);
  if (!t || !params.state || t.s !== params.state || t.p !== platform) throw new ForbiddenError("This connection link is invalid or expired. Please try again.");
  if (t.w !== ctx.workspaceId || t.u !== ctx.userId) throw new ForbiddenError("This connection was started in a different workspace or by a different user.");
  if (!params.code) throw new ConflictError("The platform didn't return an authorization code.");

  const publisher = publisherForConnect(platform);
  const profiles = await publisher.connect({ code: params.code, redirectUri: redirectUriFor(platform), codeVerifier: t.v });

  const result: CompleteResult = { platform, connected: [], skipped: [] };
  await withTenantTx(ctx.workspaceId, async (tx) => {
    for (const p of profiles) {
      const existing = await tx.socialAccount.findUnique({ where: { workspaceId_platform_externalId: { workspaceId: ctx.workspaceId, platform, externalId: p.externalId } } });
      const data = {
        displayName: p.displayName,
        handle: p.handle ?? null,
        avatarUrl: p.avatarUrl ?? null,
        accessTokenEnc: encryptSecret(p.accessToken),
        refreshTokenEnc: p.refreshToken ? encryptSecret(p.refreshToken) : null,
        tokenExpiresAt: p.expiresAt ?? null,
        scopes: p.scopes ?? [],
        status: "CONNECTED" as const,
        lastError: null,
        lastHealthCheckAt: new Date(),
        isMock: publisher.isMock,
      };
      // Reconnecting a live account doesn't use a new slot; re-activating a disconnected one does.
      if (!existing || existing.status === "DISCONNECTED") {
        try {
          await assertWithinLimit(tx, ctx.workspaceId, "maxSocialAccounts");
        } catch (err) {
          if (err instanceof LimitExceededError) {
            result.skipped.push(p.displayName);
            continue;
          }
          throw err;
        }
      }
      const acct = existing
        ? await tx.socialAccount.update({ where: { id: existing.id }, data })
        : await tx.socialAccount.create({ data: { workspaceId: ctx.workspaceId, platform, externalId: p.externalId, ...data } });
      result.connected.push(acct.displayName);
      await recordAudit(
        { action: existing ? "social.account.reconnect" : "social.account.connect", actorId: ctx.userId, workspaceId: ctx.workspaceId, targetType: "SocialAccount", targetId: acct.id, metadata: { platform, handle: acct.handle, mock: publisher.isMock } },
        tx,
      );
    }
  });
  if (result.connected.length === 0 && result.skipped.length) {
    throw new LimitExceededError(`Your plan's connected-account limit is reached; ${result.skipped.join(", ")} wasn't connected.`, "maxSocialAccounts");
  }
  return result;
}

// ─── Manage ────────────────────────────────────────────────────────────────

export async function listAccounts(ctx: TenantContext) {
  return ctx.db.socialAccount.findMany({
    where: { workspaceId: ctx.workspaceId },
    orderBy: [{ status: "asc" }, { platform: "asc" }, { createdAt: "asc" }],
    select: { id: true, platform: true, isMock: true, displayName: true, handle: true, avatarUrl: true, status: true, tokenExpiresAt: true, lastHealthCheckAt: true, lastError: true, createdAt: true },
  });
}

export async function disconnectAccount(ctx: TenantContext, accountId: string) {
  assertCan(ctx, "accounts.manage");
  return withTenantTx(ctx.workspaceId, async (tx) => {
    const acct = await tx.socialAccount.findUnique({ where: { id: accountId } });
    if (!acct) throw new NotFoundError("Account not found");
    // Keep the row (post history references it) but wipe the credentials.
    await tx.socialAccount.update({
      where: { id: acct.id },
      data: { status: "DISCONNECTED", accessTokenEnc: encryptSecret("revoked"), refreshTokenEnc: null, tokenExpiresAt: null, lastError: null },
    });
    await recordAudit({ action: "social.account.disconnect", actorId: ctx.userId, workspaceId: ctx.workspaceId, targetType: "SocialAccount", targetId: acct.id, metadata: { platform: acct.platform } }, tx);
  });
}

// ─── Tokens & health ───────────────────────────────────────────────────────

export function credentialsOf(acct: Pick<SocialAccount, "externalId" | "handle" | "accessTokenEnc" | "refreshTokenEnc">): AccountCredentials {
  return {
    externalId: acct.externalId,
    handle: acct.handle,
    accessToken: decryptSecret(acct.accessTokenEnc),
    refreshToken: acct.refreshTokenEnc ? decryptSecret(acct.refreshTokenEnc) : null,
  };
}

/**
 * Return usable credentials, refreshing first if the access token expires soon.
 * A refresh the platform rejects (revoked/expired grant) marks the account EXPIRED.
 * `tx` must be able to see the account (tenant tx or system tx).
 * IMPORTANT: on failure this writes the new status and THEN throws. Catch inside
 * the same transaction, or the status update is rolled back with it.
 */
export async function ensureFreshCredentials(tx: Tx, acct: SocialAccount, opts: { force?: boolean } = {}): Promise<AccountCredentials> {
  if (acct.status === "DISCONNECTED") throw new PublishError("Account is disconnected", acct.platform, { retryable: false, authExpired: true });
  const creds = credentialsOf(acct);
  const due = opts.force || (acct.tokenExpiresAt && acct.tokenExpiresAt.getTime() - Date.now() < REFRESH_SKEW_MS);
  if (!due) return creds;
  try {
    const t = await publisherForAccount(acct).refreshToken(creds);
    await tx.socialAccount.update({
      where: { id: acct.id },
      data: {
        accessTokenEnc: encryptSecret(t.accessToken),
        refreshTokenEnc: t.refreshToken ? encryptSecret(t.refreshToken) : acct.refreshTokenEnc,
        tokenExpiresAt: t.expiresAt ?? null,
        status: "CONNECTED",
        lastError: null,
      },
    });
    return { ...creds, accessToken: t.accessToken, refreshToken: t.refreshToken ?? creds.refreshToken };
  } catch (err) {
    const pe = err instanceof PublishError ? err : new PublishError((err as Error).message, acct.platform, { retryable: true });
    await tx.socialAccount.update({
      where: { id: acct.id },
      data: { status: pe.opts.authExpired || !pe.retryable ? "EXPIRED" : "ERROR", lastError: pe.message.slice(0, 500), lastHealthCheckAt: new Date() },
    });
    throw pe;
  }
}

export async function checkAccountHealth(ctx: TenantContext, accountId: string) {
  return withTenantTx(ctx.workspaceId, async (tx) => {
    const acct = await tx.socialAccount.findUnique({ where: { id: accountId } });
    if (!acct) throw new NotFoundError("Account not found");
    try {
      const creds = await ensureFreshCredentials(tx, acct);
      const h = await publisherForAccount(acct).checkHealth(creds);
      return tx.socialAccount.update({
        where: { id: acct.id },
        data: { status: h.ok ? "CONNECTED" : "ERROR", lastError: h.ok ? null : (h.error ?? "Health check failed").slice(0, 500), lastHealthCheckAt: new Date() },
      });
    } catch (err) {
      if (err instanceof PublishError) return tx.socialAccount.findUniqueOrThrow({ where: { id: acct.id } });
      throw err;
    }
  });
}

/**
 * Worker sweep (cross-tenant, trusted): refresh tokens expiring within 24h so
 * scheduled posts don't hit expired tokens. Returns counts for logging.
 */
export async function refreshExpiringTokens(horizonMs = 24 * 3600_000) {
  const due = await systemDb.socialAccount.findMany({
    where: { status: { in: ["CONNECTED", "ERROR"] }, refreshTokenEnc: { not: null }, tokenExpiresAt: { lt: new Date(Date.now() + horizonMs) } },
    take: 500,
  });
  let refreshed = 0;
  let failed = 0;
  for (const acct of due) {
    const ok = await withTenantTx(acct.workspaceId, async (tx) => {
      try {
        await ensureFreshCredentials(tx, acct, { force: true });
        return true;
      } catch (err) {
        // Caught inside the tx so the EXPIRED/ERROR status written above is committed.
        logger.warn({ accountId: acct.id, platform: acct.platform, err: (err as Error).message }, "token refresh failed");
        return false;
      }
    });
    if (ok) refreshed++;
    else failed++;
  }
  return { checked: due.length, refreshed, failed };
}

// ─── Validation against target accounts ────────────────────────────────────

/** Load media as publisher input (metadata + lazy bytes + public URL if storage supports it). */
export async function loadPublishMedia(tx: Tx, mediaAssetIds: string[]): Promise<PublishMedia[]> {
  if (!mediaAssetIds.length) return [];
  const rows = await tx.mediaAsset.findMany({ where: { id: { in: mediaAssetIds } } });
  if (rows.length !== new Set(mediaAssetIds).size) throw new NotFoundError("Some attached media no longer exists");
  const storage = getStorage();
  const byId = new Map(rows.map((r) => [r.id, r]));
  return Promise.all(
    mediaAssetIds.map(async (id) => {
      const r = byId.get(id)!;
      return {
        id: r.id,
        kind: r.kind,
        mimeType: r.mimeType,
        sizeBytes: r.sizeBytes,
        width: r.width,
        height: r.height,
        durationMs: r.durationMs,
        publicUrl: await storage.signedUrl(r.storageKey, 3600),
        load: async () => (await storage.get(r.storageKey)).body,
      };
    }),
  );
}

export const validateInputSchema = z.object({
  content: z.string().max(70_000),
  mediaAssetIds: z.array(z.string().min(8).max(64)).max(20).default([]),
  accountIds: z.array(z.string().min(8).max(64)).min(1, "Choose at least one account").max(50),
});

export type AccountValidation = { accountId: string; platform: SocialPlatform; displayName: string; handle: string | null; isMock: boolean; status: string } & ValidationResult;

/** Check a draft against each target account's platform rules (via its publisher's validateMedia). */
export async function validateForAccounts(ctx: TenantContext, input: z.input<typeof validateInputSchema>): Promise<AccountValidation[]> {
  assertCan(ctx, "content.create");
  const data = validateInputSchema.parse(input);
  return withTenantTx(ctx.workspaceId, async (tx) => {
    const accounts = await tx.socialAccount.findMany({ where: { id: { in: data.accountIds } } });
    if (accounts.length !== new Set(data.accountIds).size) throw new NotFoundError("Some selected accounts no longer exist");
    const media = await loadPublishMedia(tx, data.mediaAssetIds);
    const post: PublishInput = { text: data.content, media };
    return accounts.map((a) => {
      const base = { accountId: a.id, platform: a.platform, displayName: a.displayName, handle: a.handle, isMock: a.isMock, status: a.status };
      if (a.status === "DISCONNECTED" || a.status === "EXPIRED") {
        return { ...base, ok: false, errors: [{ code: "account_unavailable", message: `This account is ${a.status.toLowerCase()}; reconnect it to publish.` }], warnings: [] };
      }
      let v: ValidationResult;
      try {
        v = publisherForAccount(a).validateMedia(post);
      } catch (err) {
        v = { ok: false, errors: [{ code: "publisher_unavailable", message: (err as Error).message }], warnings: [] };
      }
      return { ...base, ...v };
    });
  });
}
