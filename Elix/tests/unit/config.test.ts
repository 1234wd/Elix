import { describe, it, expect } from "vitest";
import {
  elixConfigSchema,
  modelsConfigSchema,
  loadElixConfig,
  loadModelsConfig,
  ConfigError,
  getActiveProfile,
  PROJECT_ROOT,
} from "../../src/core/config.js";
import { resolve } from "node:path";

describe("elixConfigSchema", () => {
  it("accepts the shipped config/elix.yaml", async () => {
    const cfg = await loadElixConfig();
    expect(cfg.version).toBe(1);
    expect(cfg.bot.username).toBe("Elix");
    expect(cfg.bot.version).toBe("26.2");
    expect(cfg.server.profile).toBe("main");
    expect(cfg.profiles["main"]?.host).toBe("145.241.127.222");
    expect(cfg.profiles["main"]?.port).toBe(25565);
  });

  it("applies defaults to a minimal object", () => {
    const cfg = elixConfigSchema.parse({ version: 1 });
    expect(cfg.bot.username).toBe("Elix");
    expect(cfg.safety.contentLevel).toBe("kid-safe");
    expect(cfg.brain.timeoutsMs.fast).toBe(6000);
    expect(cfg.brain.idleChatterBudgetPerHour).toBe(60);
  });

  it("rejects an invalid config with readable issues", () => {
    const result = elixConfigSchema.safeParse({ version: 2, profiles: { main: { host: "", port: 99999 } } });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("version");
      expect(paths).toContain("profiles.main.port");
    }
  });

  it("rejects an unreadable config file with ConfigError", async () => {
    await expect(loadElixConfig(resolve(PROJECT_ROOT, "config", "nope.yaml"))).rejects.toBeInstanceOf(
      ConfigError,
    );
  });
});

describe("getActiveProfile", () => {
  it("returns the main profile by default", () => {
    const cfg = elixConfigSchema.parse({
      version: 1,
      profiles: { main: { host: "1.2.3.4", port: 25565 } },
    });
    const p = getActiveProfile(cfg);
    expect(p.name).toBe("main");
    expect(p.host).toBe("1.2.3.4");
  });

  it("applies CLI overrides", () => {
    const cfg = elixConfigSchema.parse({
      version: 1,
      profiles: { main: { host: "1.2.3.4", port: 25565 } },
    });
    const p = getActiveProfile(cfg, { host: "5.6.7.8", port: 25566 });
    expect(p.host).toBe("5.6.7.8");
    expect(p.port).toBe(25566);
  });

  it("throws when the profile does not exist", () => {
    const cfg = elixConfigSchema.parse({ version: 1, server: { profile: "nonexistent" } });
    expect(() => getActiveProfile(cfg)).toThrow(ConfigError);
  });
});

describe("modelsConfigSchema", () => {
  it("accepts the shipped config/models.yaml", async () => {
    const models = await loadModelsConfig();
    expect(models.roles.fast.preference[0]).toMatchObject({ provider: "groq" });
    expect(models.roles.smart.preference.length).toBeGreaterThan(0);
    expect(models.roles.stt.preference[0]).toMatchObject({ provider: "groq" });
    expect(models.roles.tts.preference[0]).toMatchObject({ provider: "nvidia" });
    expect(models.roles.embeddings.preference[0]).toMatchObject({ provider: "nvidia" });
    expect(models.providers.groq?.baseUrl).toBe("https://api.groq.com/openai/v1");
  });

  it("rejects an unknown provider", () => {
    const result = modelsConfigSchema.safeParse({
      roles: {
        fast: { preference: [{ provider: "not-a-provider", model: "x" }] },
        smart: { preference: [{ provider: "groq", model: "x" }] },
        stt: { preference: [{ provider: "groq", model: "x" }] },
        tts: { preference: [{ provider: "groq", model: "x" }] },
        embeddings: { preference: [{ provider: "groq", model: "x" }] },
        guard: { preference: [{ provider: "groq", model: "x" }] },
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing role", () => {
    const result = modelsConfigSchema.safeParse({
      roles: {
        fast: { preference: [{ provider: "groq", model: "x" }] },
      },
    });
    expect(result.success).toBe(false);
  });
});
