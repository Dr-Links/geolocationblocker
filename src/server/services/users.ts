import { Prisma, WorkspaceRole } from "@prisma/client";
import { db } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/lib/password";
import { slugify } from "@/lib/utils";
import { signInSchema, signUpSchema, type SignUpInput } from "@/lib/validation/auth";
import { recordAudit } from "./audit";
import { randomBytes } from "node:crypto";

export class EmailTakenError extends Error {
  constructor() {
    super("An account with this email already exists");
  }
}

async function uniqueSlug(tx: Prisma.TransactionClient, name: string) {
  const base = slugify(name) || "workspace";
  for (let i = 0; i < 5; i++) {
    const slug = i === 0 ? base : `${base}-${randomBytes(3).toString("hex")}`;
    if (!(await tx.workspace.findUnique({ where: { slug }, select: { id: true } }))) return slug;
  }
  return `${base}-${randomBytes(6).toString("hex")}`;
}

/**
 * Creates a user, their first workspace (as WORKSPACE_ADMIN), and a subscription
 * on the default "free" plan if one exists. Atomic.
 */
export async function registerUser(input: SignUpInput) {
  const data = signUpSchema.parse(input);
  const passwordHash = await hashPassword(data.password);

  try {
    return await db.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { email: data.email, name: data.name, passwordHash },
      });
      const workspace = await tx.workspace.create({
        data: {
          name: data.workspaceName,
          slug: await uniqueSlug(tx, data.workspaceName),
          memberships: { create: { userId: user.id, role: WorkspaceRole.WORKSPACE_ADMIN } },
        },
      });
      const freePlan = await tx.plan.findUnique({ where: { key: "free" } });
      if (freePlan) {
        await tx.subscription.create({ data: { workspaceId: workspace.id, planId: freePlan.id } });
      }
      await recordAudit(
        { action: "auth.signup", actorId: user.id, workspaceId: workspace.id, targetType: "User", targetId: user.id },
        tx,
      );
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
