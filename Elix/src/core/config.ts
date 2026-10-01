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
  username: z.string().min(1).max(16).default("Elix"),
  /** Target server version — a config value, never hard-coded in source. */
  version: z.string().min(1).default("26.2"),
  serverAllowlist: z.array(z.string()).default([]),
});

const serverSchema = z.object({
  /** Default profile name; override with --profile <name> or --host/--port. */
  profile: z.string().nullable().default("main"),
});

const profileSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(25565),
  version: z.string().min(1).default("26.2"),
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
});

const voiceSchema = z.object({
  enabled: z.boolean().default(false),
  textOnlyFallback: z.boolean().default(true),
});

const safetySchema = z.object({
  contentLevel: z.enum(["kid-safe", "adult"]).default("kid-safe"),
  chatRateLimitPer2s: z.number().int().positive().default(1),
});

export const elixConfigSchema = z.object({
  version: z.literal(1),
  bot: botSchema.default({}),
  server: serverSchema.default({}),
  profiles: z.record(z.string(), profileSchema).default({}),
  brain: brainSchema.default({}),
  voice: voiceSchema.default({}),
  safety: safetySchema.default({}),
  persona: z.string().default("config/persona.md"),
  dataDir: z.string().default("data"),
  logLevel: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
});

export type ElixConfig = z.infer<typeof elixConfigSchema>;
export type ServerProfile = z.infer<typeof profileSchema>;

// ---------------------------------------------------------------------------
// models.yaml schema
// ---------------------------------------------------------------------------

const providerNameSchema = z.enum(["groq", "nvidia", "hf", "local"]);

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

/** Get the active server profile. Falls back to a synthetic profile from CLI overrides. */
export function getActiveProfile(
  config: ElixConfig,
  overrides?: { host?: string; port?: number; version?: string },
): ServerProfile & { name: string } {
  const name = overrides?.host ? "(cli)" : (config.server.profile ?? "main");
  const profile = config.profiles[name] ?? config.profiles["main"];
  if (!profile) {
    throw new ConfigError(`No server profile "${name}" found in config/elix.yaml`);
  }
  return {
    name,
    host: overrides?.host ?? profile.host,
    port: overrides?.port ?? profile.port,
    version: overrides?.version ?? profile.version,
    description: profile.description,
  };
}
