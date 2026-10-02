/**
 * Hugging Face adapter.
 *
 * Two different routes, and conflating them is a real bug (A3):
 *
 *   chat        https://router.huggingface.co/v1/chat/completions
 *               OpenAI-compatible. Provider selection is expressed by the model
 *               id itself — HF's router accepts the bare model id
 *               (e.g. "meta-llama/Llama-3.3-70B-Instruct") and also the
 *               "provider:model" form. We pass ids straight through from
 *               config/models.yaml, so whatever the operator configured is what
 *               the router sees. Documented rather than guessed: the router docs
 *               show both, and bare ids resolve against the router's provider
 *               table.
 *
 *   embeddings  https://router.huggingface.co/hf-inference/models/{model}/pipeline/feature-extraction
 *               NOT on /v1. Each path segment is encoded separately so the
 *               slash in "BAAI/bge-small-en-v1.5" survives.
 *
 * Free HF credit is tiny. A credits/quota error disables the provider for the
 * day rather than retrying into a wall.
 */
import { stripReasoning } from "./reasoning.js";
import { isCreditOrQuotaError } from "./ratelimit.js";
import { EMBEDDINGS_TIMEOUT_MS } from "./router.js";
import type {
  CompletionRequest,
  FetchLike,
  ProviderAdapter,
  ProviderResponse,
} from "./types.js";

export const HF_ROUTER = "https://router.huggingface.co";
export const HF_CHAT_URL = `${HF_ROUTER}/v1/chat/completions`;

/**
 * Normalise a configured HF base URL down to the router root.
 *
 * config/models.yaml writes `https://router.huggingface.co/v1` (the OpenAI-
 * compatible prefix, which is how most people know the endpoint), but the
 * embeddings route is NOT under /v1 — it is /hf-inference/... on the router
 * root. Appending to the configured value as-is produced
 * `.../v1/v1/chat/completions` and `.../v1/hf-inference/...`, both 404.
 *
 * Trailing slashes and a trailing /v1 are stripped so either spelling works.
 */
export function hfRouterRoot(base: string): string {
  return base.replace(/\/+$/, "").replace(/\/v1$/, "");
}

/**
 * Build the feature-extraction URL. Each segment is encoded so an owner prefix
 * keeps its real slash.
 */
export function hfEmbeddingsUrl(model: string, base = HF_ROUTER): string {
  const encoded = model
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/");
  return `${base}/hf-inference/models/${encoded}/pipeline/feature-extraction`;
}

export interface HfOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

interface HfResponseBody {
  choices?: Array<{ message?: { content?: string | null; reasoning?: unknown } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  error?: { message?: string };
}

/**
 * An HF failure, carrying what the router needs to decide a cooldown length.
 *
 * `headers` matters: a 429 with `retry-after: 30` should wait 30 seconds, and
 * without the headers attached the router can only guess a conservative 60.
 */
interface HfError extends Error {
  status?: number;
  body?: string;
  headers?: Headers;
  hfCredits?: boolean;
}

export class HuggingFaceProvider implements ProviderAdapter {
  readonly name = "hf" as const;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private modelCache: string[] | null = null;

  constructor(opts: HfOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = hfRouterRoot(opts.baseUrl ?? HF_ROUTER);
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    if (this.modelCache) return this.modelCache;
    const res = await this.fetchImpl(`${this.baseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) throw new Error(`hf /models failed: ${res.status}`);
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    const models = (body.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    this.modelCache = models;
    return models;
  }

  async complete(req: CompletionRequest, model: string): Promise<ProviderResponse> {
    const body: Record<string, unknown> = {
      model,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: req.temperature ?? 0.9,
      max_tokens: req.maxTokens ?? 300,
    };
    const res = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      ...(req.signal ? { signal: req.signal } : {}),
    });

    const text = await res.text();
    if (!res.ok) {
      // A7: an HF 429 is usually just a short rate limit, not an empty
      // account. Treating every 429 as "out of credit" disabled HF for 24
      // hours after a single burst. Only a body that actually says credit,
      // quota or payment escalates to a day-long disable; otherwise the router
      // applies a normal cooldown from retry-after (or 60 s).
      //
      // The headers MUST ride along on the error: without them the router sees
      // no retry-after and falls back to its conservative 60 s.
      const credits = isCreditOrQuotaError(text);
      if (res.status === 402 || credits) {
        const err = new Error(
          `hf out of credit/quota (${res.status}): ${text.slice(0, 200)}`,
        ) as HfError;
        err.status = res.status;
        err.body = text;
        err.headers = res.headers;
        err.hfCredits = true;
        throw err;
      }
      const err = new Error(`hf ${res.status}: ${text.slice(0, 300)}`) as HfError;
      err.status = res.status;
      err.body = text;
      err.headers = res.headers;
      throw err;
    }

    const parsed = JSON.parse(text) as HfResponseBody;
    const choice = parsed.choices?.[0];
    const split = stripReasoning({
      content: choice?.message?.content ?? "",
      reasoning: choice?.message?.reasoning,
    });
    return {
      text: split.content,
      tokensIn: parsed.usage?.prompt_tokens ?? 0,
      tokensOut: parsed.usage?.completion_tokens ?? 0,
      reasoningTokens: parsed.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
      headers: res.headers,
    };
  }

  /**
   * Embed a batch of strings. Phase 4 memory uses this; each memory is
   * embedded exactly once and stored, because free credit is about $0.10/month.
   */
  /**
   * Embed a batch of strings. Phase 4 memory uses this; each memory is
   * embedded exactly once and stored, because free credit is about $0.10/month.
   *
   * A6: takes an AbortSignal and applies the 10 s embeddings timeout. Without
   * it a hung request blocked the backfill worker forever and no memory would
   * ever get a vector. A timeout throws, the caller leaves the row unembedded,
   * and the next pass retries it.
   */
  async embed(
    inputs: string[],
    model: string,
    signal?: AbortSignal,
    timeoutMs = EMBEDDINGS_TIMEOUT_MS,
  ): Promise<number[][]> {
    const deadline = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const res = await this.fetchImpl(hfEmbeddingsUrl(model, this.baseUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ inputs }),
      signal: combined,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`hf embeddings ${res.status}: ${text.slice(0, 300)}`);
    }
    const parsed = JSON.parse(text) as unknown;
    // The pipeline endpoint returns either one vector or one per input.
    if (Array.isArray(parsed) && typeof parsed[0] === "number") {
      return [parsed as number[]];
    }
    if (Array.isArray(parsed)) return parsed as number[][];
    throw new Error("hf embeddings returned an unexpected shape");
  }
}