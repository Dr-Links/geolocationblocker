export const TEST_DB = 'emailplatform_test';

export function testEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    PUBLIC_API_URL: 'http://api.test',
    ADMIN_WEB_URL: 'http://admin.test',
    DB_HOST: process.env.TEST_PG_HOST ?? 'localhost',
    DB_PORT: process.env.TEST_PG_PORT ?? '5432',
    DB_NAME: TEST_DB,
    DB_USER_OWNER: 't_owner',
    DB_USER_AUTH: 't_auth',
    DB_USER_API: 't_api',
    DB_USER_ADMIN: 't_admin',
    DB_USER_WORKER: 't_worker',
    DB_PASSWORD_OWNER: 'test',
    DB_PASSWORD_AUTH: 'test',
    DB_PASSWORD_API: 'test',
    DB_PASSWORD_ADMIN: 'test',
    DB_PASSWORD_WORKER: 'test',
    ...extra,
  };
}
