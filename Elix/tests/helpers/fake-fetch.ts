/**
 * Test harness for the brain (B10).
 *
 * Every test in the brain suite runs with a fake fetch. Nothing here opens a
 * socket, so the whole suite is deterministic and offline. The one exception is
 * tests/unit/live.test.ts, which is skipped unless ELIX_LIVE=1.
 *
 * Replies are routed by URL, not by call order. A positional queue is wrong for
 * this router: one `complete()` touches /models on each provider before it
 * makes a single chat call, so call N is not "the n-th thing that happened".
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrainStore } from "../../src/brain/store.js";
import type { FetchLike } from "../../src/brain/types.js";

/** One recorded outbound request. */
export interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

export interface FakeReply {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  /** Throw instead of responding (network failure). */
  throws?: Error;
  /** Never settle, so an AbortSignal is the only way out. */
  hang?: boolean;
}

export interface Route {
  /** Matched against the request URL with `String.includes`, or a RegExp. */
  match: string | RegExp;
  /**
   * One reply, or a queue consumed in order. A queue repeats its last entry once
   * exhausted, so a test only has to script the calls it cares about.
   */
  reply: FakeReply | FakeReply[];
}

export interface FakeFetch {
  fn: FetchLike;
  calls: Recorded[];
  /** Calls whose URL contains this substring. */
  callsTo(fragment: string): Recorded[];
}

function matches(route: Route, url: string): boolean {
  return typeof route.match === "string" ? url.includes(route.match) : route.match.test(url);
}

function abortError(): Error {
  const e = new Error("The operation was aborted");
  e.name = "AbortError";
  return e;
}

/** Build a fake fetch with URL-routed replies. */
export function fakeFetch(routes: Route[] = []): FakeFetch {
  const calls: Recorded[] = [];
  const cursors = new Map<Route, number>();

  const fn = ((url: string, init?: Parameters<FetchLike>[1]) => {
    const target = String(url);
    calls.push({
      url: target,
      method: init?.method ?? "GET",
      headers: init?.headers ?? {},
      body: init?.body ?? "",
    });

    if (init?.signal?.aborted) return Promise.reject(abortError());

    const route = routes.find((r) => matches(r, target));
    if (!route) {
      return Promise.reject(new Error(`fake fetch: no route for ${target}`));
    }
    const list = Array.isArray(route.reply) ? route.reply : [route.reply];
    const i = cursors.get(route) ?? 0;
    cursors.set(route, i + 1);
    const reply = list[Math.min(i, list.length - 1)]!;

    if (reply.throws) return Promise.reject(reply.throws);
    const text = reply.body ?? "";
    const built = Promise.resolve({
      ok: (reply.status ?? 200) >= 200 && (reply.status ?? 200) < 300,
      status: reply.status ?? 200,
      headers: new Headers(reply.headers ?? {}),
      text: () => Promise.resolve(text),
      json: () => Promise.resolve(JSON.parse(text) as unknown),
    });

    if (reply.hang) {
      const signal = init?.signal;
      if (!signal) {
        // Nothing can ever cancel it; fail loudly rather than hang the suite.
        return Promise.reject(new Error(`fake fetch: hanging route for ${target} needs a signal`));
      }
      return new Promise<never>((_resolve, reject) => {
        // A ref'd timer keeps the event loop alive while we wait.
        //
        // `AbortSignal.timeout()` is UNREF'd in Node, so in a test where the
        // pending request is the only thing left, the loop drains, the deadline
        // never fires, and node exits with "unsettled top-level await" instead
        // of the timeout being exercised at all. In the real bot an open
        // Minecraft socket always holds the loop, so this is a test-harness
        // concern — but it must be held here or the timeout test proves nothing.
        const keepAlive = setInterval(() => undefined, 1_000);
        signal.addEventListener(
          "abort",
          () => {
            clearInterval(keepAlive);
            reject(abortError());
          },
          { once: true },
        );
      });
    }

    if (!init?.signal) return built;
    // Race against the signal so an abort cancels in-flight work, as fetch does.
    return Promise.race([
      built,
      new Promise<never>((_r, reject) => {
        init.signal!.addEventListener("abort", () => reject(abortError()), { once: true });
      }),
    ]);
  }) as FetchLike;

  return {
    fn,
    calls,
    callsTo: (fragment: string) => calls.filter((c) => c.url.includes(fragment)),
  };
}

/** A successful OpenAI-shaped chat completion. */
export function okCompletion(text: string, extra: Record<string, unknown> = {}): FakeReply {
  return {
    status: 200,
    headers: {
      "x-ratelimit-remaining-tokens": "17000",
      "x-ratelimit-remaining-requests": "14000",
      "x-ratelimit-reset-tokens": "7.66s",
      "x-ratelimit-reset-requests": "2m59.56s",
    },
    body: JSON.stringify({
      choices: [{ message: { content: text } }],
      usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 },
      ...extra,
    }),
  };
}

/** A chat completion reporting a specific remaining-token budget. */
export function okCompletionWithBudget(text: string, remainingTokens: number): FakeReply {
  return {
    status: 200,
    headers: {
      "x-ratelimit-remaining-tokens": String(remainingTokens),
      "x-ratelimit-reset-tokens": "3s",
    },
    body: JSON.stringify({
      choices: [{ message: { content: text } }],
      usage: { prompt_tokens: 10, completion_tokens: 1 },
    }),
  };
}

/** A /models listing. */
export function okModels(ids: string[]): FakeReply {
  return { status: 200, body: JSON.stringify({ data: ids.map((id) => ({ id })) }) };
}

export function errorReply(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): FakeReply {
  return { status, headers, body };
}

/** A disposable on-disk store, so cooldown persistence can really be tested. */
export function tempStore(): { store: BrainStore; dir: string; close(): void } {
  const dir = mkdtempSync(join(tmpdir(), "elix-brain-"));
  const store = new BrainStore(join(dir, "elix.db"));
  return {
    store,
    dir,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A clock the tests move by hand, so cooldowns need no real waiting. */
export function fakeClock(start = 1_700_000_000_000): {
  now: () => number;
  advance(ms: number): void;
} {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

/** Routes for a two-provider router, in the order the router tries them. */
export function groqHfRoutes(groqChat: FakeReply | FakeReply[], hfChat: FakeReply | FakeReply[]): Route[] {
  return [
    { match: "api.groq.com/openai/v1/models", reply: okModels(["openai/gpt-oss-20b", "moonshotai/kimi-k2-instruct"]) },
    { match: "router.huggingface.co/v1/models", reply: okModels(["meta-llama/Llama-3.3-70B-Instruct"]) },
    { match: "api.groq.com/openai/v1/chat/completions", reply: groqChat },
    { match: "router.huggingface.co/v1/chat/completions", reply: hfChat },
  ];
}
