import { describe, it, expect } from "vitest";
import {
  checkNodeVersion,
  checkFfmpeg,
  checkApiKeys,
  checkLiveApiKeys,
  checkServer,
  checkVersionData,
  runDoctor,
  renderDoctor,
  type CheckResult,
} from "../../src/core/doctor.js";
import { elixConfigSchema } from "../../src/core/config.js";

const config = elixConfigSchema.parse({
  version: 1,
  profiles: { main: { host: "145.241.127.222", port: 25565 } },
});

describe("checkNodeVersion", () => {
  it("passes on node 24", () => {
    expect(checkNodeVersion("v24.19.0").status).toBe("ok");
  });
  it("fails on node 18", () => {
    const r = checkNodeVersion("v18.0.0");
    expect(r.status).toBe("fail");
    expect(r.note).toContain(">= 22");
  });
  it("warns on unparseable input", () => {
    expect(checkNodeVersion("banana").status).toBe("warn");
  });
});

describe("checkFfmpeg", () => {
  it("passes when system ffmpeg exists", async () => {
    const fakeExec = async () => ({ stdout: "ffmpeg version 6.0", stderr: "" });
    const r = await checkFfmpeg(fakeExec as never);
    expect(r.status).toBe("ok");
  });
  it("passes when ffmpeg-static is available (no system ffmpeg)", async () => {
    const fakeExec = async () => {
      throw new Error("not found");
    };
    const r = await checkFfmpeg(fakeExec as never);
    // ffmpeg-static is installed in this project, so this should pass
    expect(r.status).toBe("ok");
  });
});

describe("checkApiKeys", () => {
  it("warns when no keys are present", () => {
    const r = checkApiKeys({});
    expect(r.status).toBe("warn");
  });
  it("passes when at least one key is present", () => {
    const r = checkApiKeys({ GROQ_API_KEY: "gsk_test" });
    expect(r.status).toBe("ok");
    expect(r.note).toContain("Groq");
  });
});

describe("checkLiveApiKeys", () => {
  it("warns when no keys to test", async () => {
    const r = await checkLiveApiKeys({});
    expect(r.status).toBe("warn");
  });
  it("passes when all live calls succeed", async () => {
    const fakeCall = async () => true;
    const r = await checkLiveApiKeys({ GROQ_API_KEY: "x" }, fakeCall);
    expect(r.status).toBe("ok");
    expect(r.note).toContain("groq: ok");
  });
  it("warns when a live call fails", async () => {
    const fakeCall = async () => false;
    const r = await checkLiveApiKeys({ GROQ_API_KEY: "x" }, fakeCall);
    expect(r.status).toBe("warn");
    expect(r.note).toContain("groq: FAIL");
  });
});

describe("checkServer", () => {
  it("passes with version and protocol info", async () => {
    const fakePing = async () => ({
      version: "26.2",
      protocol: 776,
      software: "Paper",
      motd: "A Minecraft Server",
      players: { online: 1, max: 20 },
    });
    const r = await checkServer("127.0.0.1", 25565, fakePing);
    expect(r.status).toBe("ok");
    expect(r.note).toContain("26.2");
    expect(r.note).toContain("776");
  });
  it("warns when ping fails", async () => {
    const fakePing = async () => {
      throw new Error("timeout");
    };
    const r = await checkServer("127.0.0.1", 25565, fakePing);
    expect(r.status).toBe("warn");
  });
});

describe("checkVersionData", () => {
  it("passes for the vendored 26.2 data", () => {
    const r = checkVersionData("26.2");
    expect(r.status).toBe("ok");
    expect(r.note).toContain("776");
  });

  it("fails when there is no data for the configured version", () => {
    const r = checkVersionData("1.2.3");
    expect(r.status).toBe("fail");
    expect(r.note).toContain("no minecraft-data");
  });
});

describe("checkServer", () => {
  it("warns when the server protocol differs from the expected one (A11)", async () => {
    const fakePing = async () => ({
      version: "26.1",
      protocol: 775,
      software: "Paper",
      motd: "",
      players: { online: 0, max: 20 },
    });
    const r = await checkServer("127.0.0.1", 25565, fakePing, "26.2");
    expect(r.status).toBe("warn");
    expect(r.note).toContain("expected 776");
    expect(r.note).toContain("775");
  });

  it("includes the MOTD when the server has one (A13)", async () => {
    const fakePing = async () => ({
      version: "Paper 26.2",
      protocol: 776,
      software: "Paper",
      motd: "Ali's server",
      players: { online: 0, max: 20 },
    });
    const r = await checkServer("127.0.0.1", 25565, fakePing, "26.2");
    expect(r.status).toBe("ok");
    expect(r.note).toContain("Ali's server");
  });
});

describe("runDoctor", () => {
  it("runs all six checks with injected mocks", async () => {
    const fakeExec = async () => {
      throw new Error("not found");
    };
    const fakePing = async () => ({
      version: "26.2",
      protocol: 776,
      software: "Paper",
      motd: "",
      players: { online: 0, max: 20 },
    });
    const fakeLive = async () => true;
    const results = await runDoctor({
      config,
      env: { GROQ_API_KEY: "x" },
      execFile: fakeExec as never,
      ping: fakePing,
      liveApiCall: fakeLive,
    });
    expect(results).toHaveLength(6);
    const names = results.map((r) => r.name);
    expect(names).toContain("node");
    expect(names).toContain("version-data");
    expect(names).toContain("ffmpeg");
    expect(names).toContain("api-keys");
    expect(names).toContain("api-live");
    expect(names).toContain("server");
  });
});

describe("renderDoctor", () => {
  it("summarizes failures and warnings", () => {
    const results: CheckResult[] = [
      { name: "a", status: "ok", note: "fine" },
      { name: "b", status: "warn", note: "meh" },
      { name: "c", status: "fail", note: "bad" },
    ];
    const out = renderDoctor(results);
    expect(out).toContain("1 failing, 1 warnings");
    expect(out).toContain("✗");
  });
});
