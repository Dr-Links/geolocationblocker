import { Prisma, PrismaClient } from "@prisma/client";

/**
 * Database access — three ways in, by trust level:
 *
 *  - `tenantDb(workspaceId)` / `withTenantTx(workspaceId, fn)`: everything a
 *    signed-in user does inside a workspace. Postgres RLS restricts every
 *    tenant table to that workspace, even if a query forgets its `where`.
 *
 *  - `systemDb` / `withSystemTx(fn)`: trusted cross-tenant code only (auth
 *    lookups, signup, admin console, worker, seed). Sets `app.bypass_rls`.
 *
 *  - `db` (raw): no tenant context → tenant tables appear EMPTY and writes fail.
 *    Safe for global tables only (User, Account, Plan, …) and Auth.js.
 *
 * Rules:
 *  - Never call `.$transaction()` on `tenantDb`/`systemDb` (each op already runs
 *    in its own tiny transaction). Use `withTenantTx` / `withSystemTx`.
 *  - Raw SQL ($queryRaw) must run inside `withTenantTx` / `withSystemTx`.
 */

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({ log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"] });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;

export type Tx = Prisma.TransactionClient;

const CUID_ISH = /^[a-z0-9_-]{8,64}$/i;

function assertWorkspaceId(workspaceId: string) {
  if (!CUID_ISH.test(workspaceId)) throw new Error("tenantDb: invalid workspaceId");
}

function setTenant(client: PrismaClient | Tx, workspaceId: string) {
  return client.$executeRaw`SELECT set_config('app.workspace_id', ${workspaceId}, TRUE)`;
}

function setBypass(client: PrismaClient | Tx) {
  return client.$executeRaw`SELECT set_config('app.bypass_rls', 'on', TRUE)`;
}

/** Client whose every model operation runs with `app.workspace_id` set. */
export function tenantDb(workspaceId: string) {
  assertWorkspaceId(workspaceId);
  return db.$extends({
    name: "tenant",
    query: {
      $allModels: {
        async $allOperations({ args, query }) {
          const [, result] = await db.$transaction([setTenant(db, workspaceId), query(args)]);
          return result;
        },
      },
    },
  });
}

export type TenantDb = ReturnType<typeof tenantDb>;

/** Interactive transaction scoped to one workspace. */
export function withTenantTx<T>(
  workspaceId: string,
  fn: (tx: Tx) => Promise<T>,
  options?: { timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel },
): Promise<T> {
  assertWorkspaceId(workspaceId);
  return db.$transaction(async (tx) => {
    await setTenant(tx, workspaceId);
    return fn(tx);
  }, options);
}

function makeSystemDb() {
  return db.$extends({
    name: "system",
    query: {
      $allModels: {
        async $allOperations({ args, query }) {
          const [, result] = await db.$transaction([setBypass(db), query(args)]);
          return result;
        },
      },
    },
  });
}

const globalForSystem = globalThis as unknown as { systemDb?: ReturnType<typeof makeSystemDb> };

/** Cross-tenant client for trusted system code. Every use should be justifiable in review. */
export const systemDb = globalForSystem.systemDb ?? makeSystemDb();
if (process.env.NODE_ENV !== "production") globalForSystem.systemDb = systemDb;

export type SystemDb = typeof systemDb;

/** Interactive cross-tenant transaction for trusted system code. */
export function withSystemTx<T>(
  fn: (tx: Tx) => Promise<T>,
  options?: { timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel },
): Promise<T> {
  return db.$transaction(async (tx) => {
    await setBypass(tx);
    return fn(tx);
  }, options);
}
