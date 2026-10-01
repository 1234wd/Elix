import { pino } from "pino";
import type { ElixConfig } from "./config.js";

/**
 * Shared pino logger. JSON to stdout by default; secrets are redacted.
 * In a future phase this also feeds the dashboard and the episode log.
 */
export function createLogger(config: Pick<ElixConfig, "logLevel">) {
  return pino({
    level: config.logLevel,
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers['x-api-key']",
        "headers.authorization",
        "headers['x-api-key']",
        "*.apiKey",
        "*.api_key",
        "*.token",
      ],
      censor: "[redacted]",
    },
    transport:
      process.env.NODE_ENV === "production"
        ? undefined
        : {
            target: "pino-pretty",
            options: { translateTime: "HH:MM:ss", ignore: "pid,hostname" },
          },
  });
}

export type Logger = ReturnType<typeof createLogger>;
