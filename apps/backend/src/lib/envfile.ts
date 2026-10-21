import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Folder that contains dist/ (the deployed application root). */
export const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Loads settings from ENV_FILE or <appRoot>/.env when present. cPanel cron jobs do not receive
 * the variables entered in "Setup Node.js App", so a protected .env file (chmod 600, outside
 * public_html) is the single place for configuration. Variables already set are not replaced.
 */
export function loadEnvFile(): void {
  const file = process.env.ENV_FILE ?? join(appRoot, '.env');
  if (existsSync(file)) process.loadEnvFile(file);
}
