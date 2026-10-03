/**
 * Groq adapter (OpenAI-compatible chat completions).
 *
 * Verified against Groq's docs (2026-10-02):
 *
 *   https://console.groq.com/docs/rate-limits
 *     x-ratelimit-limit-requests     ALWAYS requests per day (RPD)
 *     x-ratelimit-remaining-requests ALWAYS requests per day
 *     x-ratelimit-reset-requests     duration string, e.g. "2m59.56s" (RPD)
 *     x-ratelimit-limit-tokens       ALWAYS tokens per minute (TPM)
 *     x-ratelimit-remaining-tokens   ALWAYS tokens per minute (TPM)
 *     x-ratelimit-reset-tokens       duration string, e.g. "7.66s" (TPM)
 *     retry-after                    seconds, only set on 429
 *
 *   https://console.groq.com/docs/reasoning
 *     reasoning_effort  low | medium | high   (gpt-oss, qwen3.8)
 *     reasoning_format  hidden -> final answer only, no reasoning field
 *     include_reasoning / reasoning_format are mutually exclusive
 *
 * We send `reasoning_format: "hidden"` so the chain of thought never even
 * reaches us, and strip it again defensively in reasoning.ts.
 */
import { parseRateLimitHeaders, type RateLimitInfo } from "./ratelimit.js";
import {
  stripReasoning,
  isReasoningModel,
  reasoningParams,
  completionTokenLimit,
} from "./reasoning.js";
import type {
  CompletionRequest,
  FetchLike,
  ProviderAdapter,
  ProviderResponse,
} from "./types.js";

export const GROQ_BASE = "https://api.groq.com/openai/v1";

/** Used when a caller does not name a model. Same default as config/models.yaml. */
export const DEFAULT_MODEL = "openai/gpt-oss-20b";

export interface GroqOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

interface GroqResponseBody {
  choices?: Array<{
    message?: { content?: string | null; reasoning?: unknown };
    text?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  error?: { message?: string; type?: string };
}

export class GroqProvider implements ProviderAdapter {
  readonly name = "groq" as const;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private lastRateLimit: RateLimitInfo = {};
  private modelCache: string[] | null = null;

  constructor(opts: GroqOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? GROQ_BASE;
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  remainingTokens(): number | undefined {
    return this.lastRateLimit.remainingTokens;
  }

  /** Rate-limit state from the most recent response, for proactive switching. */
  get rateLimit(): RateLimitInfo {
    return this.lastRateLimit;
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    if (this.modelCache) return this.modelCache;
    const res = await this.fetchImpl(`${this.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) throw new Error(`groq /models failed: ${res.status}`);
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    const models = (body.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    this.modelCache = models;
    return models;
  }

  async complete(req: CompletionRequest, model?: string): Promise<ProviderResponse> {
    // A live call is not always given a model: the router resolves one from the
    // preference list, but a direct `provider.complete(req)` — a live smoke test,
    // a one-off script — may not, and `buildBody` then passed `undefined` into
    // isReasoningModel(), which does `model.toLowerCase()` and threw
    // "Cannot read properties of undefined". Fall back to the documented default
    // rather than crashing.
    const chosen = model ?? DEFAULT_MODEL;
    const body = this.buildBody(req, chosen, false);
    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      ...(req.signal ? { signal: req.signal } : {}),
    });

    this.lastRateLimit = parseRateLimitHeaders(res.headers);
    const text = await res.text();

    if (!res.ok) {
      const err = new Error(`groq ${res.status}: ${text.slice(0, 300)}`) as Error & {
        status?: number;
        body?: string;
        headers?: Headers;
      };
      err.status = res.status;
      err.body = text;
      err.headers = res.headers;
      throw err;
    }

    return this.parseBody(text, res.headers);
  }

  private buildBody(req: CompletionRequest, model: string, stream: boolean): unknown {
    const messages = req.messages.map((m) => ({ role: m.role, content: m.content }));
    const body: Record<string, unknown> = {
      model,
      messages,
      temperature: req.temperature ?? 0.9,
      stream,
    };
    // A4: reasoning models need a completion budget large enough to think in.
    // Groq's quick start uses `max_completion_tokens` for them, and reasoning
    // tokens count against the limit, so a 120-token cap returns empty content.
    const maxTokens = completionTokenLimit(model, req.maxTokens ?? 300);
    if (isReasoningModel(model)) {
      body.max_completion_tokens = maxTokens;
    } else {
      body.max_tokens = maxTokens;
    }
    // A4: gpt-oss rejects reasoning_format and wants include_reasoning:false.
    // reasoningParams() picks exactly one of the mutually exclusive pair.
    Object.assign(body, reasoningParams(model));
    return body;
  }

  private parseBody(text: string, headers: Headers): ProviderResponse {
    let parsed: GroqResponseBody;
    try {
      parsed = JSON.parse(text) as GroqResponseBody;
    } catch {
      throw new Error(`groq returned non-JSON: ${text.slice(0, 200)}`);
    }
    const choice = parsed.choices?.[0];
    // Reasoning may arrive as message.reasoning even with format=hidden, if the
    // model or a proxy ignores the parameter. Strip it either way.
    const split = stripReasoning({
      content: choice?.message?.content ?? choice?.text ?? "",
      reasoning: choice?.message?.reasoning,
    });
    const reasoningTokens =
      parsed.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
    return {
      text: split.content,
      tokensIn: parsed.usage?.prompt_tokens ?? 0,
      tokensOut: parsed.usage?.completion_tokens ?? 0,
      reasoningTokens,
      headers,
    };
  }

  /**
   * SSE streaming. Groq emits `data: {json}\n\n` lines terminated by
   * `data: [DONE]`. Callers get only content deltas.
   */
  async *stream(req: CompletionRequest, model: string): AsyncGenerator<string> {
    const body = this.buildBody(req, model, true);
    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(body),
      ...(req.signal ? { signal: req.signal } : {}),
    });
    if (!res.ok) {
      const err = new Error(`groq stream ${res.status}`) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
    for await (const chunk of iterateSse(res as unknown as { body?: unknown })) {
      yield chunk;
    }
  }
}

/**
 * Parse a server-sent-events body into content deltas.
 *
 * Deliberately tolerant of awkward chunking: a chunk can split mid-JSON, mid
 * `data:` line, or deliver `[DONE]` on its own. Anything that is not a complete
 * `data: {json}` object is buffered until the next chunk completes it.
 */
export async function* iterateSse(
  response: { body?: unknown },
): AsyncGenerator<string> {
  const body = response.body as
    | { getReader?: () => ReadableStreamDefaultReader<Uint8Array> }
    | undefined;
  if (!body?.getReader) return;

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Events are separated by a blank line; keep the tail for the next chunk.
    let sep: { index: number; length: number } | null;
    while ((sep = indexOfEventSeparator(buffer)) !== null) {
      const rawEvent = buffer.slice(0, sep.index);
      buffer = buffer.slice(sep.index + sep.length);
      const delta = parseSseEvent(rawEvent);
      if (delta !== null) yield delta;
    }
  }

  // A trailing event with no final blank line.
  const tail = parseSseEvent(buffer);
  if (tail !== null) yield tail;
}

function indexOfEventSeparator(buffer: string): { index: number; length: number } | null {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1 && crlf === -1) return null;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

/** One SSE event's text -> a content delta, or null when there is nothing to add. */
export function parseSseEvent(raw: string): string | null {
  const lines = raw.split(/\r?\n/);
  let sawDone = false;
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "[DONE]") {
      sawDone = true;
      continue;
    }
    if (data.length === 0) continue;
    let obj: {
      choices?: Array<{ delta?: { content?: string | null } }>;
    };
    try {
      obj = JSON.parse(data);
    } catch {
      // Truncated JSON — the next chunk completes it.
      continue;
    }
    const delta = obj.choices?.[0]?.delta?.content;
    if (typeof delta === "string" && delta.length > 0) return delta;
  }
  void sawDone;
  return null;
}