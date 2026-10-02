/**
 * Types for the brain router (Phase 3).
 *
 * The LLM never calls mineflayer. It returns text or typed data; the skill
 * layer acts on that. Nothing here imports a game module.
 */

import type { ProviderName, ModelRole } from "../core/config.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  /** Higher = more important. The budgeter trims the lowest first. */
  importance?: number;
  /** Never trimmed, even under budget pressure (open promises, newest turn). */
  pinned?: boolean;
}

export interface CompletionRequest {
  messages: ChatMessage[];
  role: ModelRole;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Set false for idle chatter that should respect the hourly budget. */
  bypassIdleBudget?: boolean;
  /** Identifies the caller for usage attribution, e.g. "chat-reply". */
  source?: string;
}

export interface CompletionResult {
  text: string;
  provider: ProviderName;
  model: string;
  /** True when no provider was reachable and a scripted line was used. */
  fromFallback: boolean;
  tokensIn: number;
  tokensOut: number;
  reasoningTokens: number;
  latencyMs: number;
  /** Populated when fromFallback is true. */
  fallbackReason?: string;
  /** Which situation tag the scripted line came from. */
  fallbackSituation?: string;
}

/** Why a model was skipped or a call failed. */
export type SkipReason =
  | "cooldown"
  | "circuit-open"
  | "disabled-for-day"
  | "proactive-token-limit"
  | "no-key"
  | "not-in-model-list";

export interface AttemptRecord {
  provider: ProviderName;
  model: string;
  outcome: "ok" | "429" | "401" | "402" | "403" | "timeout" | "abort" | "5xx" | "network";
  latencyMs: number;
  skip?: SkipReason;
  tokensIn?: number;
  tokensOut?: number;
  reasoningTokens?: number;
  error?: string;
}

export interface ProviderAdapter {
  readonly name: ProviderName;
  /** Models the provider currently offers, from /models. */
  listModels(signal?: AbortSignal): Promise<string[]>;
  complete(req: CompletionRequest, model: string): Promise<ProviderResponse>;
  stream?(req: CompletionRequest, model: string): AsyncIterable<string>;
  /** Remaining tokens reported by the last call, for proactive switching. */
  remainingTokens?(): number | undefined;
}

export interface ProviderResponse {
  text: string;
  tokensIn: number;
  tokensOut: number;
  reasoningTokens: number;
  /** Response headers, parsed into rate-limit info. */
  headers?: Headers;
}

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  headers: Headers;
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;