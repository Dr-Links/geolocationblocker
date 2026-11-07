import { Prisma } from "@prisma/client";
import { withSystemTx, withTenantTx, type Tx } from "@/lib/db";

/**
 * Time-series and breakdowns for dashboards. Raw SQL with date_trunc in UTC;
 * days without rows are filled with zeros. Workspace analytics run inside a
 * tenant transaction, so RLS scopes even the raw SQL.
 */

export interface Daily {
  day: string; // YYYY-MM-DD (UTC)
  values: number[];
}

export function dayKeys(days: number, end = new Date()) {
  const out: string[] = [];
  const base = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  for (let i = days - 1; i >= 0; i--) out.push(new Date(base - i * 86_400_000).toISOString().slice(0, 10));
  return out;
}

function fill(keys: string[], rows: { day: Date; k?: string | null; n: bigint | number }[], series: string[]): Daily[] {
  const m = new Map<string, number[]>(keys.map((d) => [d, series.map(() => 0)]));
  for (const r of rows) {
    const d = r.day.toISOString().slice(0, 10);
    const idx = series.length === 1 ? 0 : series.indexOf(r.k ?? "");
    const v = m.get(d);
    if (v && idx >= 0) v[idx] = Number(r.n);
  }
  return keys.map((day) => ({ day, values: m.get(day)! }));
}

const since = (days: number) => new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()) - (days - 1) * 86_400_000);

type Row = { day: Date; k?: string | null; n: bigint };
const GEN_TYPES = ["TEXT", "IMAGE", "VIDEO"];

async function generationsByDay(tx: Tx, days: number, workspaceId?: string) {
  // RLS already scopes tenant transactions; the explicit filter keeps the index usable.
  const ws = workspaceId ? Prisma.sql`AND "workspaceId" = ${workspaceId}` : Prisma.empty;
  const rows = await tx.$queryRaw<Row[]>`
    SELECT date_trunc('day', "completedAt" AT TIME ZONE 'UTC') AS day, "type"::text AS k, count(*) AS n
    FROM "GenerationRequest" WHERE status = 'SUCCEEDED' AND "completedAt" >= ${since(days)} ${ws}
    GROUP BY 1, 2`;
  return fill(dayKeys(days), rows, GEN_TYPES);
}

async function publishedByDay(tx: Tx, days: number) {
  const rows = await tx.$queryRaw<Row[]>`
    SELECT date_trunc('day', "publishedAt" AT TIME ZONE 'UTC') AS day, count(*) AS n
    FROM "PostTarget" WHERE status = 'PUBLISHED' AND "publishedAt" >= ${since(days)} GROUP BY 1`;
  return fill(dayKeys(days), rows, ["published"]);
}

async function platformOutcomes(tx: Tx, days: number) {
  const rows = await tx.$queryRaw<{ platform: string; status: string; n: bigint }[]>`
    SELECT s.platform::text AS platform, t.status::text AS status, count(*) AS n
    FROM "PostTarget" t JOIN "SocialAccount" s ON s.id = t."socialAccountId"
    WHERE t.status IN ('PUBLISHED','FAILED') AND t."updatedAt" >= ${since(days)}
    GROUP BY 1, 2`;
  const by = new Map<string, { published: number; failed: number }>();
  for (const r of rows) {
    const e = by.get(r.platform) ?? { published: 0, failed: 0 };
    if (r.status === "PUBLISHED") e.published = Number(r.n);
    else e.failed = Number(r.n);
    by.set(r.platform, e);
  }
  return [...by.entries()].map(([platform, v]) => ({ platform, ...v, total: v.published + v.failed, rate: v.published / Math.max(1, v.published + v.failed) })).sort((a, b) => b.total - a.total);
}

export async function platformAnalytics(days = 30) {
  return withSystemTx(async (tx) => {
    const signups = await tx.$queryRaw<Row[]>`
      SELECT date_trunc('day', "createdAt" AT TIME ZONE 'UTC') AS day, count(*) AS n FROM "User" WHERE "createdAt" >= ${since(days)} GROUP BY 1`;
    const credits = await tx.$queryRaw<{ n: bigint | null }[]>`
      SELECT -sum(delta) AS n FROM "CreditLedgerEntry" WHERE "createdAt" >= ${since(days)} AND reason IN ('generation','refund')`;
    const failed7 = await tx.postTarget.count({ where: { status: "FAILED", updatedAt: { gte: since(7) } } });
    return {
      signups: fill(dayKeys(days), signups, ["signups"]),
      published: await publishedByDay(tx, days),
      generations: await generationsByDay(tx, days),
      platforms: await platformOutcomes(tx, days),
      creditsConsumed: Math.max(0, Number(credits[0]?.n ?? 0)),
      failedPublishes7d: failed7,
    };
  });
}

export async function workspaceAnalytics(workspaceId: string, days = 30) {
  return withTenantTx(workspaceId, async (tx) => ({
    // RLS scopes these raw queries to the workspace (PostTarget via its Post).
    published: await publishedByDay(tx, days),
    generations: await generationsByDay(tx, days, workspaceId),
    platforms: await platformOutcomes(tx, days),
  }));
}
