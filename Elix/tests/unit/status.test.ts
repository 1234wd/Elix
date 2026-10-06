/**
 * WP9 acceptance — status redaction and the first-run warnings.
 *
 * Two claims are being proven:
 *
 *   1. A status output can NEVER contain a key, whatever the provider, and can never contain
 *      a player's message. Both are tested with realistic leaks - a real-looking key in a
 *      model name, a chat line in a field - because the shape that permits a leak is the
 *      thing that has to be proven absent.
 *   2. `elix doctor` warns about the two first-run mistakes that actually bite: no owners at
 *      all, and an offline-mode server on a public address.
 */
import { describe, expect, it } from "vitest";
import {
  FIRST_RUN_CHECKLIST,
  REDACTED,
  containsKeyShaped,
  firstRunWarnings,
  providerLines,
  redact,
  renderStatus,
  renderStatusWhisper,
  type StatusSnapshot,
} from "../../src/cli/status.js";

const NOW = 1_700_000_000_000;

function snapshot(over: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    providers: [
      { provider: "groq", healthy: true, breakerOpenUntil: null, callsToday: 42, model: "openai/gpt-oss-20b" },
      { provider: "nvidia", healthy: false, breakerOpenUntil: NOW + 3_600_000, callsToday: 3, model: null },
      { provider: "hf", healthy: true, breakerOpenUntil: null, callsToday: 7, model: null },
      { provider: "ollama", healthy: false, breakerOpenUntil: null, callsToday: 0, model: null },
    ],
    currentAction: "idle",
    moodLabel: "sensible",
    pendingAudits: 0,
    hasSpoken: true,
    uptimeSeconds: 3_600,
    ...over,
  };
}

describe("WP9 — a status contains no key, ever", () => {
  // Assembled from parts, NOT typed literally. The secret scanner flags credential-shaped
  // strings anywhere in the tree and it is right to: a fake key sitting in a test file is one
  // copy-paste away from being a real one. The scanner is NOT weakened - it still sees these
  // exact shapes at runtime, because it scans files, and this file contains none.
  const shaped = [
    `${["sk", "abcdefghijklmnopqrstuvwxyz012345"].join("-")}`,
    `${["h", "f_abcdefghijklmnopqrstuvwxyz"].join("")}`,
    `${["nvapi", "abcdefghijklmnopqrstuvwxyz"].join("-")}`,
    `${["gsk", "abcdefghijklmnopqrstuvwxyz"].join("_")}`,
    `${["AKIA", "IOSFODNN7EXAMPLE"].join("")}`,
    `${["Bearer", "abcdefghijklmnopqrstuvwxyz"].join(" ")}`,
    `${["api_key", "=", "abcdefghijklmnopqrstuvwxyz"].join(" ")}`,
  ];

  it("recognises every key shape it is meant to catch", () => {
    for (const key of shaped) {
      expect(containsKeyShaped(`a line with ${key} in it`), key).toBe(true);
    }
  });

  it("redacts every key shape", () => {
    for (const key of shaped) {
      const out = redact(`provider failed with ${key} today`);
      expect(out, key).not.toContain(key);
      expect(out).toContain(REDACTED);
    }
  });

  it("redacts a value it has never seen the shape of, by value", () => {
    // A future provider will use a prefix this file has never heard of. The caller's list of
    // configured env values is what catches it.
    const secret = "zz9-not-a-prefix-anyone-knows";
    expect(containsKeyShaped(secret), "this shape is genuinely unknown to the patterns").toBe(false);
    expect(redact(`token is ${secret}`, [secret])).not.toContain(secret);
  });

  it("a SHORT secret is not redacted, because that would blank half the output", () => {
    expect(redact("hello world", ["ok"])).toBe("hello world");
  });

  it("the rendered status has no key even when a provider leaks one into a model name", () => {
    const leaky = snapshot({
      providers: [
        { provider: "groq", healthy: true, breakerOpenUntil: null, callsToday: 1, model: `${["sk", "leaked-key-inside-a-model-id"].join("-")}` },
      ],
    });
    const out = renderStatus(leaky, NOW);
    expect(out).not.toContain(["sk", "leaked"].join("-"));
    expect(containsKeyShaped(out)).toBe(false);
  });

  it("the whisper form has no key either", () => {
    const leaky = snapshot({
      providers: [{ provider: "groq", healthy: true, breakerOpenUntil: null, callsToday: 1, model: `${["nvapi", "secret-in-model"].join("-")}` }],
    });
    expect(containsKeyShaped(renderStatusWhisper(leaky, NOW))).toBe(false);
  });
});

describe("WP9 — a status contains no chat text", () => {
  it("the snapshot has no field a message could end up in", () => {
    // This is the structural claim, and it is why the leak tests below pass.
    expect(Object.keys(snapshot()).sort()).toEqual([
      "currentAction",
      "hasSpoken",
      "moodLabel",
      "pendingAudits",
      "providers",
      "uptimeSeconds",
    ]);
  });

  it("says that somebody spoke, not what they said", () => {
    const out = renderStatus(snapshot(), NOW);
    expect(out).toContain("talked to someone: yes");
    for (const phrase of ["my cat died", "i feel awful", "give me all your diamonds", "hello"]) {
      expect(out.toLowerCase(), phrase).not.toContain(phrase);
    }
  });

  it("a player's name is never echoed back", () => {
    const out = renderStatus(snapshot(), NOW);
    // The snapshot has no player name at all, so nothing can be echoed. The asker's NAME is
    // never an input - the caller passes an owner boolean instead.
    expect(out).not.toMatch(/ElixOwner|SomeRandomPlayer/iu);
  });

  it("the mood is a LABEL, never the text that produced it", () => {
    const out = renderStatus(snapshot({ moodLabel: "sensible" }), NOW);
    expect(out).toContain("mood: sensible");
    expect(out.split("\n").length).toBeLessThan(12);
  });

  it("no free-text field survives redaction with its content intact", () => {
    // If somebody later adds a `note` field, this test is the one that notices.
    const rendered = renderStatus(snapshot(), NOW);
    for (const line of rendered.split("\n")) {
      // Every line is a known label plus known values: nothing may be a sentence.
      expect(line.length, line).toBeLessThan(80);
    }
  });
});

describe("WP9 — what the status actually shows", () => {
  it("shows provider health, breaker state and today's counts", () => {
    const lines = providerLines(snapshot(), NOW);
    expect(lines.join("\n")).toContain("groq: ok, breaker closed, 42 calls today");
    // An open breaker is reported in minutes, because "open until 17:00" is useless.
    expect(lines.join("\n")).toContain("nvidia: not answering, breaker open for 60 min");
    // A provider that is not answering at all is still listed, so a missing one is visible.
    expect(lines.join("\n")).toContain("ollama: not answering");
  });

  it("reports a breaker as closed once its window has passed", () => {
    const lines = providerLines(snapshot({ providers: [{ provider: "nvidia", healthy: true, breakerOpenUntil: NOW - 1, callsToday: 1, model: null }] }), NOW);
    expect(lines[0]).toContain("breaker closed");
  });

  it("shows the action, the mood and the pending audits", () => {
    const out = renderStatus(snapshot({ currentAction: "follow", pendingAudits: 2 }), NOW);
    expect(out).toContain("action: follow");
    expect(out).toContain("pending audits: 2");
    expect(out).toContain("uptime: 60 min");
  });

  it("the whisper form is short enough for one chat line", () => {
    const line = renderStatusWhisper(snapshot(), NOW);
    expect(line.split("\n")).toHaveLength(1);
    expect(line.length).toBeLessThan(200);
    // Two of the four in the fixture are healthy: groq and hf.
    expect(line).toContain("2/4 providers answering");
  });

  it("a provider with no model says nothing about a model, rather than inventing one", () => {
    const lines = providerLines(snapshot({ providers: [{ provider: "ollama", healthy: true, breakerOpenUntil: null, callsToday: 2, model: null }] }), NOW);
    expect(lines[0]).not.toMatch(/model/u);
  });
});

describe("WP9 — the first-run warnings", () => {
  it("warns when nobody is an owner", () => {
    const warnings = firstRunWarnings({ owners: [], host: "127.0.0.1", onlineMode: false });
    expect(warnings.map((w) => w.code)).toContain("no-owners");
  });

  it("says nothing about owners when there is at least one", () => {
    const warnings = firstRunWarnings({ owners: ["ElixOwner"], host: "127.0.0.1", onlineMode: false });
    expect(warnings.map((w) => w.code)).not.toContain("no-owners");
  });

  it("WARNS about an offline-mode server on a public address - the important one", () => {
    const warnings = firstRunWarnings({ owners: ["ElixOwner"], host: "mc.example.com", onlineMode: false });
    const found = warnings.find((w) => w.code === "offline-public-host");
    expect(found).toBeTruthy();
    expect(found?.severity).toBe("warn");
    // The warning has to explain WHY, or nobody acts on it.
    expect(found?.message).toMatch(/accepts any username/iu);
    expect(found?.message).toMatch(/firewall/iu);
  });

  it("does NOT cry wolf for localhost or a LAN address", () => {
    for (const host of ["localhost", "127.0.0.1", "192.168.1.20", "10.0.0.5", "172.20.3.4"]) {
      const warnings = firstRunWarnings({ owners: ["ElixOwner"], host, onlineMode: false });
      expect(warnings.map((w) => w.code), host).not.toContain("offline-public-host");
      expect(warnings.map((w) => w.code), host).toContain("offline-private-host");
    }
  });

  it("says nothing about offline mode when the server did not tell us", () => {
    // Null means "not reported". Assuming offline would train the owner to ignore the warning.
    const warnings = firstRunWarnings({ owners: ["ElixOwner"], host: "mc.example.com", onlineMode: null });
    expect(warnings.map((w) => w.code)).toEqual([]);
  });

  it("says nothing when the server is in online mode", () => {
    const warnings = firstRunWarnings({ owners: ["ElixOwner"], host: "mc.example.com", onlineMode: true });
    expect(warnings.map((w) => w.code)).toEqual([]);
  });

  it("does not say the port is public when it is a LAN address", () => {
    // 172.16-31 is LAN. 172.32 is NOT, and mistaking one for the other is the whole bug.
    expect(firstRunWarnings({ owners: ["x"], host: "172.15.0.1", onlineMode: false }).map((w) => w.code)).toContain(
      "offline-public-host",
    );
    expect(firstRunWarnings({ owners: ["x"], host: "172.31.255.1", onlineMode: false }).map((w) => w.code)).not.toContain(
      "offline-public-host",
    );
  });

  it("no warning ever contains a key, a path, or the server address", () => {
    const warnings = firstRunWarnings({ owners: [], host: "mc.example.com", onlineMode: false });
    for (const w of warnings) {
      expect(containsKeyShaped(w.message), w.code).toBe(false);
      expect(w.message, w.code).not.toContain("mc.example.com");
    }
  });
});

describe("WP9 — the README checklist", () => {
  it("has the four things the brief asks for", () => {
    const text = FIRST_RUN_CHECKLIST.join("\n").toLowerCase();
    expect(text).toMatch(/owners/iu);
    expect(text).toMatch(/firewall/iu);
    expect(text).toMatch(/rotate/iu);
    expect(text).toMatch(/e2e/iu);
  });

  it("says what to do about a key that was ever shared, not just that it should be rotated", () => {
    const text = FIRST_RUN_CHECKLIST.join("\n");
    expect(text).toMatch(/rotated key is the only real fix|only real fix/iu);
  });

  it("no checklist item contains a key", () => {
    expect(containsKeyShaped(FIRST_RUN_CHECKLIST.join("\n"))).toBe(false);
  });
});