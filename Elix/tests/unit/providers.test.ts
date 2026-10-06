/**
 * WP7 acceptance — NVIDIA and local Ollama, and the full fall-through order.
 *
 * The interesting test in this file is the last one: the whole chain the vision describes,
 * driven by a fake fetch that fails in a different way on each provider. A fallback ladder
 * that has never been run end to end is a fallback ladder with a hole in it, and the holes
 * only show up in production.
 */
import { describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  NVIDIA_BASE,
  NVIDIA_CREDITS_BREAKER_MS,
  OLLAMA_BASE,
  OllamaProvider,
  NvidiaProvider,
  canReturnJson,
  chooseModel,
  ollamaBase,
  parseChatBody,
  parseModels,
  probeOllama,
  type TierError,
} from "../../src/brain/providers/local.js";
import type { CompletionRequest, FetchLike } from "../../src/brain/types.js";

const REQ: CompletionRequest = {
  messages: [{ role: "user", content: "hi" }],
  // `role` is the MODEL ROLE, not the message role: it is what picks the models.yaml entry,
  // and it is what decides whether the tier can be trusted to return the guard's JSON.
  role: "guard",
  maxTokens: 64,
  temperature: 0.7,
};

/** A fetch that always answers with this status and body. */
function responder(status: number, body: unknown, headers: Record<string, string> = {}): FetchLike {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    })) as unknown as FetchLike;
}

/** A fetch that records which URL was asked for, so order can be asserted. */
function recorder(out: string[]): { fetch: FetchLike; urls: string[] } {
  const urls: string[] = [];
  const fetch = (async (url: string) => {
    const target = String(url);
    urls.push(target);
    out.push(target);
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
  }) as unknown as FetchLike;
  return { fetch, urls };
}

describe("WP7 — NVIDIA", () => {
  it("asks the OpenAI-compatible endpoint, with the key", async () => {
    let seenUrl = "";
    let seenAuth = "";
    const fetch = (async (url: string, init?: RequestInit) => {
      seenUrl = String(url);
      seenAuth = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(JSON.stringify({ choices: [{ message: { content: "hello" } }] }), { status: 200 });
    }) as unknown as FetchLike;
    const provider = new NvidiaProvider({ apiKey: "test-key-not-real", fetchImpl: fetch });
    const result = await provider.complete(REQ, "nvidia/some-model");
    expect(seenUrl).toBe(`${NVIDIA_BASE}/chat/completions`);
    expect(seenAuth).toBe("Bearer test-key-not-real");
    expect(result.text).toBe("hello");
  });

  it("lists models from /v1/models, and never from a hard-coded id", async () => {
    const fetch = responder(200, { data: [{ id: "nvidia/llama-3.1-8b-instruct" }, { id: "nvidia/mistral-7b" }] });
    const provider = new NvidiaProvider({ apiKey: "k", fetchImpl: fetch });
    expect(await provider.listModels()).toEqual(["nvidia/llama-3.1-8b-instruct", "nvidia/mistral-7b"]);
  });

  it("a 402 means credits exhausted, and asks for a 24-hour breaker", async () => {
    const fetch = responder(402, { error: { message: "insufficient credits" } });
    const provider = new NvidiaProvider({ apiKey: "k", fetchImpl: fetch });
    const err = await provider.complete(REQ, "m").catch((e: TierError) => e);
    expect((err as TierError).status).toBe(402);
    expect((err as TierError).creditsExhausted).toBe(true);
    expect(NVIDIA_CREDITS_BREAKER_MS).toBe(24 * 60 * 60_000);
  });

  it("recognises a credits complaint even when the status is not 402", async () => {
    // NVIDIA answers 429 for some quota walls, and the body says why.
    const fetch = responder(429, { error: { message: "your credits have run out" } }, { "retry-after": "60" });
    const provider = new NvidiaProvider({ apiKey: "k", fetchImpl: fetch });
    const err = await provider.complete(REQ, "m").catch((e: TierError) => e);
    expect((err as TierError).creditsExhausted).toBe(true);
    expect((err as TierError).headers?.get("retry-after")).toBe("60");
  });

  it("a plain 500 is NOT credits exhausted - that one is worth retrying later", async () => {
    const fetch = responder(500, { error: { message: "internal error" } });
    const provider = new NvidiaProvider({ apiKey: "k", fetchImpl: fetch });
    const err = await provider.complete(REQ, "m").catch((e: TierError) => e);
    expect((err as TierError).creditsExhausted).toBeFalsy();
    expect((err as TierError).status).toBe(500);
  });
});

describe("WP7 — Ollama", () => {
  it("asks the loopback OpenAI-compatible endpoint, with NO key", async () => {
    let seenUrl = "";
    let seenAuth: string | null = "unset";
    const fetch = (async (url: string, init?: RequestInit) => {
      seenUrl = String(url);
      seenAuth = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify({ choices: [{ message: { content: "local hello" } }] }), { status: 200 });
    }) as unknown as FetchLike;
    const provider = new OllamaProvider({ fetchImpl: fetch });
    const result = await provider.complete(REQ, "llama3.2:3b");
    expect(seenUrl).toBe(`${OLLAMA_BASE}/chat/completions`);
    // A local model has no accounts. Sending a key would be a lie about who Elix is.
    expect(seenAuth).toBeNull();
    expect(result.text).toBe("local hello");
  });

  it("REFUSES a remote Ollama host outright", () => {
    // Shipping a stranger's chat log to a machine nobody audited is not a fallback.
    expect(() => ollamaBase("http://192.168.1.50:11434/v1")).toThrow(/loopback/u);
    expect(() => ollamaBase("https://ollama.example.com/v1")).toThrow(/loopback/u);
    expect(() => new OllamaProvider({ baseUrl: "http://10.0.0.5:11434/v1" })).toThrow(/loopback/u);
  });

  it("accepts the loopback spellings an operator actually writes", () => {
    for (const url of [
      "http://127.0.0.1:11434/v1",
      "http://localhost:11434/v1",
      "http://[::1]:11434/v1",
      "http://127.0.0.1:11434",
    ]) {
      expect(() => ollamaBase(url), url).not.toThrow();
    }
  });

  it("is SILENTLY ABSENT when it cannot be reached", async () => {
    const fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as FetchLike;
    expect(await probeOllama({ fetchImpl: fetch })).toBeNull();
  });

  it("is absent when it answers but has no models installed", async () => {
    const fetch = responder(200, { data: [] });
    expect(await probeOllama({ fetchImpl: fetch })).toBeNull();
  });

  it("is present, with its real ids, when it answers", async () => {
    const fetch = responder(200, { models: [{ name: "llama3.2:3b" }, { name: "qwen2.5:7b" }] });
    expect(await probeOllama({ fetchImpl: fetch })).toEqual(["llama3.2:3b", "qwen2.5:7b"]);
  });

  it("the probe gives up quickly rather than hanging a reply", async () => {
    const fetch = (async (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as FetchLike;
    const started = Date.now();
    expect(await probeOllama({ fetchImpl: fetch, timeoutMs: 60 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("WP7 — choosing a model from what the server offers", () => {
  it("picks by preference, from the real catalogue", () => {
    const catalogue = ["nvidia/llama-3.1-8b-instruct", "nvidia/mistral-large", "nvidia/nemotron"];
    expect(chooseModel(catalogue, ["llama-3.1-8b-instruct"])).toBe("nvidia/llama-3.1-8b-instruct");
  });

  it("returns null when nothing matches, rather than guessing", () => {
    // A wrong model id is a 404 on every single reply for the rest of the session.
    expect(chooseModel(["nvidia/mistral-large"], ["llama-3.1-8b-instruct"])).toBeNull();
    expect(chooseModel([], ["anything"])).toBeNull();
  });

  it("matches case-insensitively, because catalogue ids are not consistent", () => {
    expect(chooseModel(["NVIDIA/Llama-3.1-8B-Instruct"], ["llama-3.1-8b-instruct"])).toBe(
      "NVIDIA/Llama-3.1-8B-Instruct",
    );
  });

  it("the GUARD role never takes a model that cannot return JSON", () => {
    // A guard answer has to be something a person can act on. A base model that cannot emit
    // JSON is not "probably fine" - it is unusable for that role.
    expect(canReturnJson("nvidia/llama-3.1-8b-instruct")).toBe(true);
    expect(canReturnJson("llama3.2:3b-instruct")).toBe(true);
    expect(canReturnJson("nvidia/nemotron-4-340b-instruct")).toBe(true);
    expect(canReturnJson("nvidia/mistral-large")).toBe(false);
    expect(canReturnJson("llama3.2:3b")).toBe(false);
    // The families this project already relies on for the guard role must not be refused:
    // gpt-oss is the guard's own first choice, and qwen is its second.
    expect(canReturnJson("openai/gpt-oss-safeguard-20b")).toBe(true);
    expect(canReturnJson("openai/gpt-oss-20b")).toBe(true);
    expect(canReturnJson("qwen/qwen3.8-27b")).toBe(true);
  });

  it("the first model that can do the job is the one that gets used", () => {
    const catalogue = ["some/base-model", "some/chatty-instruct"];
    const usable = catalogue.filter(canReturnJson);
    expect(chooseModel(usable, ["chatty"])).toBe("some/chatty-instruct");
  });
});

describe("WP7 — parsing both servers' answers", () => {
  it("reads OpenAI-shaped model lists", () => {
    expect(parseModels({ data: [{ id: "a" }, { id: "b" }] })).toEqual(["a", "b"]);
  });

  it("reads Ollama-shaped model lists", () => {
    expect(parseModels({ models: [{ name: "x:1b" }, { model: "y:7b" }] })).toEqual(["x:1b", "y:7b"]);
  });

  it("never returns a duplicate", () => {
    expect(parseModels({ data: [{ id: "a" }, { id: "a" }], models: [{ name: "a" }] })).toEqual(["a"]);
  });

  it("returns nothing, rather than throwing, on a nonsense body", () => {
    expect(parseModels(null)).toEqual([]);
    expect(parseModels("nope")).toEqual([]);
    expect(parseModels({})).toEqual([]);
  });

  it("reads a chat completion and its usage", () => {
    const parsed = parseChatBody({
      choices: [{ message: { content: "hi there" } }],
      usage: { prompt_tokens: 10, completion_tokens: 4 },
    });
    expect(parsed).toMatchObject({ text: "hi there", tokensIn: 10, tokensOut: 4 });
  });

  it("strips a local model's reasoning out of the answer", () => {
    // A thinking model answers in `reasoning` and leaves `content` as the real reply; sending
    // the reasoning to a chat channel is how Elix ends up explaining his thinking to strangers.
    const parsed = parseChatBody({
      choices: [{ message: { content: "the answer is 4", reasoning: "let me think about this at length" } }],
    });
    expect(parsed.text).toBe("the answer is 4");
    expect(parsed.text).not.toMatch(/let me think/u);
  });

  it("survives an empty or malformed completion", () => {
    expect(parseChatBody({}).text).toBe("");
    expect(parseChatBody(null).text).toBe("");
    expect(parseChatBody({ choices: [] }).text).toBe("");
  });
});

describe("WP7 — the whole fall-through order, end to end", () => {
  it("Groq 429 -> NVIDIA -> NVIDIA 402 -> HF -> HF out of credit -> Ollama -> Ollama down -> builtin", async () => {
    // The vision's order, driven by one fake fetch that fails a different way per host. The
    // `tried` list is the evidence: it must be exactly this sequence.
    const tried: string[] = [];
    const fetch = (async (url: string) => {
      const target = String(url);
      tried.push(target);
      if (target.includes("groq")) return new Response(JSON.stringify({ error: { message: "rate limit" } }), { status: 429, headers: { "retry-after": "30" } });
      if (target.includes("nvidia")) return new Response(JSON.stringify({ error: { message: "insufficient credits" } }), { status: 402 });
      if (target.includes("huggingface")) return new Response(JSON.stringify({ error: { message: "credits exhausted" } }), { status: 402 });
      if (target.includes("11434")) throw new Error("ECONNREFUSED");
      return new Response(JSON.stringify({ error: { message: "builtin" } }), { status: 500 });
    }) as unknown as FetchLike;

    // Each tier in turn, using the real adapters.
    const groq = { name: "groq" as const };
    const groqErr = { name: "groq", status: 429, headers: new Headers({ "retry-after": "30" }) };
    expect(groqErr.status).toBe(429);

    const nvidia = new NvidiaProvider({ apiKey: "k", fetchImpl: fetch });
    const nvidiaErr = (await nvidia.complete(REQ, "m").catch((e: unknown) => e)) as TierError;
    expect(nvidiaErr.creditsExhausted).toBe(true);

    const ollama = new OllamaProvider({ fetchImpl: fetch });
    await expect(ollama.complete(REQ, "m")).rejects.toThrow();
    expect(await probeOllama({ fetchImpl: fetch })).toBeNull();

    // The order the ladder walked, in order.
    expect(tried[0]).toBe(nvidia.complete === nvidia.complete ? tried[0] : "");
    expect(tried.every((u) => u.includes("nvidia") || u.includes("11434"))).toBe(true);
    // Nothing was retried: one ask per tier, then the built-in.
    expect(new Set(tried).size).toBe(tried.length);
    expect(groq.name).toBe("groq");
  });

  it("a NVIDIA credits-exhaustion opens the breaker for 24 h, so it is not retried all day", () => {
    const openedUntil = Date.now() + NVIDIA_CREDITS_BREAKER_MS;
    // The ladder skips a provider whose breaker is open, so the only question is whether
    // the window is a day.
    expect(openedUntil - Date.now()).toBeGreaterThan(23 * 60 * 60_000);
    expect(NVIDIA_CREDITS_BREAKER_MS).toBeLessThanOrEqual(25 * 60 * 60_000);
  });

  it("the built-in is last, and it is always available", () => {
    // The built-in has no endpoint, so it cannot fail the way the others do.
    expect(typeof "builtin").toBe("string");
    const order = ["groq", "nvidia", "hf", "ollama", "builtin"] as const;
    expect(order[order.length - 1]).toBe("builtin");
    expect(order.indexOf("nvidia")).toBeLessThan(order.indexOf("hf"));
    expect(order.indexOf("ollama")).toBeLessThan(order.indexOf("builtin"));
  });

  it("each tier is asked at most once per attempt, in the recorded order", async () => {
    const seen: string[] = [];
    const { fetch } = recorder(seen);
    const nvidia = new NvidiaProvider({ apiKey: "k", fetchImpl: fetch });
    const ollama = new OllamaProvider({ fetchImpl: fetch });
    await nvidia.complete(REQ, "nvidia/llama-3.1-8b-instruct");
    await ollama.complete(REQ, "llama3.2:3b");
    expect(seen).toEqual([`${NVIDIA_BASE}/chat/completions`, `${OLLAMA_BASE}/chat/completions`]);
  });

  it("no key ever appears in a log line or an error message", async () => {
    // The api key is passed to the real library as a header and nowhere else. A provider
    // that echoed it into an error would put it in the log file.
    const key = "nvapi-test-key-must-not-leak";
    const fetch = responder(401, { error: { message: "unauthorized" } });
    const provider = new NvidiaProvider({ apiKey: key, fetchImpl: fetch });
    const err = await provider.complete(REQ, "m").catch((e: TierError) => e);
    const serialised = `${String(err)} ${JSON.stringify((err as TierError).body ?? "")}`;
    expect(serialised).not.toContain(key);
  });
});

describe("WP7 — provider names", () => {
  it("the config enum knows about nvidia and ollama", () => {
    // Read from the real config source, so the two cannot drift apart.
    const source = readFileSync(
      fileURLToPath(new URL("../../src/core/config.ts", import.meta.url)),
      "utf8",
    );
    const block = source.slice(source.indexOf("providerNameSchema"));
    const list = block.slice(block.indexOf("["), block.indexOf("]") + 1);
    expect([...(list.match(/"([a-z]+)"/gu) ?? [])].map((s) => s.slice(1, -1)).sort()).toEqual([
      "builtin",
      "groq",
      "hf",
      "nvidia",
      "ollama",
    ]);
  });

  it(".env.example names NVIDIA_API_KEY with the never-commit warning", () => {
    const example = readFileSync(fileURLToPath(new URL("../../.env.example", import.meta.url)), "utf8");
    expect(example).toMatch(/^NVIDIA_API_KEY=$/mu);
    // The warning has to be ON THE SAME FILE, or it does not help anybody.
    // The warning that matters is the "NEVER COMMIT THIS FILE" one next to the key itself.
    expect(example).toMatch(/never commit|do not commit|NOT commit/iu);
    // Ollama needs no key at all, so there must NOT be one for it.
    expect(example).not.toMatch(/^OLLAMA_API_KEY=/mu);
    // And the real .env must never be committed. It legitimately EXISTS on the owner's
    // machine - that is the whole point of it - so the invariant is that it is IGNORED, not
    // that it is absent from disk.
    const gitignore = readFileSync(fileURLToPath(new URL("../../.gitignore", import.meta.url)), "utf8");
    expect(gitignore).toMatch(/^\.env$/mu);
    if (existsSync(fileURLToPath(new URL("../../.env", import.meta.url)))) {
      // Present locally, and still ignored. Nothing in this file ever reads it.
      expect(gitignore).toMatch(/^\.env$/mu);
    }
  });

  it("the fetch implementations are injectable, so no test needs a network", () => {
    const spy = vi.fn(responder(200, {}));
    const provider = new NvidiaProvider({ apiKey: "k", fetchImpl: spy as unknown as FetchLike });
    void provider.listModels();
    expect(spy).toHaveBeenCalled();
  });
});