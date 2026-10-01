import type { ElixConfig } from "../core/config.js";
import type { ServerProfile } from "../core/config.js";
import type { Logger } from "../core/logger.js";
import { pingServer, type PingResult } from "./ping.js";
import { classifyDisconnect, parseKickReason } from "./reconnect.js";
import { applyCompat26_2 } from "./compat26_2.js";

/**
 * Elix's mineflayer bot wrapper.
 *
 * Factory pattern: every reconnect creates a fresh bot with all handlers.
 * Only the "end" handler schedules reconnects. "kicked" records the reason.
 * Shutdown is an awaited Lifecycle cleanup.
 */

export interface BotOptions {
  config: ElixConfig;
  profile: ServerProfile & { name: string };
  log: Logger;
}

export interface BotStatus {
  connected: boolean;
  username: string;
  version: string;
  protocol: number;
  software: string;
  ping: number;
  position: { x: number; y: number; z: number };
  health: number;
  dimension: string;
}

// Track unknown IDs we've already logged (log each unique ID once)
const loggedUnknownBlocks = new Set<number>();
const loggedUnknownEntities = new Set<number>();

export async function runBot(opts: BotOptions): Promise<() => Promise<void>> {
  const { config, profile, log } = opts;

  // --- Pre-flight: ping the server ---
  log.info({ host: profile.host, port: profile.port }, "pinging server");
  let pingResult: PingResult;
  try {
    pingResult = await pingServer(profile.host, profile.port);
  } catch (err) {
    log.error({ err }, "server ping failed — is the server up?");
    throw new Error(`Cannot reach ${profile.host}:${profile.port}: ${(err as Error).message}`);
  }

  log.info(
    { version: pingResult.version, protocol: pingResult.protocol, software: pingResult.software, players: pingResult.players },
    "server ping OK",
  );

  if (pingResult.protocol !== 776) {
    log.warn({ expected: 776, got: pingResult.protocol }, `server protocol ${pingResult.protocol} != 776 (26.2) — may be unstable`);
  }

  // --- Bot factory ---
  let reconnectAttempt = 0;
  let shutdownRequested = false;
  let currentBot: import("mineflayer").Bot | null = null;
  let statusInterval: ReturnType<typeof setInterval> | null = null;

  const createBot = async () => {
    const { createBot: mcCreateBot } = await import("mineflayer");
    const { pathfinder } = await import("mineflayer-pathfinder");

    applyCompat26_2();

    const bot = mcCreateBot({
      username: config.bot.username,
      host: profile.host,
      port: profile.port,
      version: "26.2",
      auth: "offline",
      checkTimeoutInterval: 30_000,
    });

    bot.loadPlugin(pathfinder);
    currentBot = bot;

    // --- Online-mode detection ---
    bot._client?.on("encryption_begin", () => {
      log.error("server sent encryption request — this is an online-mode server");
      log.error("Elix only joins offline-mode servers. Stopping.");
      bot.quit("online-mode server");
    });

    // --- Unknown block/entity handling ---
    bot.on("error", (err: Error) => {
      const msg = err.message ?? String(err);
      if (msg.includes("Unknown block") || msg.includes("unknown block")) {
        const match = msg.match(/(\d+)/);
        const id = match ? Number.parseInt(match[1]!, 10) : -1;
        if (!loggedUnknownBlocks.has(id)) {
          loggedUnknownBlocks.add(id);
          log.warn({ blockId: id }, "unknown block ID from server (logged once)");
        }
        return;
      }
      if (msg.includes("Unknown entity") || msg.includes("unknown entity")) {
        const match = msg.match(/(\d+)/);
        const id = match ? Number.parseInt(match[1]!, 10) : -1;
        if (!loggedUnknownEntities.has(id)) {
          loggedUnknownEntities.add(id);
          log.warn({ entityId: id }, "unknown entity ID from server (logged once)");
        }
        return;
      }
      log.error({ err }, "bot error");
    });

    // --- Spawn ---
    bot.once("spawn", () => {
      reconnectAttempt = 0;
      log.info(
        {
          position: bot.entity?.position,
          health: bot.health,
          dimension: bot.game?.dimension,
          version: pingResult.version,
          protocol: pingResult.protocol,
        },
        "spawned",
      );

      setTimeout(() => {
        if (!shutdownRequested) {
          bot.chat("gm! elix here — ready to play");
          log.info("sent greeting");
        }
      }, 2000);

      setTimeout(() => {
        if (shutdownRequested) return;
        void walkAndBack(bot, log);
      }, 5000);

      setTimeout(() => {
        if (shutdownRequested) return;
        void lookAround(bot, log);
      }, 8000);
    });

    // --- Chat ---
    bot.on("chat", (username: string, message: string) => {
      if (username === config.bot.username) return;
      log.info({ username, message }, "chat message");

      const lower = message.toLowerCase();
      if (
        (lower.includes("hi") || lower.includes("hello") || lower.includes("hey")) &&
        lower.includes(config.bot.username.toLowerCase())
      ) {
        setTimeout(() => {
          if (!shutdownRequested) {
            bot.chat(`hi ${username}!`);
            log.info({ username }, "replied to greeting");
          }
        }, 1000 + Math.random() * 2000);
      }
    });

    // --- Kicked: record reason only ---
    bot.on("kicked", (reason: string) => {
      const parsed = parseKickReason(reason);
      log.warn({ reason: parsed }, "kicked from server");
      const info = classifyDisconnect(parsed, reconnectAttempt);
      log.info({ kind: info.kind, shouldRetry: info.shouldRetry, reason: parsed }, "disconnect classified");
    });

    // --- End: the ONLY place that schedules reconnects ---
    bot.on("end", (reason: string) => {
      if (shutdownRequested) {
        log.info("disconnected (shutdown requested)");
        return;
      }
      const parsed = parseKickReason(reason);
      log.warn({ reason: parsed }, "connection ended");

      const info = classifyDisconnect(parsed, reconnectAttempt);
      if (info.shouldRetry) {
        reconnectAttempt++;
        log.info({ attempt: reconnectAttempt, retryAfterMs: info.retryAfterMs }, "reconnecting with backoff");
        setTimeout(() => {
          if (!shutdownRequested) {
            void createBot();
          }
        }, info.retryAfterMs);
      } else {
        if (info.kind === "whitelist") {
          log.error(`not whitelisted — run: whitelist add ${config.bot.username}`);
        } else if (info.kind === "ban") {
          log.error("banned from server — not retrying");
        } else if (info.kind === "online_mode") {
          log.error("online-mode server — Elix only joins offline-mode servers");
        } else if (info.kind === "captcha") {
          log.error("captcha/anti-bot check detected — stopping (not bypassing)");
        }
        shutdownRequested = true;
      }
    });

    // --- Status interval ---
    statusInterval = setInterval(() => {
      if (shutdownRequested || !bot.entity) return;
      log.info(
        {
          position: { x: Math.floor(bot.entity.position.x), y: Math.floor(bot.entity.position.y), z: Math.floor(bot.entity.position.z) },
          health: bot.health,
          dimension: bot.game?.dimension,
          ping: bot.player?.ping ?? 0,
        },
        "status",
      );
    }, 30_000);

    return bot;
  };

  // --- Shutdown handler ---
  const shutdown = async () => {
    shutdownRequested = true;
    log.info("shutdown requested");
    if (statusInterval) clearInterval(statusInterval);

    const bot = currentBot;
    if (bot) {
      try {
        bot.chat("gtg, cya");
        log.info("sent goodbye");
      } catch {
        // ignore
      }
      await new Promise<void>((resolvePromise) => {
        setTimeout(() => {
          bot.quit();
          log.info("bot quit");
          // Wait for "end" event (3s timeout)
          const timer = setTimeout(() => {
            log.warn("end event timeout — forcing exit");
            resolvePromise();
          }, 3000);
          bot.once("end", () => {
            clearTimeout(timer);
            log.info("bot ended");
            resolvePromise();
          });
        }, 1000);
      });
    }
    log.info("shutdown complete");
  };

  // Start
  log.info({ host: profile.host, port: profile.port, username: config.bot.username, version: "26.2" }, "connecting");
  await createBot();

  // Return cleanup function for Lifecycle
  return shutdown;
}

/** Walk ~10 blocks in a safe direction and back. */
async function walkAndBack(bot: import("mineflayer").Bot, log: Logger): Promise<void> {
  try {
    const { GoalNear } = await import("mineflayer-pathfinder").then((m) => m.default.goals);

    const pos = bot.entity.position;
    const target = new GoalNear(pos.x + 10, pos.y, pos.z, 1);

    log.info({ from: pos, to: { x: pos.x + 10, y: pos.y, z: pos.z } }, "walking 10 blocks");
    await bot.pathfinder.goto(target);
    log.info({ position: bot.entity.position }, "reached destination");

    const backTarget = new GoalNear(pos.x, pos.y, pos.z, 1);
    log.info("walking back");
    await bot.pathfinder.goto(backTarget);
    log.info({ position: bot.entity.position }, "back at start");
  } catch (err) {
    log.warn({ err }, "walk failed (may be blocked or in the air)");
  }
}

/** Look around naturally — rotate the head smoothly. */
function lookAround(bot: import("mineflayer").Bot, log: Logger): Promise<void> {
  return new Promise((resolvePromise) => {
    const startYaw = bot.entity.yaw;
    let angle = 0;
    const interval = setInterval(() => {
      angle += 0.3;
      if (angle >= Math.PI * 2) {
        clearInterval(interval);
        bot.look(startYaw, 0, true);
        log.info("finished looking around");
        resolvePromise();
        return;
      }
      bot.look(startYaw + angle, 0, false);
    }, 50);
  });
}
