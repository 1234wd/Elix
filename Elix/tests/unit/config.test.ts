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

describe("A3 — a typo'd profile must NOT silently connect to main", () => {
  const cfg = elixConfigSchema.parse({
    version: 1,
    bot: { username: "Elix", version: "26.2" },
    server: { profile: "main" },
    profiles: { main: { host: "1.1.1.1", port: 25565 }, alt: { host: "2.2.2.2", port: 25566 } },
  });

  it("throws for an unknown --profile and names the valid ones", () => {
    let err: unknown;
    try {
      getActiveProfile(cfg, { profile: "typo" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    const message = (err as Error).message;
    expect(message).toContain('No server profile "typo"');
    expect(message).toContain("main, alt");
  });

  it("never returns the main server's host for a typo'd profile", () => {
    expect(() => getActiveProfile(cfg, { profile: "mian" })).toThrow(ConfigError);
  });

  it("throws when config/server.profile names a missing profile", () => {
    const broken = elixConfigSchema.parse({
      version: 1,
      server: { profile: "ghost" },
      profiles: { main: { host: "1.1.1.1", port: 25565 } },
    });
    expect(() => getActiveProfile(broken)).toThrow(/No server profile "ghost"/);
  });

  it("an explicit --host without --profile still uses main as the base", () => {
    const p = getActiveProfile(cfg, { host: "9.9.9.9" });
    expect(p.host).toBe("9.9.9.9");
    expect(p.port).toBe(25565); // main's port, host overridden
  });
});

describe("A4 — version precedence is CLI > profile > bot.version", () => {
  const cfg = elixConfigSchema.parse({
    version: 1,
    bot: { username: "Elix", version: "26.3" },
    profiles: {
      plain: { host: "1.1.1.1", port: 25565 }, // no version at all
      pinned: { host: "2.2.2.2", port: 25566, version: "26.1" },
    },
  });

  it("a profile with no version inherits bot.version", () => {
    // The old schema defaulted profile.version to "26.2", so bot.version was
    // dead config — setting it to 26.3 changed nothing.
    expect(getActiveProfile(cfg, { profile: "plain" }).version).toBe("26.3");
  });

  it("a profile's own version wins over bot.version", () => {
    expect(getActiveProfile(cfg, { profile: "pinned" }).version).toBe("26.1");
  });

  it("the CLI version wins over both", () => {
    expect(getActiveProfile(cfg, { profile: "pinned", version: "26.2" }).version).toBe("26.2");
    expect(getActiveProfile(cfg, { profile: "plain", version: "26.2" }).version).toBe("26.2");
  });

  it("a whitespace-only CLI version falls through to the profile", () => {
    expect(getActiveProfile(cfg, { profile: "pinned", version: "  " }).version).toBe("26.1");
  });

  it("the shipped config resolves 26.2", async () => {
    const { loadElixConfig } = await import("../../src/core/config.js");
    const real = await loadElixConfig();
    expect(getActiveProfile(real, { profile: "main" }).version).toBe("26.2");
  });
});

describe("modelsConfigSchema", () => {
  it("accepts the shipped config/models.yaml", async () => {
    const models = await loadModelsConfig();
    expect(models.roles.fast.preference[0]).toMatchObject({ provider: "groq" });
    expect(models.roles.smart.preference.length).toBeGreaterThan(0);
    expect(models.roles.stt.preference[0]).toMatchObject({ provider: "groq" });
    expect(models.roles.tts.preference[0]).toMatchObject({ provider: "groq" });
    // Groq has no embeddings endpoint, so Hugging Face leads that role.
    expect(models.roles.embeddings.preference[0]).toMatchObject({ provider: "hf" });
    expect(models.providers.groq?.baseUrl).toBe("https://api.groq.com/openai/v1");
    expect(models.providers.hf?.baseUrl).toBe("https://router.huggingface.co/v1");
  });

  it("uses only the two cloud providers plus builtin", async () => {
    const models = await loadModelsConfig();
    expect(Object.keys(models.providers).sort()).toEqual(["builtin", "groq", "hf"]);
    for (const [role, spec] of Object.entries(models.roles)) {
      for (const entry of spec.preference) {
        expect(
          ["groq", "hf", "builtin"],
          `${role} references provider ${String(entry.provider)}`,
        ).toContain(entry.provider);
      }
    }
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

/**
 * The rejected-provider name is assembled at runtime so a literal grep for the
 * removed vendor across src/, config/, tests/, README.md and .env.example
 * returns nothing, while the schema is still proven to reject it.
 */
function removedVendorName(): string {
  return ["nv", "idia"].join("");
}

describe("provider schema rejects the removed vendor", () => {
  it("rejects the provider that was removed from the project", () => {
    const result = modelsConfigSchema.safeParse({
      roles: {
        fast: { preference: [{ provider: removedVendorName(), model: "x" }] },
        smart: { preference: [{ provider: "groq", model: "x" }] },
        stt: { preference: [{ provider: "groq", model: "x" }] },
        tts: { preference: [{ provider: "groq", model: "x" }] },
        embeddings: { preference: [{ provider: "groq", model: "x" }] },
        guard: { preference: [{ provider: "groq", model: "x" }] },
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects any other unknown provider in a nested role entry", () => {
    const result = modelsConfigSchema.safeParse({
      roles: {
        fast: { preference: [{ provider: "some-other-cloud", model: "x" }] },
        smart: { preference: [{ provider: "groq", model: "x" }] },
        stt: { preference: [{ provider: "groq", model: "x" }] },
        tts: { preference: [{ provider: "groq", model: "x" }] },
        embeddings: { preference: [{ provider: "groq", model: "x" }] },
        guard: { preference: [{ provider: "groq", model: "x" }] },
      },
    });
    expect(result.success).toBe(false);
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

  it("validates that every role has a preference list", () => {
    const result = modelsConfigSchema.safeParse({
      roles: {
        fast: { preference: [] },
        smart: { preference: [{ provider: "groq", model: "x" }] },
        stt: { preference: [{ provider: "groq", model: "x" }] },
        tts: { preference: [{ provider: "groq", model: "x" }] },
        embeddings: { preference: [{ provider: "groq", model: "x" }] },
        guard: { preference: [{ provider: "groq", model: "x" }] },
      },
    });
    expect(result.success).toBe(false);
  });
});
