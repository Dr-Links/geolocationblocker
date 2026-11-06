import pino from "pino";

/** Structured JSON logger. Pipe through `pino-pretty` locally if desired. */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: process.env.SERVICE_NAME ?? "app" },
  redact: {
    paths: ["*.password", "*.passwordHash", "*.accessToken", "*.refreshToken", "*.apiKey", "*.encryptedKey"],
    censor: "[redacted]",
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type Logger = typeof logger;
