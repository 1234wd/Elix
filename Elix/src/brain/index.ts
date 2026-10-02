/**
 * Wire up the brain router from config + environment (B2).
 *
 * Builds providers only for keys that are present, so a missing key means that
 * provider is simply absent from the preference walk rather than a 401 at call
 * time.
 */
import { GroqProvider } from "./groq.js";
import { HuggingFaceProvider } from "./hf.js";
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
  idleChatterBudgetPerHour?: number;
}

export interface BrainHandle {
  router: BrainRouter;
  store: BrainStore;
  providers: Partial<Record<ProviderName, ProviderAdapter>>;
  close(): void;
}

export function buildBrain(opts: BuildBrainOptions): BrainHandle {
  const env = opts.env ?? process.env;
  const providers: Partial<Record<ProviderName, ProviderAdapter>> = {};
  const groqKey = env["GROQ_API_KEY"]?.trim();
  const hfKey = env["HF_TOKEN"]?.trim();

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
  // `builtin` needs no provider: the router synthesises scripted lines.

  const store = opts.store ?? new BrainStore(defaultDbPath(opts.projectRoot));

  const router = new BrainRouter({
    models: opts.models,
    providers,
    store,
    fastMaxTokens: opts.fastMaxTokens ?? opts.config?.brain.fastMaxTokens,
    smartMaxTokens: opts.smartMaxTokens ?? opts.config?.brain.smartMaxTokens,
    idleChatterBudgetPerHour:
      opts.idleChatterBudgetPerHour ?? opts.config?.brain.idleChatterBudgetPerHour,
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.random ? { random: opts.random } : {}),
  });

  return {
    router,
    store,
    providers,
    close() {
      store.close();
    },
  };
}