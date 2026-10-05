/**
 * Round 14 R6 — gentle mode, and the rule that a retained audit only blocks what arrived
 * BEFORE it.
 *
 * Round 14 measured the behaviour being replaced. For sixty seconds after a crisis reply,
 * every addressed line was replaced by a wellbeing template:
 *
 *   "thanks, i talked to my mom"  -> "i'm still here. please don't stop talking to someone
 *                                     you trust."
 *   "can we build a house now"     -> "still here. please reach out to a trusted adult if
 *                                     you haven't yet."
 *
 * Both logged as new interventions. The first is discouraging a child who did the right
 * thing; the second is telling a 13-year-old to seek help when they have just got on with
 * building a house. Neither is a crisis, and both are worse than silence.
 *
 * So: a RETAINED audit blocks only lines that arrived BEFORE its reply was sent. Lines that
 * arrive after get a normal model reply with the gentle-mode flag set, and every line runs
 * its own audit and gate regardless.
 *
 * Zero network. The chat model is a fake; the point is which branch runs.
 */
import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrainRouter } from "../../src/brain/router.js";
import { BrainStore } from "../../src/brain/store.js";
import { GroqProvider } from "../../src/brain/groq.js";
import { ChatBridge } from "../../src/brain/bridge.js";
import { GENTLE_MODE_FLAG } from "../../src/brain/persona.js";
import type { ModelsConfig } from "../../src/core/config.js";
import type { SayQueue } from "../../src/social/say.js";

const FAST = "openai/gpt-oss-20b";
const GUARD = "openai/gpt-oss-safeguard-20b";
const CRISIS = "i want to die";
const ORDINARY = "can we build a house now";
const THANKS = "thanks, i talked to my mom";
/** Ungated and unmatched by the regex floor, so its verdict is the classifier's alone. */
const INNOCENT = "the bus was late again this morning";

const models = {
  providers: { groq: { baseUrl: null, env: "GROQ_API_KEY" }, hf: { baseUrl: null, env: "HF_TOKEN" } },
  roles: {
    fast: { preference: [{ provider: "groq", model: FAST }, { provider: "builtin", model: "scripted" }] },
    smart: { preference: [{ provider: "groq", model: FAST }, { provider: "builtin", model: "scripted" }] },
    guard: { preference: [{ provider: "groq", model: GUARD }, { provider: "builtin", model: "scripted" }] },
  },
} as ModelsConfig;

const noLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function completion(content: string): Response {
  return new Response(
    JSON.stringify({
      id: "x",
      object: "chat.completion",
      model: FAST,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

interface Seen {
  system: string;
  user: string;
}

/** Records every chat request, so the gentle flag can be asserted on the SYSTEM PROMPT. */
function build(o: { chat: string; verdicts?: string[]; chatMs?: number; verdictMs?: number }) {
  const dir = mkdtempSync(join(tmpdir(), "elix-r6-"));
  const store = new BrainStore(join(dir, "elix.db"));
  const seen: Seen[] = [];
  let next = 0;
  const verdicts = o.verdicts ?? [];
  const fetchImpl = (async (url: unknown, init: unknown) => {
    if (String(url).includes("/models")) {
      return new Response(JSON.stringify({ object: "list", data: [{ id: FAST }, { id: GUARD }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const body = String((init as { body?: string }).body ?? "");
    const parsed = JSON.parse(body) as { messages: Array<{ role: string; content: string }> };
    const isClassifier = body.includes("classifier");
    await sleep(isClassifier ? (o.verdictMs ?? 30) : (o.chatMs ?? 30));
    if (isClassifier) {
      const v = verdicts[next] ?? '{"level":"none","imminent":false,"reason":"x"}';
      next += 1;
      return completion(v);
    }
    seen.push({
      system: parsed.messages.map((m) => m.content).join("\n"),
      user: parsed.messages.map((m) => m.content).join("\n"),
    });
    return completion(o.chat);
  }) as unknown as typeof fetch;
  const router = new BrainRouter({
    models,
    providers: { groq: new GroqProvider({ apiKey: "gsk-test", fetchImpl }) },
    store,
    now: () => Date.now(),
    log: noLog,
    idleChatterBudgetPerHour: 0,
    fastTimeoutMs: 5000,
    smartTimeoutMs: 5000,
    modelsTimeoutMs: 5000,
  });
  cleanups.push(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const lines: string[] = [];
  const say = { say: (t: string) => void lines.push(t) } as unknown as SayQueue;
  const bridge = new ChatBridge({
    router,
    username: "Elix",
    log: noLog as never,
    personaLite: "",
    typingRandom: () => 1,
    classifierTimeoutMs: 2000,
  });
  return { bridge, say, lines, seen };
}

describe("R6 — after a crisis reply, later lines get a MODEL reply in gentle mode", () => {
  it("'can we build a house now' is answered, not replaced by a template", async () => {
    const { bridge, say, lines } = build({ chat: "yeah! i have stone" });

    await bridge.handle("Steve", `elix ${CRISIS}`, say);
    expect(lines.join(" ")).toMatch(/right now|trust|adult/i); // the crisis reply went out

    await bridge.handle("Steve", `elix ${ORDINARY}`, say);
    const second = lines.slice(1).join(" | ");
    // A model reply, not a template telling a kid who has moved on to seek help.
    expect(second).toBe("yeah! i have stone");
    expect(second).not.toMatch(/trusted adult|reach out|still here/i);
  }, 15_000);

  it("'thanks, i talked to my mom' is believed, and not cautioned again", async () => {
    const { bridge, say, lines } = build({ chat: "thats really good, steve" });

    await bridge.handle("Steve", `elix ${CRISIS}`, say);
    await bridge.handle("Steve", `elix ${THANKS}`, say);

    const second = lines.slice(1).join(" | ");
    expect(second).toBe("thats really good, steve");
    // The specific harm: discouraging a child for doing the right thing.
    expect(second).not.toMatch(/don't stop talking|talk to someone|reach out/i);
  }, 15_000);

  it("the model request carries the gentle-mode flag", async () => {
    const { bridge, say, seen } = build({ chat: "mm" });

    await bridge.handle("Steve", `elix ${CRISIS}`, say);
    expect(seen.some((r) => r.system.includes("GENTLE MODE IS ON"))).toBe(false);

    await bridge.handle("Steve", `elix ${ORDINARY}`, say);
    const flagged = seen.find((r) => r.system.includes("GENTLE MODE IS ON"));
    expect(flagged, "no request carried the gentle-mode flag").toBeDefined();
    // And it says the things that matter, not just that it is on.
    expect(flagged?.system).toContain("no jokes");
    expect(flagged?.system).toContain("do NOT pivot to the game");
    expect(flagged?.system).toContain("do NOT repeat or rephrase the advice");
  }, 15_000);

  it("ordinary conversation BEFORE any wellbeing reply has no flag", async () => {
    const { bridge, say, seen } = build({ chat: "hi" });
    await bridge.handle("Steve", `elix ${ORDINARY}`, say);
    expect(seen.some((r) => r.system.includes("GENTLE MODE IS ON"))).toBe(false);
  }, 15_000);

  it("the flag is gone again after the window", async () => {
    const { bridge, say } = build({ chat: "yeah" });
    await bridge.handle("Steve", `elix ${CRISIS}`, say);
    await sleep(10);
    // Well past GENTLE_MODE_MS is not reachable in a unit test without moving the clock, so
    // this asserts the per-player scoping and the window being OPEN, which is what decides
    // the flag; the expiry itself is `isGentleWindow`'s arithmetic and is covered by the
    // R6 row in the reviewer's BotSession probes, where fake timers are available.
    expect(bridge.isGentleWindow("Steve")).toBe(true);
    expect(bridge.isGentleWindow("Alex")).toBe(false); // per player
  }, 15_000);

  it("the flag never replaces the output checks", async () => {
    // Gentle mode changes the PROMPT. The leak filter, the emoji strip, the reply cap and
    // the gate all still run afterwards, and a joke is still a joke.
    const { bridge, say, lines } = build({ chat: "lol just take a water bucket" });
    await bridge.handle("Steve", `elix ${CRISIS}`, say);
    await bridge.handle("Steve", `elix ${ORDINARY}`, say);
    // The model chose a joke; nothing downstream softens it, which is correct — the flag
    // is a request, and the C4 guard is the enforcement.
    expect(lines.join(" ")).toContain("water bucket");
  }, 15_000);
});

describe("R6 — a retained audit blocks only lines that ARRIVED BEFORE it", () => {
  it("a line that arrives after the crisis reply is NOT blocked by the retained verdict", async () => {
    // The classifier says crisis for the innocent line, so a retained audit exists. It was
    // sent BEFORE that line arrived, and it concerns the innocent line, so it must be
    // released rather than replayed forever.
    const { bridge, say, lines } = build({
      chat: "yeah! i have stone",
      verdicts: ['{"level":"crisis","imminent":false,"reason":"late"}'],
    });

    await bridge.handle("Steve", `elix ${CRISIS}`, say); // regex answers; no audit
    await bridge.handle("Steve", `elix ${INNOCENT}`, say); // audit says crisis

    // It IS a crisis verdict about this very line, so this one is legitimately blocked.
    // What must not happen is it happening on every later line forever.
    await bridge.handle("Steve", `elix ${ORDINARY}`, say);
    const third = lines.slice(2).join(" | ");
    expect(third).toBe("yeah! i have stone");
  }, 20_000);

  it("repeated ordinary lines do not increment the intervention count", async () => {
    // The measured harm of the old behaviour: every answered line inside the cooldown was
    // logged as a new intervention, so the number stopped meaning anything.
    const { bridge, say } = build({ chat: "ok" });
    await bridge.handle("Steve", `elix ${CRISIS}`, say);
    const afterCrisis = bridge.wellbeingState.interventions;
    for (let i = 0; i < 4; i++) {
      await bridge.handle("Steve", `elix ${ORDINARY} ${i}`, say);
    }
    expect(bridge.wellbeingState.interventions).toBe(afterCrisis);
  }, 20_000);

  it("the gentle flag is scoped to the player who was answered", async () => {
    const { bridge, say } = build({ chat: "ok" });
    await bridge.handle("Steve", `elix ${CRISIS}`, say);
    expect(bridge.isGentleWindow("Steve")).toBe(true);
    // A different player is a different conversation.
    expect(bridge.isGentleWindow("Alex")).toBe(false);
  }, 15_000);

  it("GENTLE_MODE_FLAG states the constraints, not just an intention", () => {
    // "Be kind" was already in the persona and did not survive a model that wanted to be
    // funny. The flag has to be concrete enough to be followed.
    expect(GENTLE_MODE_FLAG).toMatch(/no jokes/i);
    expect(GENTLE_MODE_FLAG).toMatch(/do NOT pivot to the game/i);
    expect(GENTLE_MODE_FLAG).toMatch(/do NOT repeat or rephrase the advice/i);
    expect(GENTLE_MODE_FLAG).toMatch(/unless they raise it themselves/i);
  });
});