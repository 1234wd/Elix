/**
 * Wire up the brain router from config + environment (B2).
 *
 * Builds providers only for keys that are present, so a missing key means that
 * provider is simply absent from the preference walk rather than a 401 at call
 * time.
 */
import { GroqProvider } from "./groq.js";
import { HuggingFaceProvider } from "./hf.js";
import { NvidiaProvider, OllamaProvider, OLLAMA_PROBE_TIMEOUT_MS, probeOllama } from "./providers/local.js";
import { BrainRouter } from "./router.js";
import { BrainStore, defaultDbPath } from "./store.js";
import type { ElixConfig, ModelsConfig, ProviderName } from "../core/config.js";
import type { ProviderAdapter, FetchLike } from "./types.js";

export interface BuildBrainOptions {
  models: ModelsConfig;
  env?: NodeJS.ProcessEnv;
  projectRoot: string;
  /** Elix config; supplies the token/idle budgets when they are not passed. */
  config?: ElixConfig;
  store?: BrainStore;
  fetchImpl?: FetchLike;
  now?: () => number;
  random?: () => number;
  fastMaxTokens?: number;
  smartMaxTokens?: number;
  /** A3: availability probes for models off the /v1/chat route. */
  availabilityChecks?: Record<string, () => Promise<boolean>>;
  /** A3: explicit overrides; otherwise taken from config.brain.timeoutsMs. */
  fastTimeoutMs?: number;
  smartTimeoutMs?: number;
  idleChatterBudgetPerHour?: number;
}

export interface BrainHandle {
  router: BrainRouter;
  store: BrainStore;
  providers: Partial<Record<ProviderName, ProviderAdapter>>;
  /**
   * Resolves once the ASYNC provider checks have finished.
   *
   * Ollama is the only provider whose existence cannot be known from the environment: a key
   * is either in .env or it is not, but a local server is either running or it is not. So
   * `buildBrain` returns immediately and fills `providers.ollama` in when - and only when -
   * the probe answers. Anything that wants the final list awaits this.
   */
  providersReady: Promise<void>;
  /** Whether the local provider was found, and the models it offered. Null when it was not. */
  ollamaModels: string[] | null;
  close(): void;
}

export function buildBrain(opts: BuildBrainOptions): BrainHandle {
  const env = opts.env ?? process.env;
  const providers: Partial<Record<ProviderName, ProviderAdapter>> = {};
  const groqKey = env["GROQ_API_KEY"]?.trim();
  const hfKey = env["HF_TOKEN"]?.trim();
  // Round 18: the NVIDIA tier was in models.yaml all along and buildBrain never built it,
  // so every nvidia entry was skipped even with the key sitting in .env.
  const nvidiaKey = env["NVIDIA_API_KEY"]?.trim();

  if (groqKey) {
    providers["groq"] = new GroqProvider({
      apiKey: groqKey,
      baseUrl: opts.models.providers.groq?.baseUrl ?? undefined,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
  }
  if (hfKey) {
    providers["hf"] = new HuggingFaceProvider({
      apiKey: hfKey,
      baseUrl: opts.models.providers.hf?.baseUrl ?? undefined,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
  }
  if (nvidiaKey) {
    providers["nvidia"] = new NvidiaProvider({
      apiKey: nvidiaKey,
      baseUrl: opts.models.providers.nvidia?.baseUrl ?? undefined,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
  }

  // `builtin` needs no provider: the router synthesises scripted lines.

  // Ollama is different: no key, but the local server may simply not be running. It is
  // added ONLY if the reachability probe answers, and silently stays absent otherwise - a
  // bot that complains about a local model the owner never installed is worse than one
  // that forgets it. One second, because this runs at startup and blocks nothing else.
  let ollamaModels: string[] | null = null;
  const providersReady = probeOllama({
    timeoutMs: OLLAMA_PROBE_TIMEOUT_MS,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.models.providers.ollama?.baseUrl ? { baseUrl: String(opts.models.providers.ollama.baseUrl) } : {}),
  })
    .then((models) => {
      if (models === null) return;
      ollamaModels = models;
      providers["ollama"] = new OllamaProvider({
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        ...(opts.models.providers.ollama?.baseUrl ? { baseUrl: String(opts.models.providers.ollama.baseUrl) } : {}),
      });
    })
    .catch(() => {
      // Unreachable local server is the expected case, not an error worth throwing over.
    });

  const store = opts.store ?? new BrainStore(defaultDbPath(opts.projectRoot));

  const router = new BrainRouter({
    models: opts.models,
    providers,
    store,
    fastMaxTokens: opts.fastMaxTokens ?? opts.config?.brain.fastMaxTokens,
    smartMaxTokens: opts.smartMaxTokens ?? opts.config?.brain.smartMaxTokens,
    // A3: brain.timeoutsMs was validated by the config schema and then never
    // read, so every call silently used the hard-coded defaults. Changing
    // timeoutsMs.fast in config/elix.yaml did nothing at all.
    ...(opts.availabilityChecks
      ? { availabilityChecks: opts.availabilityChecks }
      : {}),
    fastTimeoutMs: opts.fastTimeoutMs ?? opts.config?.brain.timeoutsMs.fast,
    smartTimeoutMs: opts.smartTimeoutMs ?? opts.config?.brain.timeoutsMs.smart,
    idleChatterBudgetPerHour:
      opts.idleChatterBudgetPerHour ?? opts.config?.brain.idleChatterBudgetPerHour,
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.random ? { random: opts.random } : {}),
  });

  return {
    router,
    store,
    providers,
    providersReady,
    // A GETTER, not the value: the probe resolves after this object is returned, so handing
    // back the variable's value at this moment would freeze `null` into the handle forever.
    get ollamaModels() {
      return ollamaModels;
    },
    close() {
      store.close();
    },
  };
}