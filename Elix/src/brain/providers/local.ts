/**
 * NVIDIA and local Ollama — the two tiers the vision lists and the code did not have.
 *
 * The vision's order is Groq -> NVIDIA -> Hugging Face -> local. Only Groq and HF existed,
 * so a Groq rate limit dropped straight to HF, which has almost no free credit, and then to
 * the built-in fallback. A machine with a good GPU and Ollama running was never asked.
 *
 * Two adapters, and they are not the same shape:
 *
 *   NVIDIA   https://integrate.api.nvidia.com/v1, OpenAI-compatible, NVIDIA_API_KEY.
 *            A 402 means "credits exhausted", not "try again in a second", so it opens the
 *            breaker for NVIDIA_CREDITS_BREAKER_MS - 24 hours - instead of falling through
 *            on every single reply for the rest of the session.
 *
 *   OLLAMA   http://127.0.0.1:11434/v1, no key at all. It is SILENTLY ABSENT when it cannot
 *            be reached at startup: a bot that spends 30 seconds timing out on localhost
 *            before falling back to the built-in is worse than a bot that never had it.
 *
 * Neither hard-codes a model id. `discoverModels()` asks `GET /v1/models` and returns what
 * the server actually offers, because NVIDIA's catalogue and a local Ollama install both
 * change faster than this file does.
 */
import { isCreditOrQuotaError } from "../ratelimit.js";
import { stripReasoning } from "../reasoning.js";
import type {
  CompletionRequest,
  FetchLike,
  ProviderAdapter,
  ProviderResponse,
} from "../types.js";

/** NVIDIA's OpenAI-compatible endpoint. */
export const NVIDIA_BASE = "https://integrate.api.nvidia.com/v1";
export const NVIDIA_CHAT_URL = `${NVIDIA_BASE}/chat/completions`;
export const NVIDIA_MODELS_URL = `${NVIDIA_BASE}/models`;

/** Ollama's OpenAI-compatible endpoint. Loopback only - never a remote host. */
export const OLLAMA_BASE = "http://127.0.0.1:11434/v1";
export const OLLAMA_CHAT_URL = `${OLLAMA_BASE}/chat/completions`;
export const OLLAMA_MODELS_URL = `${OLLAMA_BASE}/models`;

/** A 402 from NVIDIA means the credits are gone, so stop asking for a day. */
export const NVIDIA_CREDITS_BREAKER_MS = 24 * 60 * 60_000;

/** How long the startup reachability probe waits. Local, so it must be quick. */
export const OLLAMA_PROBE_TIMEOUT_MS = 1_500;

/**
 * Deadline for a real provider call.
 *
 * Not optional. `tests/unit/partA.test.ts` asserts that every provider call has one, because
 * a chat completion with no deadline is how a bot hangs on a reply until somebody kills it -
 * and that is the exact failure the owner reproduced. The Ollama startup probe has its own,
 * shorter one above, because a local model that is not running must not cost 30 seconds.
 */
export const TIER_TIMEOUT_MS = 30_000;

/** A signal that aborts after `ms`, merged with any caller signal. */
function deadline(ms: number, caller?: AbortSignal): AbortSignal {
  const own = AbortSignal.timeout(ms);
  if (caller === undefined) return own;
  // Two signals, one deadline: the caller can still give up early, and the deadline still
  // fires when the caller does not.
  const both = AbortSignal.any([own, caller]);
  return both;
}

/** An error carrying the two things the router needs: the status and the headers. */
export interface TierError extends Error {
  status?: number;
  body?: string;
  headers?: Headers;
  /** True for a 402 or any credits/quota complaint. */
  creditsExhausted?: boolean;
}

/** What `GET /v1/models` returns. OpenAI-shaped, and both servers follow it. */
interface ModelsBody {
  data?: Array<{ id?: string; name?: string }>;
  models?: Array<{ name?: string; model?: string }>;
}

/**
 * Pull the model ids out of a `/v1/models` body.
 *
 * Both shapes are handled because they really do occur: OpenAI says `data[].id`, and Ollama
 * also answers `/v1/models` with `models[].name`. Neither shape is guessed at the call site.
 */
export function parseModels(body: unknown): string[] {
  if (body === null || typeof body !== "object") return [];
  const parsed = body as ModelsBody;
  const out: string[] = [];
  for (const entry of parsed.data ?? []) {
    const id = entry?.id ?? entry?.name;
    if (typeof id === "string" && id !== "") out.push(id);
  }
  for (const entry of parsed.models ?? []) {
    const id = entry?.name ?? entry?.model;
    if (typeof id === "string" && id !== "") out.push(id);
  }
  // No duplicates, and stable order, so a test can compare the whole list.
  return [...new Set(out)];
}

/** Read a chat completion out of either server's OpenAI-shaped answer. */
export function parseChatBody(body: unknown): { text: string; tokensIn: number; tokensOut: number; reasoningTokens: number } {
  if (body === null || typeof body !== "object") {
    return { text: "", tokensIn: 0, tokensOut: 0, reasoningTokens: 0 };
  }
  const parsed = body as {
    choices?: Array<{ message?: { content?: string | null; reasoning?: unknown } }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      completion_tokens_details?: { reasoning_tokens?: number };
    };
  };
  const message = parsed.choices?.[0]?.message;
  // stripReasoning takes the message object and returns the split, the same way the HF
  // adapter calls it. A local model that thinks out loud puts its reasoning in
  // `reasoning` or `reasoning_content`, and only `content` is the answer.
  const split = stripReasoning({
    content: typeof message?.content === "string" ? message.content : "",
    reasoning: message?.reasoning,
  });
  return {
    text: split.content,
    tokensIn: parsed.usage?.prompt_tokens ?? 0,
    tokensOut: parsed.usage?.completion_tokens ?? 0,
    reasoningTokens: parsed.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
  };
}

export interface NvidiaOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

/**
 * NVIDIA's OpenAI-compatible adapter.
 *
 * `creditsExhausted` is set on 402 AND on any credits/quota complaint in the body, because
 * NVIDIA reports the two differently depending on the model - and a provider that asks again
 * every thirty seconds for a day is a provider that has made itself useless.
 */
export class NvidiaProvider implements ProviderAdapter {
  readonly name = "nvidia" as const;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: NvidiaOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? NVIDIA_BASE;
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args));
  }

  /** What this server actually offers. Never a hard-coded id. */
  async listModels(signal?: AbortSignal): Promise<string[]> {
    const res = await this.fetchImpl(`${this.baseUrl}/models`, {
      headers: { authorization: `Bearer ${this.apiKey}` },
      signal: deadline(TIER_TIMEOUT_MS, signal),
    });
    if (!res.ok) {
      throw withStatus(new Error(`nvidia /models failed: ${res.status}`), res);
    }
    return parseModels(await res.json());
  }

  async complete(req: CompletionRequest, model: string): Promise<ProviderResponse> {
    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: req.messages,
        max_tokens: req.maxTokens,
        temperature: req.temperature,
      }),
      signal: deadline(TIER_TIMEOUT_MS, req.signal),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const err = withStatus(new Error(`nvidia ${res.status}: ${body.slice(0, 200)}`), res);
      err.body = body.slice(0, 500);
      // 402 is the documented "out of credits" and a 429 can also be a quota wall.
      if (res.status === 402 || isCreditOrQuotaError(body)) err.creditsExhausted = true;
      throw err;
    }
    const parsed = parseChatBody(await res.json());
    return { ...parsed, headers: res.headers };
  }
}

export interface OllamaOptions {
  /** Defaults to the loopback endpoint. A REMOTE Ollama is refused by `ollamaBase`. */
  baseUrl?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/**
 * Only loopback.
 *
 * An operator who points Elix at a remote "Ollama" has misconfigured something, and quietly
 * accepting it would mean shipping a stranger's chat log to a machine nobody audited. A
 * hostname that is not localhost is refused here, loudly, at construction.
 */
export function ollamaBase(base: string): string {
  const trimmed = base.replace(/\/+$/, "");
  if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)(:\d+)?(\/v1)?$/u.test(trimmed)) {
    throw new Error(
      `ollama base must be loopback (127.0.0.1, localhost or [::1]), got: ${trimmed}`,
    );
  }
  return trimmed;
}

/**
 * The local adapter. No key: a local model has no accounts to authenticate to.
 */
export class OllamaProvider implements ProviderAdapter {
  readonly name = "ollama" as const;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: OllamaOptions = {}) {
    this.baseUrl = ollamaBase(opts.baseUrl ?? OLLAMA_BASE);
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args));
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const res = await this.fetchImpl(`${this.baseUrl}/models`, {
      signal: deadline(TIER_TIMEOUT_MS, signal),
    });
    if (!res.ok) {
      throw withStatus(new Error(`ollama /models failed: ${res.status}`), res);
    }
    return parseModels(await res.json());
  }

  async complete(req: CompletionRequest, model: string): Promise<ProviderResponse> {
    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: req.messages,
        stream: false,
        options: {
          num_predict: req.maxTokens,
          temperature: req.temperature,
        },
      }),
      signal: deadline(TIER_TIMEOUT_MS, req.signal),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const err = withStatus(new Error(`ollama ${res.status}: ${body.slice(0, 200)}`), res);
      err.body = body.slice(0, 500);
      throw err;
    }
    const parsed = parseChatBody(await res.json());
    return { ...parsed, headers: res.headers };
  }
}

/** Attach the status and headers the router needs to pick a cooldown. */
function withStatus(err: Error, res: { status: number; headers?: Headers }): TierError {
  const out = err as TierError;
  out.status = res.status;
  if (res.headers !== undefined) out.headers = res.headers;
  return out;
}

/**
 * Is Ollama there?
 *
 * Returns the model ids when it answers, and `null` when it does not. The caller treats
 * `null` as "this provider does not exist for this run" - silently, because a bot that
 * complains about a local model the owner never installed is worse than one that forgets it.
 */
export async function probeOllama(opts: OllamaOptions = {}): Promise<string[] | null> {
  const provider = new OllamaProvider(opts);
  const timeout = opts.timeoutMs ?? OLLAMA_PROBE_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const models = await provider.listModels(controller.signal);
    return models.length > 0 ? models : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Choose a model out of what the server offers.
 *
 * Preference order by SUBSTRING, because the ids are namespaced (`nvidia/llama-3.1-8b`,
 * `meta-llama/llama-3.3-70b-instruct`) and an exact match would never fire. A substring that
 * matches nothing is skipped rather than guessed at, so an unexpected catalogue produces no
 * model instead of a wrong one.
 */
export function chooseModel(available: readonly string[], prefer: readonly string[]): string | null {
  for (const wanted of prefer) {
    const needle = wanted.toLowerCase();
    const hit = available.find((id) => id.toLowerCase().includes(needle));
    if (hit !== undefined) return hit;
  }
  return null;
}

/**
 * Model families verified to return usable JSON.
 *
 * An ALLOW-list, not a heuristic over all models. Anything not named here is refused for the
 * guard role, which is the safe direction: the cost of a false negative is a missing tier,
 * and the cost of a false positive is the Round 11 bug - a prose answer that fails
 * `parseVerdict` and silently degrades the wellbeing classifier to the regex floor.
 *
 *   *instruct*  the standard instruction-tuned naming, which is JSON-trained
 *   gpt-oss      OpenAI's open-weight gpt-oss family, including the `safeguard` variant that
 *                the guard role already depends on for its JSON verdict
 *   qwen         Qwen 3 is JSON-trained and is this project's second guard fallback
 *   llama-3.1/3.3+chat  the Llama chat and instruct checkpoints
 */
export const JSON_CAPABLE_HINTS: readonly string[] = Object.freeze([
  "instruct",
  "chat",
  "gpt-oss",
  "qwen",
  "-it-",
  "it-",
]);

/** True when the model's family is one verified to return structured output. */
export function canReturnJson(model: string): boolean {
  const id = model.toLowerCase();
  return JSON_CAPABLE_HINTS.some((hint) => id.includes(hint));
}