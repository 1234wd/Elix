/**
 * The brain router (B2, B3, B6, B8).
 *
 * Order: Groq -> Hugging Face -> builtin (scripted).
 *
 * Responsibilities:
 *   - resolve each role to the first available model in models.yaml (B2)
 *   - skip models that are cooling down, disabled, or low on tokens (B3)
 *   - persist cooldowns in SQLite so a restart does not hammer a limited model
 *   - fall back to a scripted line rather than going silent
 *   - record every attempt in the usage table
 *
 * The router never imports mineflayer. It takes messages and returns text.
 */
import {
  budgetMessages,
  estimateTokens,
  normalizePrompt,
  CACHE_WINDOW_MS,
  ReplyCache,
  IdleBudget,
} from "./budget.js";
import { pickFallbackLine, classifySituation, type FallbackSituation } from "./fallback.js";
import {
  classifyLimitWindow,
  isCreditOrQuotaError,
  parseRateLimitHeaders,
  type RateLimitInfo,
} from "./ratelimit.js";
import type { BrainStore } from "./store.js";
import type { UsageOutcome } from "./store.js";
import type {
  AttemptRecord,
  ChatMessage,
  CompletionRequest,
  CompletionResult,
  ProviderAdapter,
  SkipReason,
} from "./types.js";
import type { ModelRole, ModelsConfig, ProviderName } from "../core/config.js";

/** Circuit breaker: three consecutive failures opens it for 60 s (vision rule 3). */
export const CIRCUIT_FAILURES = 3;
export const CIRCUIT_OPEN_MS = 60_000;

/** Model discovery is cached for six hours (B2). */
export const MODEL_CACHE_MS = 6 * 60 * 60 * 1000;

/** A provider disabled by 401/402/403 stays out until this long (one day). */
export const DAY_MS = 24 * 60 * 60 * 1000;

export interface Candidate {
  provider: ProviderName;
  model: string;
}

export interface RoleResolution {
  role: ModelRole;
  /** The model chosen, or null when the role falls back to builtin. */
  chosen: Candidate | null;
  /** Ordered candidates actually available right now. */
  available: Candidate[];
  /** Why each candidate was skipped. */
  skipped: Array<{ candidate: Candidate; reason: SkipReason }>;
}

interface CircuitState {
  failures: number;
  openUntil: number;
}

export interface RouterOptions {
  models: ModelsConfig;
  providers: Partial<Record<ProviderName, ProviderAdapter>>;
  store: BrainStore;
  log?: {
    info(obj: unknown, msg?: string): void;
    warn(obj: unknown, msg?: string): void;
    error(obj: unknown, msg?: string): void;
    debug(obj: unknown, msg?: string): void;
  };
  now?: () => number;
  random?: () => number;
  fastMaxTokens?: number;
  smartMaxTokens?: number;
  idleChatterBudgetPerHour?: number;
  /** Turn the cache off in tests that assert a network call happened. */
  cacheEnabled?: boolean;
}

export class BrainRouter {
  private readonly opts: RouterOptions;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly circuits = new Map<string, CircuitState>();
  private readonly cache: ReplyCache;
  private readonly idle: IdleBudget;
  private readonly recentLines: string[] = [];
  /** provider -> available model ids, refreshed at most every 6 h. */
  private readonly modelLists = new Map<ProviderName, string[]>();
  private readonly modelListFetchedAt = new Map<ProviderName, number>();
  /** provider -> models disabled until, from 401/402/403 or HF credits. */
  private readonly disabledUntil = new Map<ProviderName, number>();
  private readonly disabledReason = new Map<ProviderName, string>();
  /** provider+model -> remaining tokens from the last response. */
  private readonly remainingTokens = new Map<string, number>();

  constructor(opts: RouterOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.cache = new ReplyCache(CACHE_WINDOW_MS);
    this.idle = new IdleBudget(opts.idleChatterBudgetPerHour ?? 60);
    this.loadPersistedState();
  }

  // -- persisted state ----------------------------------------------------

  private loadPersistedState(): void {
    const now = this.now();
    for (const row of this.opts.store.allCooldowns()) {
      if (row.until > now) {
        // Re-seed into the in-memory map so the router does not re-hit /models
        // and does not immediately try a still-limited model (B3).
        this.opts.store.activeCooldowns(now);
      }
    }
    for (const row of this.opts.store.activeCooldowns(now)) {
      if (row.disabledForDay) {
        this.disabledUntil.set(row.provider as ProviderName, row.until);
        this.disabledReason.set(row.provider as ProviderName, row.reason);
      }
    }
  }

  private isCooling(provider: string, model: string, now: number): CooldownInfo | null {
    for (const row of this.opts.store.activeCooldowns(now)) {
      if (row.provider === provider && row.model === model) {
        return { until: row.until, reason: row.reason };
      }
    }
    return null;
  }

  private circuitFor(provider: string, model: string): CircuitState {
    const key = `${provider}/${model}`;
    let state = this.circuits.get(key);
    if (!state) {
      state = { failures: 0, openUntil: 0 };
      this.circuits.set(key, state);
    }
    return state;
  }

  // -- model discovery (B2) ------------------------------------------------

  /** Model ids for a provider, from cache or /models. */
  async modelsFor(provider: ProviderName, signal?: AbortSignal): Promise<string[]> {
    const now = this.now();
    const fetchedAt = this.modelListFetchedAt.get(provider);
    const inMemory = this.modelLists.get(provider);
    if (inMemory && fetchedAt !== undefined && now - fetchedAt < MODEL_CACHE_MS) {
      return inMemory;
    }
    // Try the persisted cache before hitting the network.
    const cached = this.opts.store.getCachedModels(provider, MODEL_CACHE_MS, now);
    if (cached) {
      this.modelLists.set(provider, cached);
      this.modelListFetchedAt.set(provider, now);
      return cached;
    }
    const adapter = this.opts.providers[provider];
    if (!adapter) return [];
    try {
      const models = await adapter.listModels(signal);
      this.modelLists.set(provider, models);
      this.modelListFetchedAt.set(provider, now);
      this.opts.store.cacheModels(provider, models, now);
      return models;
    } catch (err) {
      this.opts.log?.warn(
        { provider, err: (err as Error).message },
        "model discovery failed — using configured ids",
      );
      return [];
    }
  }

  /** Resolve every role to the first model that is actually available. */
  async resolveRoles(signal?: AbortSignal): Promise<RoleResolution[]> {
    const out: RoleResolution[] = [];
    for (const [role, spec] of Object.entries(this.opts.models.roles) as Array<
      [ModelRole, { preference: Array<{ provider: ProviderName; model: string }> }]
    >) {
      out.push(await this.resolveRole(role, spec.preference, signal));
    }
    return out;
  }

  async resolveRole(
    role: ModelRole,
    preference: Array<{ provider: ProviderName; model: string }>,
    signal?: AbortSignal,
  ): Promise<RoleResolution> {
    const available: Candidate[] = [];
    const skipped: Array<{ candidate: Candidate; reason: SkipReason }> = [];
    const now = this.now();

    for (const entry of preference) {
      const candidate: Candidate = { provider: entry.provider, model: entry.model };

      if (entry.provider === "builtin") {
        // builtin is always available; it is the terminal fallback.
        available.push(candidate);
        continue;
      }
      const adapter = this.opts.providers[entry.provider];
      if (!adapter) {
        skipped.push({ candidate, reason: "no-key" });
        continue;
      }
      const disabledUntil = this.disabledUntil.get(entry.provider);
      if (disabledUntil !== undefined && disabledUntil > now) {
        skipped.push({ candidate, reason: "disabled-for-day" });
        continue;
      }
      // Only accept ids the provider actually offers, when we know them.
      const models = await this.modelsFor(entry.provider, signal);
      if (models.length > 0 && !models.includes(entry.model)) {
        skipped.push({ candidate, reason: "not-in-model-list" });
        continue;
      }
      available.push(candidate);
    }

    return { role, chosen: available[0] ?? null, available, skipped };
  }

  // -- the main path -------------------------------------------------------

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const started = this.now();
    const role = req.role;
    const budget = role === "fast" ? (this.opts.fastMaxTokens ?? 1500) : (this.opts.smartMaxTokens ?? 4000);

    // B7: an already-aborted signal means shutdown. Return the scripted line
    // without touching the network — not even /models.
    if (req.signal?.aborted) {
      return this.scriptedFallback(req.messages, role, "aborted before dispatch", started);
    }

    // B6: idle chatter is capped. Greetings/combat/movement never reach here.
    if (!req.bypassIdleBudget && !this.idle.tryConsume(started)) {
      const situation = classifySituation(lastUserText(req.messages));
      this.opts.store.recordUsage({
        ts: started,
        provider: "builtin",
        model: "idle-budget",
        role,
        tokensIn: 0,
        tokensOut: 0,
        reasoningTokens: 0,
        latencyMs: 0,
        outcome: "fallback",
        error: "idle budget exhausted",
      });
      const text = pickFallbackLine(situation, this.recentLines, this.random);
      return {
        text,
        provider: "builtin",
        model: "idle-budget",
        fromFallback: true,
        tokensIn: 0,
        tokensOut: 0,
        reasoningTokens: 0,
        latencyMs: 0,
        fallbackReason: "idle budget exhausted",
        fallbackSituation: situation,
      };
    }

    // B6: cache identical prompts for ten minutes.
    const cacheKey = normalizePrompt(req.messages);
    if (this.opts.cacheEnabled !== false) {
      const hit = this.cache.get(cacheKey, started);
      if (hit !== null) {
        return {
          text: hit,
          provider: "builtin",
          model: "cache",
          fromFallback: false,
          tokensIn: 0,
          tokensOut: 0,
          reasoningTokens: 0,
          latencyMs: 0,
        };
      }
    }

    const spec = this.opts.models.roles[role];
    const preference = spec?.preference ?? [{ provider: "builtin" as const, model: "text-only" }];
    const resolution = await this.resolveRole(role, preference, req.signal);

    const attempts: AttemptRecord[] = [];
    const trimmed = budgetMessages(req.messages, budget);

    for (const candidate of resolution.available) {
      if (candidate.provider === "builtin") break; // handled by the fallback below

      const adapter = this.opts.providers[candidate.provider];
      if (!adapter) continue;

      const now = this.now();

      // Circuit breaker.
      const circuit = this.circuitFor(candidate.provider, candidate.model);
      if (circuit.openUntil > now) {
        this.attempt(
          attempts,
          role,
          {
            provider: candidate.provider,
            model: candidate.model,
            outcome: "network",
            latencyMs: 0,
            skip: "circuit-open",
          },
        );
        continue;
      }

      // Cooldown from a previous 429.
      const cooling = this.isCooling(candidate.provider, candidate.model, now);
      if (cooling) {
        this.attempt(attempts, role, {
          provider: candidate.provider,
          model: candidate.model,
          outcome: "429",
          latencyMs: 0,
          skip: "cooldown",
        });
        continue;
      }

      // Proactive switching: skip before the 429 if the token budget is short.
      const remaining = this.remainingTokens.get(`${candidate.provider}/${candidate.model}`);
      const promptTokens = estimateTokens(trimmed.messages.map((m) => m.content).join("\n"));
      if (remaining !== undefined && remaining < promptTokens) {
        this.attempt(attempts, role, {
          provider: candidate.provider,
          model: candidate.model,
          outcome: "network",
          latencyMs: 0,
          skip: "proactive-token-limit",
        });
        continue;
      }

      const attemptStart = this.now();
      try {
        const res = await adapter.complete({ ...req, messages: trimmed.messages }, candidate.model);
        const latencyMs = this.now() - attemptStart;

        // Record rate-limit headers for the next proactive decision (B3).
        if (res.headers) this.recordRateLimit(candidate, parseRateLimitHeaders(res.headers));

        circuit.failures = 0;
        this.opts.store.clearCooldown(candidate.provider, candidate.model);

        this.attempt(attempts, role, {
          provider: candidate.provider,
          model: candidate.model,
          outcome: "ok",
          latencyMs,
          tokensIn: res.tokensIn,
          tokensOut: res.tokensOut,
          reasoningTokens: res.reasoningTokens,
        });

        if (this.opts.cacheEnabled !== false) {
          this.cache.set(cacheKey, res.text, this.now());
        }

        return {
          text: res.text,
          provider: candidate.provider,
          model: candidate.model,
          fromFallback: false,
          tokensIn: res.tokensIn,
          tokensOut: res.tokensOut,
          reasoningTokens: res.reasoningTokens,
          latencyMs: this.now() - started,
        };
      } catch (err) {
        const latencyMs = this.now() - attemptStart;
        this.handleFailure(candidate, err, circuit);
        const outcome = this.classifyOutcome(candidate, err);
        this.attempt(attempts, role, {
          provider: candidate.provider,
          model: candidate.model,
          outcome,
          latencyMs,
          error: (err as Error).message.slice(0, 200),
        });
      }
    }

    // B6: never silent. Fall back to a scripted line.
    const reason = attempts.length === 0 ? "no candidates" : attempts.map((a) => a.outcome).join(",");
    return this.scriptedFallback(req.messages, role, reason, started);
  }

  /**
   * The terminal fallback: a scripted in-character line, recorded in the usage
   * table (B6, B8). Never throws, so the caller always has something to say.
   */
  private scriptedFallback(
    messages: ChatMessage[],
    role: ModelRole,
    reason: string,
    started: number,
  ): CompletionResult {
    const situation = classifySituation(lastUserText(messages));
    const text = pickFallbackLine(situation, this.recentLines, this.random);
    this.opts.store.recordUsage({
      ts: this.now(),
      provider: "builtin",
      model: "scripted",
      role,
      tokensIn: 0,
      tokensOut: 0,
      reasoningTokens: 0,
      latencyMs: 0,
      outcome: "fallback",
      error: reason,
    });
    return {
      text,
      provider: "builtin",
      model: "scripted",
      fromFallback: true,
      tokensIn: 0,
      tokensOut: 0,
      reasoningTokens: 0,
      latencyMs: this.now() - started,
      fallbackReason: reason,
      fallbackSituation: situation,
    };
  }

  /**
   * Record one attempt, exactly once (B8).
   *
   * An earlier version re-recorded the whole accumulated list after every
   * failure, so a three-provider cascade wrote 1+2+3 = 6 rows instead of 3 and
   * `elix usage` overstated the traffic. Push and record together instead.
   */
  private attempt(
    attempts: AttemptRecord[],
    role: ModelRole,
    record: AttemptRecord,
  ): void {
    attempts.push(record);
    this.opts.store.recordUsage({
      ts: this.now(),
      provider: record.provider,
      model: record.model,
      role,
      tokensIn: record.tokensIn ?? 0,
      tokensOut: record.tokensOut ?? 0,
      reasoningTokens: record.reasoningTokens ?? 0,
      latencyMs: record.latencyMs,
      outcome: record.skip ? skipOutcome(record.skip) : record.outcome,
      ...(record.error ? { error: record.error } : {}),
    });
  }

  private recordRateLimit(candidate: Candidate, info: RateLimitInfo): void {
    if (info.remainingTokens !== undefined) {
      this.remainingTokens.set(`${candidate.provider}/${candidate.model}`, info.remainingTokens);
    }
  }

  private classifyOutcome(candidate: Candidate, err: unknown): AttemptRecord["outcome"] {
    const e = err as { status?: number; name?: string; message?: string; hfCredits?: boolean };
    if (e.name === "AbortError") return "abort";
    if (e.name === "TimeoutError") return "timeout";
    if (e.status === 429) return "429";
    if (e.status === 401) return "401";
    if (e.status === 402) return "402";
    if (e.status === 403) return "403";
    if (typeof e.status === "number" && e.status >= 500) return "5xx";
    if (e.status !== undefined) return "network";
    return "network";
  }

  /**
   * React to a failure: cooldown for 429, day-disable for 401/402/403 and HF
   * credit errors, circuit-breaker counting for everything else (B3).
   */
  private handleFailure(candidate: Candidate, err: unknown, circuit: CircuitState): void {
    const now = this.now();
    const e = err as { status?: number; name?: string; body?: string; hfCredits?: boolean; message?: string };
    const key = `${candidate.provider}/${candidate.model}`;

    if (e.status === 429) {
      const window = classifyLimitWindow(e.body ?? "", parseRateLimitHeadersFromError(e), now);
      this.opts.store.setCooldown({
        provider: candidate.provider,
        model: candidate.model,
        until: window.retryAt,
        reason: window.kind === "day" ? `daily limit: ${window.reason}` : window.reason,
        disabledForDay: window.kind === "day",
      });
      if (window.kind === "day") {
        // A daily exhaustion disables the whole provider, not just this model.
        this.disabledUntil.set(candidate.provider, window.retryAt);
        this.disabledReason.set(candidate.provider, "daily limit");
      }
      this.opts.log?.warn({ provider: candidate.provider, model: candidate.model, ...window }, "rate limited");
      return;
    }

    if (e.status === 401 || e.status === 402 || e.status === 403 || e.hfCredits === true) {
      const until = now + DAY_MS;
      const reason =
        e.hfCredits === true || isCreditOrQuotaError(e.body ?? "")
          ? "out of credit/quota"
          : `auth ${e.status}`;
      this.disabledUntil.set(candidate.provider, until);
      this.disabledReason.set(candidate.provider, reason);
      this.opts.store.setCooldown({
        provider: candidate.provider,
        model: candidate.model,
        until,
        reason,
        disabledForDay: true,
      });
      this.opts.log?.warn(
        { provider: candidate.provider, model: candidate.model, reason, until: new Date(until).toISOString() },
        "provider disabled for the day",
      );
      return;
    }

    // A shutdown abort is not a provider failure, so it must not trip the
    // breaker — otherwise Ctrl+C during a request would mute the provider.
    const e0 = err as { name?: string };
    if (e0.name === "AbortError") return;

    // Network / 5xx / timeout: trip the circuit after three in a row.
    circuit.failures += 1;
    if (circuit.failures >= CIRCUIT_FAILURES) {
      circuit.openUntil = now + CIRCUIT_OPEN_MS;
      circuit.failures = 0;
      this.opts.log?.warn(
        { provider: candidate.provider, model: candidate.model },
        "circuit opened for 60s",
      );
    }
    void key;
  }

  /** Providers currently disabled, with the reason — for `doctor` and `usage`. */
  disabledProviders(): Array<{ provider: ProviderName; until: number; reason: string }> {
    const now = this.now();
    const out: Array<{ provider: ProviderName; until: number; reason: string }> = [];
    for (const [provider, until] of this.disabledUntil) {
      if (until > now) {
        out.push({ provider, until, reason: this.disabledReason.get(provider) ?? "unknown" });
      }
    }
    return out;
  }

  /** Active cooldowns, soonest first — for `elix usage`. */
  activeCooldowns(): Array<{ provider: string; model: string; until: number; reason: string }> {
    return this.opts.store.activeCooldowns(this.now());
  }
}

interface CooldownInfo {
  until: number;
  reason: string;
}

/** Map a skip reason onto a usage-table outcome (B8). */
function skipOutcome(skip: SkipReason): UsageOutcome {
  switch (skip) {
    case "cooldown":
      return "429";
    case "circuit-open":
      return "circuit-open";
    case "disabled-for-day":
      return "401";
    case "no-key":
      return "no-keys";
    case "not-in-model-list":
    case "proactive-token-limit":
      return "fallback";
  }
}

function lastUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") return messages[i]!.content;
  }
  return "";
}

/** Errors carry their response headers so the 429 window can be read. */
function parseRateLimitHeadersFromError(err: unknown): RateLimitInfo {
  const e = err as { headers?: Headers };
  return parseRateLimitHeaders(e.headers);
}

export type { FallbackSituation };