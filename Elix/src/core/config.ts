import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load as loadYaml } from "js-yaml";
import { z } from "zod";

/** Project root, resolved from this file so CLI works from any cwd. */
export const PROJECT_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

// ---------------------------------------------------------------------------
// elix.yaml schema
// ---------------------------------------------------------------------------

const botSchema = z.object({
  username: z.string().regex(/^[A-Za-z0-9_]{3,16}$/).default("Elix"),
  /** Target server version — a config value, never hard-coded in source. */
  version: z.string().min(1).default("26.2"),
  serverAllowlist: z.array(z.string()).default([]),
});

const serverSchema = z.object({
  /** Default profile name; override with --profile <name> or --host/--port. */
  profile: z.string().nullable().default("main"),
});

/** Minecraft's default server port, used when only --host is given. */
export const DEFAULT_PORT = 25565;

const profileSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(DEFAULT_PORT),
  /**
   * Deliberately optional with NO default (A4). With `.default("26.2")` every
   * profile had a version, so `bot.version` was dead config — setting it to
   * 26.3 still resolved to 26.2. Precedence is now CLI > profile > bot.version.
   */
  version: z.string().min(1).optional(),
  description: z.string().optional(),
});

const brainSchema = z.object({
  fastMaxTokens: z.number().int().positive().default(1500),
  smartMaxTokens: z.number().int().positive().default(4000),
  timeoutsMs: z
    .object({
      fast: z.number().int().positive().default(6000),
      smart: z.number().int().positive().default(20000),
    })
    .default({ fast: 6000, smart: 20000 }),
  /** Max idle-chatter AI calls per hour (quota saving). */
  idleChatterBudgetPerHour: z.number().int().nonnegative().default(60),
  /**
   * B9: the minimal in-game chat bridge. When false, a player addressing Elix
   * by name gets no reply at all beyond the Phase 2 scripted greeting, so no
   * quota is spent. Greetings, combat and movement never reach a model either
   * way (B6) — they are handled by scripted code.
   */
  chatReplies: z.boolean().default(true),
});

const voiceSchema = z.object({
  enabled: z.boolean().default(false),
  textOnlyFallback: z.boolean().default(true),
});

const safetySchema = z.object({
  contentLevel: z.enum(["kid-safe", "adult"]).default("kid-safe"),
  chatRateLimitPer2s: z.number().int().positive().default(1),
  /**
   * C5: quoted verbatim in a crisis reply, and ONLY when set.
   *
   * Empty by default and there is no default number anywhere in the codebase. An
   * invented helpline sends someone dialling a place that does not exist, which is
   * worse than saying nothing at all — so if this is blank, the reply simply
   * encourages reaching a trusted adult or local emergency services without
   * naming a number.
   */
  helplineText: z.string().max(300).default(""),
  /**
   * Whether Elix may use emoji in chat.
   *
   * Off by default: Minecraft renders most of them as empty boxes, and persona.md
   * describes plain lowercase gamer chat. Live replies were arriving with 🎉🍒 and
   * 🌱✌️, which read as garbage in game. Plain-text faces like :) are unaffected.
   */
  allowEmoji: z.boolean().default(false),
});

const skillCapSchema = z
  .enum(["casual", "normal", "tryhard"])
  .default("normal")
  .describe(
    "Phase 6: how hard Elix plays. Affects reaction delay, aim and PvP aggression. casual is slow and passive, normal is the default, tryhard is fast and fights back.",
  );

export const elixConfigSchema = z.object({
  version: z.literal(1),
  bot: botSchema.default({}),
  server: serverSchema.default({}),
  profiles: z.record(z.string(), profileSchema).default({}),
  brain: brainSchema.default({}),
  voice: voiceSchema.default({}),
  safety: safetySchema.default({}),
  /** Phase 6: reflex + skill layer cap. */
  skillCap: skillCapSchema.default("normal"),
  persona: z.string().default("config/persona.md"),
  dataDir: z.string().default("data"),
  logLevel: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
});

export type ElixConfig = z.infer<typeof elixConfigSchema>;
export type ServerProfile = z.infer<typeof profileSchema>;

// ---------------------------------------------------------------------------
// models.yaml schema
// ---------------------------------------------------------------------------

/**
 * Cloud providers only. Two of them: Groq and Hugging Face.
 *
 * `builtin` is Elix's own scripted fallback code — scripted chat lines and an
 * FTS5-only retrieval path. It is NOT a downloaded model, and it needs no key.
 */
const providerNameSchema = z.enum(["groq", "hf", "builtin"]);

const modelRefSchema = z.object({
  provider: providerNameSchema,
  model: z.string().min(1),
});

const roleSchema = z.object({
  preference: z.array(modelRefSchema).min(1),
});

const providerConfigSchema = z.object({
  baseUrl: z.string().nullable(),
  env: z.string().nullable(),
});

export const modelsConfigSchema = z.object({
  roles: z
    .object({
      fast: roleSchema,
      smart: roleSchema,
      stt: roleSchema,
      tts: roleSchema,
      embeddings: roleSchema,
      guard: roleSchema,
    })
    .strict(),
  providers: z
    .record(providerNameSchema, providerConfigSchema)
    .default({}),
});

export type ModelsConfig = z.infer<typeof modelsConfigSchema>;
export type ModelRole = keyof ModelsConfig["roles"];
export type ProviderName = z.infer<typeof providerNameSchema>;

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

async function readYamlFile(path: string): Promise<unknown> {
  const raw = await readFile(path, "utf8");
  return loadYaml(raw);
}

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly issues?: string[],
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Load and validate config/elix.yaml. Paths are resolved against PROJECT_ROOT. */
export async function loadElixConfig(
  configPath: string = resolve(PROJECT_ROOT, "config", "elix.yaml"),
): Promise<ElixConfig> {
  let raw: unknown;
  try {
    raw = await readYamlFile(configPath);
  } catch (err) {
    throw new ConfigError(
      `Cannot read config file at ${configPath}: ${(err as Error).message}`,
    );
  }
  const parsed = elixConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(
      `Invalid config in ${configPath}:\n  ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("\n  ")}`,
      parsed.error.issues.map((i) => i.message),
    );
  }
  return parsed.data;
}

/** Load and validate config/models.yaml. */
export async function loadModelsConfig(
  modelsPath: string = resolve(PROJECT_ROOT, "config", "models.yaml"),
): Promise<ModelsConfig> {
  let raw: unknown;
  try {
    raw = await readYamlFile(modelsPath);
  } catch (err) {
    throw new ConfigError(`Cannot read models file at ${modelsPath}: ${(err as Error).message}`);
  }
  const parsed = modelsConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(
      `Invalid models config in ${modelsPath}:\n  ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("\n  ")}`,
    );
  }
  return parsed.data;
}

/** Resolve a config-relative path (dataDir, persona) against PROJECT_ROOT. */
export function resolveFromRoot(p: string): string {
  return resolve(PROJECT_ROOT, p);
}

/** Name used for a profile synthesised entirely from CLI flags. */
export const CLI_PROFILE_NAME = "(cli)";

/**
 * Get the active server profile.
 *
 * A3: a named profile that does not exist must NOT silently fall back to `main`
 * — that connected the user to the wrong server while printing the name they
 * asked for.
 *
 * A4: `--host` on its own produces a synthetic `(cli)` profile rather than
 * borrowing main's port and version. `--host 1.2.3.4` alone now means
 * 1.2.3.4:25565 at bot.version, and it works even with no `main` profile.
 */
export function getActiveProfile(
  config: ElixConfig,
  overrides?: {
    host?: string;
    port?: number;
    version?: string;
    username?: string;
    profile?: string;
  },
): ServerProfile & { name: string; username: string; version: string } {
  const username = overrides?.username ?? config.bot.username;

  // Explicit --profile always wins and must exist.
  if (overrides?.profile) {
    const profile = config.profiles[overrides.profile];
    if (!profile) {
      const list =
        Object.keys(config.profiles).length > 0
          ? Object.keys(config.profiles).join(", ")
          : "(none configured)";
      throw new ConfigError(`No server profile "${overrides.profile}". Available: ${list}`);
    }
    return {
      name: overrides.profile,
      host: overrides.host ?? profile.host,
      port: overrides.port ?? profile.port,
      // CLI > profile > bot.version.
      version: overrides.version?.trim() || profile.version || config.bot.version,
      description: profile.description,
      username,
    };
  }

  // --host or --port with no --profile: a synthetic CLI profile (A4).
  if (overrides?.host || overrides?.port) {
    return {
      name: CLI_PROFILE_NAME,
      host: overrides.host ?? "127.0.0.1",
      port: overrides.port ?? DEFAULT_PORT,
      // No profile to borrow from, so the CLI value or bot.version.
      version: overrides.version?.trim() || config.bot.version,
      description: "from command-line flags",
      username,
    };
  }

  // The configured default profile.
  const name = config.server.profile ?? "main";
  const profile = config.profiles[name];
  if (!profile) {
    const list =
      Object.keys(config.profiles).length > 0
        ? Object.keys(config.profiles).join(", ")
        : "(none configured)";
    throw new ConfigError(`No server profile "${name}". Available: ${list}`);
  }
  return {
    name,
    host: profile.host,
    port: profile.port,
    version: overrides?.version?.trim() || profile.version || config.bot.version,
    description: profile.description,
    username,
  };
}
