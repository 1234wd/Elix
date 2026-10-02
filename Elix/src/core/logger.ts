import { createRequire } from "node:module";
import { pino } from "pino";
import type { ElixConfig } from "./config.js";

/**
 * Shared logger.
 *
 * A pino-pretty WORKER transport runs on a libuv thread. Calling process.exit()
 * while that worker is still flushing tears the handle down mid-write, which on
 * Windows aborts the process with
 *   "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)"
 * and exit code -1073740791 (0xC0000409). That turned a successful `elix doctor`
 * into a crash.
 *
 * `pretty({ sync: true })` makes pino-pretty a plain in-process stream with no
 * worker thread, so there is nothing left to tear down and an abrupt exit cannot
 * corrupt the handle. See src/core/exit.ts for the exit helper.
 *
 * This project is `"type": "module"`, so pino-pretty is loaded via
 * createRequire — a bare `require(...)` would throw at runtime.
 */

const require = createRequire(import.meta.url);

const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers['x-api-key']",
  "headers.authorization",
  "headers['x-api-key']",
  "*.apiKey",
  "*.api_key",
  "*.token",
  "*.password",
];

const baseOptions = (level: string) => ({
  level,
  redact: { paths: REDACT_PATHS, censor: "[redacted]" },
});

export function createLogger(config: Pick<ElixConfig, "logLevel">) {
  // Production (or an explicit override) wants plain JSON for log shipping.
  if (process.env["NODE_ENV"] === "production" || process.env["ELIX_LOG_JSON"] === "1") {
    return pino(baseOptions(config.logLevel));
  }

  // Development: pretty-print synchronously in-process (no worker thread).
  // pino-pretty's module.exports is the factory function itself, and it also
  // hangs a `default` property off itself — either works, `.default` first.
  const mod = require("pino-pretty") as {
    default?: (opts: Record<string, unknown>) => NodeJS.WritableStream;
  } & ((opts: Record<string, unknown>) => NodeJS.WritableStream);
  const factory = mod.default ?? mod;
  if (typeof factory !== "function") {
    // Unexpected shape — fall back to plain JSON rather than crashing.
    return pino(baseOptions(config.logLevel));
  }
  return pino(
    baseOptions(config.logLevel),
    factory({
      sync: true,
      translateTime: "HH:MM:ss",
      ignore: "pid,hostname",
    }),
  );
}

export type Logger = ReturnType<typeof createLogger>;