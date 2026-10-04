/**
 * The forced wellbeing path, end to end through ChatBridge.
 *
 * The unit tests in wellbeing.test.ts prove the detector and the templates. These
 * prove the thing that actually matters: that the path FORCES the reply, and that
 * every failure mode lands on the template rather than on a joke.
 */
import { describe, expect, it, vi } from "vitest";
import { ChatBridge, type MemoryHook } from "../../src/brain/bridge.js";
import type { BrainRouter } from "../../src/brain/router.js";
import type { CompletionResult } from "../../src/brain/types.js";
import { checkWellbeingReply } from "../../src/social/wellbeing.js";

const noLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
} as unknown as import("../../src/core/logger.js").Logger;

/** A router whose chat completion can be made to fail in each way that matters. */
function routerThat(
  reply: (() => string | null) | null,
): { router: BrainRouter; calls: () => number } {
  let calls = 0;
  const router = {
    complete: async (): Promise<CompletionResult> => {
      calls++;
      if (!reply) throw new Error("provider unavailable");
      return {
        text: reply(),
        provider: "groq",
        model: "test",
        usedFallback: false,
      } as unknown as CompletionResult;
    },
  } as unknown as BrainRouter;
  return { router, calls: () => calls };
}

/** Records what memory was told, so we can prove nothing raw is stored. */
function recordingMemory() {
  const wellbeing: string[] = [];
  const all: Array<{ text: string; player?: string | null }> = [];
  const memory: MemoryHook = {
    record: (i) => {
      all.push({ text: i.text, player: i.player });
      return all.length;
    },
    context: () => "",
    preference: () => null,
    capturePreference: () => null,
    known: () => true,
    recordWellbeing: (i) => wellbeing.push(i.text),
  };
  return { memory, wellbeing, all };
}

describe("C5 — the wellbeing reply is FORCED, ahead of everything else", () => {
  it("a crisis line short-circuits the normal flow entirely", async () => {
    const { memory, wellbeing, all } = recordingMemory();
    const { router, calls } = routerThat(() => "i'm here for you");
    const bridge = new ChatBridge({ router, username: "Elix", log: noLog, memory });

    const out = await bridge.handle("Ali", "i want to die", undefined);

    expect(out.replied).toBe(true);
    expect(out.reason).toBe("wellbeing-crisis");
    expect(calls()).toBe(1);
    // The ONE thing stored is the redacted note, and the raw words are nowhere.
    expect(wellbeing).toEqual(["Ali seemed really down"]);
    expect(JSON.stringify(all)).not.toMatch(/die/i);
    expect(checkWellbeingReply(out.text ?? "")).toEqual({ clean: true, why: "ok" });
  });

  it("a concern line is also forced", async () => {
    const { memory } = recordingMemory();
    const { router } = routerThat(() => "i'm here, want to talk about it?");
    const bridge = new ChatBridge({ router, username: "Elix", log: noLog, memory });
    const out = await bridge.handle("Ali", "honestly nobody cares about me", undefined);
    expect(out.reason).toBe("wellbeing-concern");
  });

  it("ordinary chat is NOT diverted into the wellbeing path", async () => {
    const { memory, wellbeing } = recordingMemory();
    const { router } = routerThat(() => "nice build!");
    const bridge = new ChatBridge({ router, username: "Elix", log: noLog, memory });
    const out = await bridge.handle("Ali", "that creeper killed me", undefined);
    expect(out.reason).not.toMatch(/^wellbeing-/);
    expect(wellbeing).toEqual([]);
  });

  it("a PLAYER DOWN line forces the reply even when it is not addressed to Elix", async () => {
    // The detector runs on every line. Someone saying this in general chat is not
    // talking to Elix, but he can hear it.
    const { memory } = recordingMemory();
    const { router } = routerThat(() => null);
    const bridge = new ChatBridge({ router, username: "Elix", log: noLog, memory });
    const out = await bridge.handle("Ali", "i want to die", undefined);
    expect(out.reason).toBe("wellbeing-crisis");
  });
});

describe("C5 — every failure lands on the template", () => {
  it("provider DOWN: the template is used", async () => {
    const { memory } = recordingMemory();
    const { router, calls } = routerThat(null); // every completion throws
    const bridge = new ChatBridge({ router, username: "Elix", log: noLog, memory });

    const out = await bridge.handle("Ali", "i want to die", undefined);

    expect(calls()).toBe(1);
    expect(out.replied).toBe(true);
    expect(checkWellbeingReply(out.text ?? "")).toEqual({ clean: true, why: "ok" });
    expect(out.text).toMatch(/\b(?:trust|adult|emergency|crisis line)\b/i);
  });

  it("the LLM JOKES: rejected, template used", async () => {
    const { memory } = recordingMemory();
    const { router } = routerThat(() => "haha yeah that sucks, anyway wanna mine?");
    const bridge = new ChatBridge({ router, username: "Elix", log: noLog, memory });

    const out = await bridge.handle("Ali", "i want to die", undefined);

    expect(out.text).not.toMatch(/haha|anyway/i);
    expect(checkWellbeingReply(out.text ?? "")).toEqual({ clean: true, why: "ok" });
  });

  it("the LLM breaks character: rejected, template used", async () => {
    const { memory } = recordingMemory();
    const { router } = routerThat(() => "as an ai i don't have the capacity for that");
    const bridge = new ChatBridge({ router, username: "Elix", log: noLog, memory });
    const out = await bridge.handle("Ali", "i want to die", undefined);
    expect(out.text).not.toMatch(/as an ai/i);
  });

  it("the LLM invents a number: rejected, template used", async () => {
    const { memory } = recordingMemory();
    const { router } = routerThat(() => "call 0800 1111 now, i'm here for you");
    const bridge = new ChatBridge({ router, username: "Elix", log: noLog, memory });
    const out = await bridge.handle("Ali", "i want to die", undefined);
    expect(out.text).not.toMatch(/\d{4,}/);
  });

  it("the LLM emits emoji: rejected, template used", async () => {
    const { memory } = recordingMemory();
    const { router } = routerThat(() => "i'm here for you 🙂");
    const bridge = new ChatBridge({ router, username: "Elix", log: noLog, memory });
    const out = await bridge.handle("Ali", "i want to die", undefined);
    expect(out.text).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it("a good LLM phrasing IS used, so it still sounds like Elix", async () => {
    const { memory } = recordingMemory();
    // Two sentences: trimChatReply deliberately caps chat at two, and a reply in
    // a crisis should not be a paragraph anyway. It must also carry what the vision
    // requires - presence, a real person, and RIGHT NOW - or the template is used.
    const phrasing =
      "hey, i'm here and i'm listening. please talk to a trusted adult right now.";
    const { router } = routerThat(() => phrasing);
    const bridge = new ChatBridge({ router, username: "Elix", log: noLog, memory });
    const out = await bridge.handle("Ali", "i want to die", undefined);
    expect(out.text).toBe(phrasing);
  });

  it("the reply NEVER contains a joke marker, whatever happened", async () => {
    const memory = recordingMemory().memory;
    const replies = [
      null, // provider down
      () => "lol",
      () => "haha that's wild",
      () => "jk",
      () => "😀",
      () => "",
      () => "ok",
    ];
    for (const reply of replies) {
      const { router } = routerThat(reply);
      const bridge = new ChatBridge({
        router,
        username: "Elix",
        log: noLog,
        memory,
        random: () => 0,
      });
      const out = await bridge.handle("Ali", "i want to kill myself", undefined);
      expect(out.text, JSON.stringify(reply)).toBeDefined();
      expect(out.text, JSON.stringify(reply)).not.toMatch(/\b(?:lol|lmao|haha|jk)\b/i);
      expect(out.text, JSON.stringify(reply)).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });
});

describe("C5 — the helpline is only ever the owner's", () => {
  it("is absent by default and never invented", async () => {
    const { memory } = recordingMemory();
    const { router } = routerThat(null);
    const bridge = new ChatBridge({ router, username: "Elix", log: noLog, memory, random: () => 0 });
    const out = await bridge.handle("Ali", "i want to die", undefined);
    expect(out.text).not.toMatch(/\d/);
  });

  it("is quoted verbatim when configured", async () => {
    const { memory } = recordingMemory();
    const { router } = routerThat(null);
    const bridge = new ChatBridge({
      router,
      username: "Elix",
      log: noLog,
      memory,
      helplineText: "childline on 0800 1111",
      random: () => 0,
    });
    const out = await bridge.handle("Ali", "i want to die", undefined);
    expect(out.text).toContain("childline on 0800 1111");
  });
});

describe("C5 — the memory note is written once per session", async () => {
  it("a second low message does not add a second note", async () => {
    const { memory, wellbeing } = recordingMemory();
    const { router } = routerThat(null);
    const bridge = new ChatBridge({ router, username: "Elix", log: noLog, memory, random: () => 0 });

    await bridge.handle("Ali", "i want to die", undefined);
    await bridge.handle("Ali", "nobody cares about me", undefined);
    await bridge.handle("Ali", "i feel so alone", undefined);

    expect(wellbeing).toEqual(["Ali seemed really down"]);
  });

  it("a different player gets their own note", async () => {
    const { memory, wellbeing } = recordingMemory();
    const { router } = routerThat(null);
    const bridge = new ChatBridge({ router, username: "Elix", log: noLog, memory, random: () => 0 });
    await bridge.handle("Ali", "i want to die", undefined);
    await bridge.handle("Zed", "nobody cares about me", undefined);
    expect(wellbeing).toHaveLength(2);
  });
});

describe("C5 — the log never carries the message", () => {
  it("logs the level and the player only", async () => {
    const warns: unknown[][] = [];
    const log = {
      ...noLog,
      warn: (obj: unknown, msg?: string) => {
        warns.push([obj, msg]);
      },
    } as unknown as import("../../src/core/logger.js").Logger;
    const { memory } = recordingMemory();
    const { router } = routerThat(null);
    const bridge = new ChatBridge({ router, username: "Elix", log, memory });

    await bridge.handle("Ali", "i am going to kill myself", undefined);

    const dumped = JSON.stringify(warns);
    expect(dumped).toContain("wellbeing");
    expect(dumped).toContain("Ali");
    for (const word of ["kill", "myself", "die"]) {
      expect(dumped.toLowerCase(), `log leaked "${word}"`).not.toContain(word);
    }
  });
});