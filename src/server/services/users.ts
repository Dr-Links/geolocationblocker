import { Prisma } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { db, withSystemTx } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/lib/password";
import { signInSchema, signUpSchema, signUpWithInviteSchema } from "@/lib/validation/auth";
import { recordAudit } from "./audit";
import { acceptInvitationTx } from "./members";
import { createWorkspaceForUser } from "./workspaces";

export class EmailTakenError extends Error {
  constructor() {
    super("An account with this email already exists");
  }
}

export type RegisterInput =
  | { name: string; email: string; password: string; workspaceName: string; inviteToken?: undefined }
  | { name: string; email: string; password: string; workspaceName?: string; inviteToken: string };

/**
 * Create a user, atomically with either:
 *  - a new workspace they administer (normal signup), or
 *  - membership in the workspace they were invited to (invite signup).
 */
export async function registerUser(input: RegisterInput) {
  const data = input.inviteToken
    ? { ...signUpWithInviteSchema.parse(input), workspaceName: undefined }
    : signUpSchema.parse(input);
  const passwordHash = await hashPassword(data.password);

  try {
    return await withSystemTx(async (tx) => {
      const user = await tx.user.create({ data: { email: data.email, name: data.name, passwordHash } });
      await recordAudit({ action: "auth.signup", actorId: user.id, targetType: "User", targetId: user.id }, tx);

      const workspace = input.inviteToken
        ? await acceptInvitationTx(tx, { userId: user.id, email: user.email, token: input.inviteToken })
        : await createWorkspaceForUser(user.id, { name: data.workspaceName! }, tx);
      return { user, workspace };
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") throw new EmailTakenError();
    throw err;
  }
}

// Always run a bcrypt compare so unknown emails take as long as known ones (no user enumeration by timing).
let dummyHash: Promise<string> | undefined;
const getDummyHash = () => (dummyHash ??= hashPassword(randomBytes(16).toString("hex")));

/** Returns the user if credentials are valid and the account is active, else null. */
export async function verifyCredentials(raw: unknown) {
  const parsed = signInSchema.safeParse(raw);
  if (!parsed.success) return null;
  const user = await db.user.findUnique({ where: { email: parsed.data.email } });
  const ok = await verifyPassword(parsed.data.password, user?.passwordHash ?? (await getDummyHash()));
  if (!user || !user.passwordHash || !ok || user.disabledAt) return null;
  await db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  return user;
}
