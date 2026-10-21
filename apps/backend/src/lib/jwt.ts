import { SignJWT, exportPKCS8, generateKeyPair, importPKCS8, jwtVerify, type CryptoKey, type KeyObject } from 'jose';

export const ACCESS_TOKEN_TTL_SECONDS = 600;
const ISSUER = 'emailplatform';

type Key = CryptoKey | KeyObject;

export interface AccessClaims {
  sub: string;
  sid: string;
}

export class TokenSigner {
  private constructor(
    private readonly privateKey: Key,
    private readonly publicKey: Key,
  ) {}

  static async create(pem?: string): Promise<TokenSigner> {
    if (pem) {
      const priv = await importPKCS8(pem, 'EdDSA', { extractable: true });
      const { createPublicKey } = await import('node:crypto');
      const pub = createPublicKey(pem);
      return new TokenSigner(priv, pub);
    }
    // Development/test only: an ephemeral key (tokens become invalid on restart).
    const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    return new TokenSigner(privateKey, publicKey);
  }

  static async generatePem(): Promise<string> {
    const { privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    return exportPKCS8(privateKey);
  }

  async signAccess(claims: AccessClaims): Promise<{ token: string; expiresAt: Date }> {
    const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000);
    const token = await new SignJWT({ sid: claims.sid })
      .setProtectedHeader({ alg: 'EdDSA' })
      .setSubject(claims.sub)
      .setIssuer(ISSUER)
      .setAudience('app')
      .setIssuedAt()
      .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
      .sign(this.privateKey);
    return { token, expiresAt };
  }

  async verifyAccess(token: string): Promise<AccessClaims | null> {
    try {
      const { payload } = await jwtVerify(token, this.publicKey, { issuer: ISSUER, audience: 'app', algorithms: ['EdDSA'] });
      if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') return null;
      return { sub: payload.sub, sid: payload.sid };
    } catch {
      return null;
    }
  }
}
