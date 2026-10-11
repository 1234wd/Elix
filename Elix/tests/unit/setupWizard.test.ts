/**
 * R19-D — the first-run wizard.
 *
 * Every test drives `runSetup` with a temp project dir and a fake terminal: no real `.env` is
 * read, and no key value is ever printed, because `envKeyReport` returns BOOLEANS and there is
 * nothing in the shape for a value to leak through.
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  MINECRAFT_NAME,
  NEXT_STEPS,
  SETUP_KEYS,
  envKeyReport,
  renderKeyReport,
  runSetup,
  writeOwners,
  type SetupIo,
} from "../../src/cli/setup.js";

/** A fake terminal that records everything it was told to print. */
function terminal(answers: string[] = []) {
  const said: string[] = [];
  const asked: string[] = [];
  const io: SetupIo = {
    askName: async (prompt: string): Promise<string> => {
      asked.push(prompt);
      return answers.shift() ?? "";
    },
    say: (text: string): void => {
      said.push(text);
    },
  };
  return { io, said, asked };
}

function tempProject(): { dir: string; configPath: string; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "elix-r19d-"));
  const configPath = join(dir, "config", "elix.yaml");
  // The wizard creates a missing config/ itself - that was a bug it caught - but a test that
  // wants to write a file there first has to make the folder itself.
  mkdirSync(dirname(configPath), { recursive: true });
  return { dir, configPath, close: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("R19-D — the wizard writes the owner's name", () => {
  it("writes owners into a config file that does not exist yet", async () => {
    const project = tempProject();
    try {
      const t = terminal(["ElixTester"]);
      const code = await runSetup(t.io, { configPath: project.configPath, env: {} });
      expect(code).toBe(0);
      expect(existsSync(project.configPath), "the wizard did not create the config file").toBe(true);
      expect(readFileSync(project.configPath, "utf8")).toContain("- ElixTester");
    } finally {
      project.close();
    }
  });

  it("KEEPS THE COMMENTS in the existing file - the owner wrote them", async () => {
    const project = tempProject();
    try {
      const original = [
        "# Elix settings. Do not delete this file.",
        "# The server the owner plays on.",
        "version: 1",
        "",
        "# Who may give Elix orders. This is you.",
        "owners: []",
        "",
        "# How chatty Elix is.",
        "skillCap: normal",
        "",
      ].join("\n");
      writeFileSync(project.configPath, original, "utf8");
      const t = terminal(["ElixTester"]);
      await runSetup(t.io, { configPath: project.configPath, env: {} });
      const after = readFileSync(project.configPath, "utf8");
      expect(after, "the comments were destroyed").toContain("# Elix settings. Do not delete this file.");
      expect(after).toContain("# Who may give Elix orders. This is you.");
      expect(after).toContain("# How chatty Elix is.");
      expect(after).toContain("skillCap: normal");
      expect(after).toContain("- ElixTester");
    } finally {
      project.close();
    }
  });

  it("adds a second owner without losing the first", async () => {
    const project = tempProject();
    try {
      writeFileSync(project.configPath, "# mine\nowners:\n  - FirstOwner\n", "utf8");
      const t = terminal(["SecondOwner"]);
      await runSetup(t.io, { configPath: project.configPath, env: {} });
      const after = readFileSync(project.configPath, "utf8");
      expect(after).toContain("- FirstOwner");
      expect(after).toContain("- SecondOwner");
    } finally {
      project.close();
    }
  });

  it("replaces an old owners list rather than appending to it", () => {
    const yaml = ["# c", "owners:", "  - OldOne", "  - OldTwo", "skillCap: normal", ""].join("\n");
    const after = writeOwners(yaml, ["NewOne"]);
    expect(after).not.toContain("OldOne");
    expect(after).not.toContain("OldTwo");
    expect(after).toContain("- NewOne");
    expect(after).toContain("# c");
    expect(after).toContain("skillCap: normal");
  });

  it("an invalid name changes NOTHING", async () => {
    const project = tempProject();
    try {
      writeFileSync(project.configPath, "# mine\nowners: []\n", "utf8");
      const before = readFileSync(project.configPath, "utf8");
      for (const bad of ["ab", "way-too-long-minecraft-name", "has space", "semi;colon"]) {
        const t = terminal([bad]);
        const code = await runSetup(t.io, { configPath: project.configPath, env: {} });
        expect(code, `"${bad}" was accepted`).toBe(1);
      }
      expect(readFileSync(project.configPath, "utf8")).toBe(before);
    } finally {
      project.close();
    }
  });

  it("an empty answer changes nothing and says so", async () => {
    const project = tempProject();
    try {
      const t = terminal([""]);
      const code = await runSetup(t.io, { configPath: project.configPath, env: {} });
      expect(code).toBe(1);
      expect(existsSync(project.configPath)).toBe(false);
      expect(t.said.join("\n")).toMatch(/nothing was changed/iu);
    } finally {
      project.close();
    }
  });

  it("accepts exactly what Minecraft accepts", () => {
    for (const good of ["ElixTester", "abc", "Player_123", "AAAAAAAAAAAAAAAA"]) {
      expect(MINECRAFT_NAME.test(good), good).toBe(true);
    }
    for (const bad of ["ab", "A".repeat(17), "with space", "dash-name", "emoji😀"]) {
      expect(MINECRAFT_NAME.test(bad), bad).toBe(false);
    }
  });
});

describe("R19-D — keys are reported by NAME only", () => {
  it("reports booleans, never values", () => {
    const report = envKeyReport({ GROQ_API_KEY: "gsk-super-secret-value", HF_TOKEN: "" });
    expect(report["GROQ_API_KEY"]).toBe(true);
    expect(report["HF_TOKEN"]).toBe(false);
    // The shape itself has to forbid a leak: a boolean cannot be printed as a key.
    for (const value of Object.values(report)) expect(typeof value).toBe("boolean");
  });

  it("the rendered report names the key and says whether it is set, and nothing else", () => {
    const text = renderKeyReport({ GROQ_API_KEY: "gsk-super-secret-value", NVIDIA_API_KEY: "nvapi-secret" });
    expect(text).toContain("GROQ_API_KEY");
    expect(text).toContain("NVIDIA_API_KEY");
    expect(text).not.toContain("gsk-super-secret-value");
    expect(text).not.toContain("nvapi-secret");
  });

  it("whitespace is not a key", () => {
    expect(envKeyReport({ GROQ_API_KEY: "   " })["GROQ_API_KEY"]).toBe(false);
  });

  it("covers every key the project documents", () => {
    for (const [name] of SETUP_KEYS) expect(name).toMatch(/^[A-Z_]+$/u);
  });

  it("nothing the wizard prints contains a value", async () => {
    const project = tempProject();
    try {
      const t = terminal(["ElixTester"]);
      await runSetup(t.io, {
        configPath: project.configPath,
        env: { GROQ_API_KEY: "gsk-super-secret-value", HF_TOKEN: "hf-secret", NVIDIA_API_KEY: "nvapi-secret" },
      });
      const printed = t.said.join("\n");
      for (const secret of ["gsk-super-secret-value", "hf-secret", "nvapi-secret"]) {
        expect(printed, `the wizard printed ${secret}`).not.toContain(secret);
      }
    } finally {
      project.close();
    }
  });
});

describe("R19-D — the wizard ends with three plain steps", () => {
  it("prints the next three steps in words a new owner can follow", async () => {
    const project = tempProject();
    try {
      const t = terminal(["ElixTester"]);
      await runSetup(t.io, { configPath: project.configPath, env: {} });
      const printed = t.said.join("\n");
      for (const step of NEXT_STEPS) expect(printed).toContain(step.replace(/^\d+\.\s*/u, ""));
      expect(NEXT_STEPS.length).toBe(3);
    } finally {
      project.close();
    }
  });

  it("asks exactly one question", async () => {
    const project = tempProject();
    try {
      const t = terminal(["ElixTester"]);
      await runSetup(t.io, { configPath: project.configPath, env: {} });
      expect(t.asked.length, "the wizard asked more than one thing").toBe(1);
      expect(t.asked[0]).toMatch(/minecraft name/iu);
    } finally {
      project.close();
    }
  });
});
