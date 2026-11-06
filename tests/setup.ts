import { randomBytes } from "node:crypto";

// Integration tests use a dedicated database: TEST_DATABASE_URL wins over DATABASE_URL.
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.ENCRYPTION_KEY ||= randomBytes(32).toString("base64");
process.env.AUTH_SECRET ||= randomBytes(32).toString("base64");
process.env.LOG_LEVEL ||= "silent";
