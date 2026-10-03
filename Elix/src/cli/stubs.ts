import type { Command } from "commander";
import { join } from "node:path";
import type { ElixConfig } from "../core/config.js";
import { getActiveProfile, loadModelsConfig, PROJECT_ROOT } from "../core/config.js";
import { currentBot, runBot } from "../connection/bot.js";
import { Lifecycle } from "../core/lifecycle.js";
import { exitCleanly } from "../core/exit.js";
import { bus } from "../core/events.js";
import { buildBrain, type BrainHandle } from "../brain/index.js";
import { ChatBridge, type MemoryHook } from "../brain/bridge.js";
import { MemoryStore, defaultMemoryPath } from "../memory/store.js";
import { MemoryEngine } from "../memory/engine.js";
import { HuggingFaceProvider } from "../brain/hf.js";
import { WorldRecorder } from "../memory/recorder.js";
import { QueryEmbedder } from "../memory/queryEmbed.js";
import { NightlyScheduler } from "../memory/scheduler.js";
import { runMemoryShutdown } from "../memory/shutdown.js";
import type { Logger } from "../core/logger.js";

/**
 * A3: the fallback embedding model, used ONLY when the `embeddings` role cannot be
 * resolved.
 *
 * This used to be a hard-coded constant the memory engine and the query embedder
 * both took directly, while the router independently resolved the `embeddings`
 * ROLE — and got a different answer, because Hugging Face's /v1/models does not
 * list feature-extraction pipelines. Two sources of truth that disagreed: doctor
 * said `builtin/fts5-keyword-only` while the memory engine was calling HF with
 * this exact id, successfully.
 *
 * The role is now the single source, with this as the documented floor. It stays
 * a constant because vector dimensions can never be mixed: a different model
 * means a different dimension, and those spaces are not comparable.
 */
const FALLBACK_EMBEDDING_MODEL = "BAAI/bge-small-en-v1.5";

/**
 * A3: does this feature-extraction endpoint answer?
 *
 * One short text, one vector, on the doctor's 10 s probe budget. Returns false
 * rather than throwing: an unreachable pipeline must leave memory on FTS5, never
 * stop Elix joining the server.
 */
async function probeEmbeddings(model: string, log: Logger): Promise<boolean> {
  const token = process.env["HF_TOKEN"]?.trim();
  if (!token) return false;
  try {
    const provider = new HuggingFaceProvider({ apiKey: token });
    const vectors = await provider.embed(["elix"], model, AbortSignal.timeout(10_000));
    return vectors[0] !== undefined && vectors[0].length > 0;
  } catch (err) {
    log.debug({ err: (err as Error).message, model }, "embedding probe failed");
    return false;
  }
}

/** Where backups live, alongside the database. */
function backupDir(projectRoot: string): string {
  return join(projectRoot, "data", "backups");
}

/**
 * A1: is there any provider key at all?
 *
 * Consolidation is a model call. With no key there is nothing to call, and
 * attempting it wastes the shutdown budget before discovering the model
 * resolution failed.
 */
function hasModelKey(): boolean {
  return Boolean(process.env["GROQ_API_KEY"]?.trim() || process.env["HF_TOKEN"]?.trim());
}

/**
 * Open the memory store and wire it into the bridge.
 *
 * Returns null when the database cannot be opened, because a bot that cannot
 * remember is still a bot that can talk (vision rule 3, "never silent").
 *
 * A3: this is where the query embedder is created. `context` used to be handed
 * `null` for the query vector, so cosine was always 0 and live retrieval was
 * FTS-only while HF credit was spent embedding every episode — the vectors were
 * paid for and never read.
 */
function openMemory(
  brain: BrainHandle | undefined,
  log: Logger,
  /** A3: the model the router resolved for the `embeddings` role. */
  embeddingModel: string,
): {
  store: MemoryStore;
  engine: MemoryEngine;
  hook: MemoryHook;
  recorder: WorldRecorder;
  queryEmbedder: QueryEmbedder;
  storePath: string;
} | null {
  const storePath = defaultMemoryPath(PROJECT_ROOT);
  try {
    const store = new MemoryStore({ path: storePath });
    const vec = store.loadVec();
    if (!vec.loaded) {
      log.info({ error: vec.error }, "vector search unavailable — FTS5 keyword search only");
    }
    const hfKey = process.env["HF_TOKEN"]?.trim();
    const provider = hfKey ? new HuggingFaceProvider({ apiKey: hfKey }) : null;
    // A cooldown is not "no key": skip the request, keep the memory.
    const hfAvailable = (): boolean => {
      if (!provider) return false;
      return brain?.router?.isProviderUsable?.("hf") ?? true;
    };
    const engine = new MemoryEngine({
      store,
      embeddingProvider: provider,
      embeddingModel,
      ...(provider ? { embedAvailable: hfAvailable } : {}),
    });
    const queryEmbedder = new QueryEmbedder({
      provider,
      model: embeddingModel,
      isAvailable: hfAvailable,
      onError: (m) => log.debug({ err: m }, "query embedding failed — using FTS5"),
    });
    const recorder = new WorldRecorder({ store, log, selfName: "Elix" });

    const hook: MemoryHook = {
      record: (input) =>
        engine.record({
          text: input.text,
          speaker: input.speaker,
          player: input.player ?? null,
          kind: (input.kind as never) ?? "chat",
          meta: input.meta ?? null,
        }).id,
      // A3: embed the question first, on a 1.5 s budget. A null vector is normal
      // and simply means the search falls back to keywords.
      context: async (player, query) => {
        const vector = await queryEmbedder.embed(query);
        return engine.context(player, query, vector);
      },
      preference: (player, kind) => engine.preference(player, kind),
      capturePreference: (player, text) => engine.capturePreference(player, text),
    };
    return { store, engine, hook, recorder, queryEmbedder, storePath };
  } catch (err) {
    log.warn({ err: (err as Error).message }, "memory unavailable — Elix will not remember");
    return null;
  }
}

/**
 * Phase-2 start command — connects Elix to the server.
 * Later phases add the brain, memory, social, etc.
 */

function phaseStub(phase: number, feature: string) {
  return () => {
    console.log(`${feature} lands in phase ${phase}.`);
    console.log("See README.md for the build plan. Nothing is faked here.");
  };
}

export function registerStubs(program: Command): void {
  program
    .command("setup")
    .description("First-run wizard: keys, username, server, voice, models")
    .action(phaseStub(5, "The setup wizard"));

  program
    .command("start")
    .description("Connect Elix to a server and start playing")
    .option("--host <host>", "server host")
    .option("--port <port>", "server port", (v) => Number.parseInt(v, 10))
    .option("--username <name>", "in-game username")
    .option("--version <ver>", "target server version (e.g. 26.2)")
    .option("--profile <name>", "saved server profile")
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const config = cmd.optsWithGlobals().elixConfig as ElixConfig;
      const log = cmd.optsWithGlobals().elixLogger as Logger;

      // All three flags are wired through (A10): --profile, --username, --version.
      const profile = getActiveProfile(config, {
        host: opts.host as string | undefined,
        port: opts.port as number | undefined,
        version: opts.version as string | undefined,
        username: opts.username as string | undefined,
        profile: opts.profile as string | undefined,
      });

      if (opts.username !== undefined && !/^[A-Za-z0-9_]{3,16}$/.test(profile.username)) {
        console.error(
          `username "${profile.username}" is not valid — Minecraft requires 3-16 characters from A-Z, a-z, 0-9 and _`,
        );
        exitCleanly(1);
        return;
      }

      // Vision rule 8: only join servers the user explicitly allowlisted.
      if (
        config.bot.serverAllowlist.length > 0 &&
        !config.bot.serverAllowlist.includes(profile.host)
      ) {
        console.error(
          `server ${profile.host} is not in the allowlist — add it to config/elix.yaml bot.serverAllowlist`,
        );
        exitCleanly(1);
        return;
      }

      const lifecycle = new Lifecycle(log);
      // Signal handlers go up before connecting, so Ctrl+C during ping/login is clean (A15).
      lifecycle.handleSignals();

      // A2: a permanent disconnect and a crash burst both shut down through the
      // Lifecycle with a specific exit code, so every registered cleanup runs —
      // including the brain close and, in Phase 4, the shutdown backup.
      const requestShutdown = (reason: string, code: number): void => {
        void lifecycle.shutdown(reason, code);
      };

      // B7/B9: build the brain and the in-game chat bridge. A missing key is
      // not an error — that provider is simply absent and the router falls
      // through to the next one.
      const brainAbort = new AbortController();
      let chatBridge: ChatBridge | undefined;
      let brain: BrainHandle | undefined;
      try {
        const models = await loadModelsConfig();
        const embeddingCandidate =
          models.roles.embeddings.preference[0]?.model ?? FALLBACK_EMBEDDING_MODEL;
        brain = buildBrain({
          models,
          config: config,
          projectRoot: PROJECT_ROOT,
          // A3: the embeddings role is NOT a chat model, so /v1/models cannot
          // answer whether it exists — HF lists only chat/inference models there,
          // never feature-extraction pipelines, which is why the role resolved to
          // the scripted builtin while the very same model worked when the memory
          // engine called it directly. Probe the endpoint that will actually be
          // used instead.
          availabilityChecks: {
            [`hf/${embeddingCandidate}`]: () => probeEmbeddings(embeddingCandidate, log),
          },
        });
        chatBridge = new ChatBridge({
          router: brain.router,
          username: profile.username,
          log,
          signal: brainAbort.signal,
        });

        // A1: the brain's SQLite store must live as long as the PROCESS.
        //
        // It used to be closed in a `finally` right after `await runBot(...)`,
        // but runBot returns as soon as the bot is created — seconds after
        // launch, not when Elix leaves. Every later router call then threw
        // "database is not open" and every in-game reply failed.
        //
        // Lifecycle cleanups run in reverse registration order, so registering
        // this BEFORE runBot's own cleanup makes the store close LAST, after
        // the goodbye message has been sent.
        lifecycle.onCleanup(() => {
          brainAbort.abort();
          brain?.close();
        });

        // A2: model discovery runs in the BACKGROUND. Startup used to await
        // resolveRoles() here, so a hung /models could stop Elix joining the
        // server at all. resolveRoles() inside complete() still resolves on
        // first use, with a 5 s timeout.
        brain.router.warmModelCache(brainAbort.signal);
        void brain.router.resolveRoles(brainAbort.signal).then(
          (resolutions) => {
            for (const r of resolutions) {
              log.info(
                {
                  role: r.role,
                  model: r.chosen ? `${r.chosen.provider}/${r.chosen.model}` : "builtin",
                },
                "role resolved",
              );
            }
          },
          () => {
            /* logged inside the router; never blocks startup */
          },
        );
      } catch (err) {
        // A brain failure must never stop Elix from playing (vision rule 3).
        log.warn(
          { err: (err as Error).message },
          "brain unavailable — playing without AI replies",
        );
        brain?.close();
        brain = undefined;
        chatBridge = undefined;
      }

      // B7: Ctrl+C aborts in-flight provider calls immediately, so shutdown
      // never waits on the network.
      bus.on("shutdown", () => brainAbort.abort());

      // D6/D7: memory. Opened here, wired into the bridge, and closed in the
      // brain cleanup — which runs LAST, after the shutdown backup and
      // consolidation, because Lifecycle reverses cleanup order (A1).
      // A3: take the embedding model from the RESOLVED role, so the memory
      // engine and the router can never disagree about it.
      const embeddingModel =
        brain?.router.resolutionFor("embeddings")?.chosen?.model ?? FALLBACK_EMBEDDING_MODEL;
      log.info({ embeddingModel }, "memory embedding model");
      const memory = openMemory(brain, log, embeddingModel);
      if (memory) {
        chatBridge?.setMemory(memory.hook);
        chatBridge?.setRecorder(memory.recorder);
        // A6: joins, leaves, deaths and kicks are recorded from the bus.
        memory.recorder.attach();

        // A2: the nightly sleep, the nightly backup and the periodic embedding
        // drain. Before this, all three only ran at startup and on shutdown, so
        // "nightly" was documentation with no code behind it.
        const scheduler = new NightlyScheduler({
          store: memory.store,
          engine: memory.engine,
          router: brain?.router ?? null,
          storePath: memory.storePath,
          backupDir: backupDir(PROJECT_ROOT),
          hasModel: hasModelKey(),
          log,
          // mineflayer's in-game clock. 0 when unknown, which simply never
          // triggers the night.
          timeOfDay: () => currentBot()?.time?.timeOfDay ?? 0,
        });
        scheduler.start();

        // A1: ONE cleanup that does the whole shutdown in the right order, with
        // a budget on each step. Registered before runBot's cleanup so it runs
        // AFTER the goodbye, and it closes the store itself so nothing races it.
        lifecycle.onCleanup(async () => {
          scheduler.stop();
          memory.recorder.detachAll();
          await runMemoryShutdown({
            store: memory.store,
            engine: memory.engine,
            storePath: memory.storePath,
            backupDir: backupDir(PROJECT_ROOT),
            router: brain?.router ?? null,
            hasModel: hasModelKey(),
            log,
            // A1: the user can see WHY the process is still running.
            onProgress: (line) => console.log(line),
          });
        });

        // Background embedding at startup, so a busy chat never waits on a provider.
        void memory.engine.embedder.drain(2).then((r) => {
          if (r.embedded > 0) log.info(r, "embedded new memories");
        });
      }

      try {
        // runBot registers its own cleanup synchronously (before the first await
        // of the network work), so a Ctrl+C during ping still unwinds properly.
        await runBot({
          config,
          profile,
          log,
          registerCleanup: (fn) => void lifecycle.onCleanup(fn),
          ...(chatBridge ? { chatBridge } : {}),
          requestShutdown,
        });
        // runBot has resolved but Elix is STILL PLAYING. Nothing may close the
        // brain here — the lifecycle cleanup registered above owns that.
        //
        // A1: this now resolves AFTER every cleanup has finished, so the
        // `finally` below runs last. It used to resolve when shutdown began,
        // which let this block close the database in parallel with the cleanups
        // that need it open.
        await lifecycle.waitForShutdown();
      } catch (err) {
        log.error({ err: (err as Error).message }, "failed to start");
        exitCleanly(1);
      } finally {
        // Safety net for a failure before the cleanup could register.
        brainAbort.abort();
        brain?.close();
      }
    });

  program
    .command("status")
    .description("Show current config summary")
    .action((_opts: unknown, cmd: Command) => {
      const config = cmd.optsWithGlobals().elixConfig as ElixConfig;
      const profile = getActiveProfile(config);
      console.log("Elix status");
      console.log(`  username:       ${config.bot.username}`);
      // A4: print the version actually resolved for THIS profile, not bot.version.
      console.log(`  target version: ${profile.version}`);
      console.log(`  profile:        ${profile.name} (${profile.host}:${profile.port})`);
      console.log(`  voice:          ${config.voice.enabled ? "on" : "off (text-only)"}`);
      console.log(`  content level:  ${config.safety.contentLevel}`);
      console.log(`  chat rate:      ${config.safety.chatRateLimitPer2s} per 2s`);
      console.log(`  data dir:       ${config.dataDir}`);
      console.log(`  log level:      ${config.logLevel}`);
    });

  // `usage` and `ask` are real now (Phase 3) — registered in cli/brain.ts.

  // `memory search`, `memory stats` and `forget` are real now (Phase 4, D8) —
  // registered in cli/memory.ts, which also owns the top-level `forget` alias.

  const kb = program.command("kb").description("Minecraft knowledge base");
  kb.command("build")
    .description("Build the offline wiki knowledge base")
    .action(phaseStub(8, "Knowledge base build"));
}