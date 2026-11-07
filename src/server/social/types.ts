import type { SocialPlatform } from "@prisma/client";

/** Provider-agnostic publishing contracts. Platform API differences stay in each publisher. */

export type { SocialPlatform };

export interface PublishMedia {
  id: string;
  kind: "IMAGE" | "VIDEO";
  mimeType: string;
  sizeBytes?: number | null;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  /** Publicly fetchable URL (S3 signed URL), when storage supports it. Instagram/TikTok "pull" need this. */
  publicUrl?: string | null;
  /** Loads the bytes, for platforms that require uploading the file. */
  load: () => Promise<Buffer>;
}

export interface PublishInput {
  text: string;
  media: PublishMedia[];
  /** YouTube needs a title; defaults to the first line of the text. */
  title?: string;
}

export interface ValidationIssue {
  code: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string | null;
  /** Absolute expiry; null = doesn't expire / unknown. */
  expiresAt?: Date | null;
  scopes?: string[];
}

export interface ConnectedProfile extends TokenSet {
  platform: SocialPlatform;
  externalId: string;
  displayName: string;
  handle?: string | null;
  avatarUrl?: string | null;
}

export interface AccountCredentials {
  externalId: string;
  handle?: string | null;
  accessToken: string;
  refreshToken?: string | null;
}

export interface PublishResult {
  externalPostId: string;
  url?: string | null;
}

export type ConnectArgs = { code: string; redirectUri: string; codeVerifier: string };

export interface SocialPublisher {
  readonly platform: SocialPlatform;
  readonly isMock: boolean;
  /** Step 1 of connect(): where to send the browser. */
  authorizeUrl(args: { state: string; redirectUri: string; codeChallenge: string }): string;
  /** Step 2 of connect(): exchange the callback code for tokens + profile(s). Meta can return several Pages/IG accounts. */
  connect(args: ConnectArgs): Promise<ConnectedProfile[]>;
  refreshToken(account: AccountCredentials): Promise<TokenSet>;
  validateMedia(post: PublishInput): ValidationResult;
  publish(post: PublishInput, account: AccountCredentials): Promise<PublishResult>;
  /** Cheap authenticated call proving the token still works. */
  checkHealth(account: AccountCredentials): Promise<{ ok: boolean; error?: string }>;
}

/** Normalized publish/connect failure. `retryable` drives the Phase 5 scheduler's backoff. */
export class PublishError extends Error {
  constructor(
    message: string,
    readonly platform: SocialPlatform,
    readonly opts: { retryable: boolean; code?: string; status?: number; authExpired?: boolean } = { retryable: false },
  ) {
    super(message);
    this.name = "PublishError";
  }
  get retryable() {
    return this.opts.retryable;
  }
}
