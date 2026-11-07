/**
 * Create (or update the password of) the runtime database login used by the
 * app and worker. Run once per database, as the owner, after migrations:
 *
 *   DIRECT_DATABASE_URL=<owner url> APP_DB_PASSWORD=<strong password> npm run db:app-role
 *
 * The login is a member of `app_user` (created by the RLS migration): it can
 * read and write rows, subject to row-level security, but can't alter tables,
 * disable RLS, or read the migrations table. Point DATABASE_URL at it.
 */
import { PrismaClient } from "@prisma/client";

const user = process.env.APP_DB_USER ?? "postpilot_app";
const password = process.env.APP_DB_PASSWORD ?? "";
const ownerUrl = process.env.DIRECT_DATABASE_URL;

if (!ownerUrl) throw new Error("Set DIRECT_DATABASE_URL to the owner connection string.");
if (!/^[a-z_][a-z0-9_]{0,62}$/.test(user)) throw new Error("APP_DB_USER must be a lowercase identifier.");
if (password.length < 16) throw new Error("Set APP_DB_PASSWORD (16+ characters, e.g. openssl rand -hex 24).");

// Role DDL can't take bind parameters; the name is validated above and the password is quoted as a literal.
const literal = `'${password.replace(/'/g, "''")}'`;

const db = new PrismaClient({ datasourceUrl: ownerUrl });
try {
  const [{ exists } = { exists: false }] = await db.$queryRaw<{ exists: boolean }[]>`SELECT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') AS exists`;
  if (!exists) throw new Error("Role app_user is missing. Run `npm run db:deploy` (migrations) first.");
  const [{ found } = { found: false }] = await db.$queryRaw<{ found: boolean }[]>`SELECT EXISTS (SELECT FROM pg_roles WHERE rolname = ${user}) AS found`;
  await db.$executeRawUnsafe(found ? `ALTER ROLE "${user}" WITH LOGIN PASSWORD ${literal}` : `CREATE ROLE "${user}" LOGIN PASSWORD ${literal} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
  await db.$executeRawUnsafe(`GRANT app_user TO "${user}"`);
  const url = new URL(ownerUrl);
  url.username = user;
  url.password = "APP_DB_PASSWORD";
  const hint = url.toString().replace(":APP_DB_PASSWORD@", ":<APP_DB_PASSWORD, URL-encoded>@");
  console.log(`${found ? "Updated" : "Created"} role "${user}". Set DATABASE_URL to:\n  ${hint}`);
} finally {
  await db.$disconnect();
}
