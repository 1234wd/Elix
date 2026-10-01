import { describe, it, expect } from "vitest";
import { resolveTargetVersion, expectedProtocol, hasDataFor } from "../../src/connection/version.js";
import { elixConfigSchema } from "../../src/core/config.js";

/**
 * A11: "the version is a config value; 26.3 must be a one-line change".
 * Nothing in src/ may hard-code 26.2 or 776.
 */

const cfg = elixConfigSchema.parse({
  version: 1,
  bot: { username: "Elix", version: "26.2" },
  profiles: { main: { host: "1.2.3.4", port: 25565, version: "26.2" } },
});

describe("resolveTargetVersion — CLI > profile > bot", () => {
  it("uses the profile version when no CLI flag is given", () => {
    expect(resolveTargetVersion(cfg, { version: "26.2" })).toBe("26.2");
  });

  it("uses a different profile version when the profile differs", () => {
    expect(resolveTargetVersion(cfg, { version: "26.1" })).toBe("26.1");
  });

  it("the CLI flag wins over the profile", () => {
    expect(resolveTargetVersion(cfg, { version: "26.1" }, "26.2")).toBe("26.2");
  });

  it("falls back to bot.version when the profile has none", () => {
    expect(resolveTargetVersion(cfg, { version: "" })).toBe("26.2");
  });

  it("ignores a whitespace-only CLI flag", () => {
    expect(resolveTargetVersion(cfg, { version: "26.2" }, "   ")).toBe("26.2");
  });
});

describe("expectedProtocol — read from minecraft-data, never hard-coded", () => {
  it("returns 776 for the vendored 26.2 data", () => {
    expect(expectedProtocol("26.2")).toBe(776);
  });

  it("returns 0 for a version with no data instead of throwing", () => {
    expect(expectedProtocol("99.99")).toBe(0);
  });

  it("hasDataFor agrees with expectedProtocol", () => {
    expect(hasDataFor("26.2")).toBe(true);
    expect(hasDataFor("99.99")).toBe(false);
  });
});

describe("the shipped config drives the version", () => {
  it("config/elix.yaml targets 26.2 and its profile agrees", async () => {
    const { loadElixConfig } = await import("../../src/core/config.js");
    const real = await loadElixConfig();
    expect(real.bot.version).toBe("26.2");
    expect(real.profiles["main"]?.version).toBe("26.2");
    // And that config value resolves to the protocol we actually speak.
    expect(expectedProtocol(resolveTargetVersion(real, real.profiles["main"]!))).toBe(776);
  });
});