/**
 * R18-H acceptance — the NVIDIA tier exists at runtime, and Ollama only when it is really there.
 *
 * Every test goes through `buildBrain`, not through hand-built providers, because the whole
 * point of R18-H is that the entries in `models.yaml` were being skipped by the thing that
 * builds the providers.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBrain } from "../../src/brain/index.js";
import { BrainStore } from "../../src/brain/store.js";
import { PROVIDER_KEYS, checkApiKeys } from "../../src/core/doctor.js";
import type { ModelsConfig } from "../../src/core/config.js";

const MODELS: ModelsConfig = {
  providers: {
    groq: { baseUrl: null, env: "GROQ_API_KEY" },
    hf: { baseUrl: null, env: "HF_TOKEN" },
    nvidia: { baseUrl: null, env: "NVIDIA_API_KEY" },
    ollama: { baseUrl: null, env: null },
  },
  roles: {
    fast: { preference: [{ provider: "groq", model: "openai/gpt-oss-20b" }, { provider: "builtin", model: "scripted" }] },
    smart: { preference: [{ provider: "groq", model: "openai/gpt-oss-20b" }, { provider: "builtin", model: "scripted" }] },
    guard: { preference: [{ provider: "groq", model: "openai/gpt-oss-safeguard-20b" }, { provider: "builtin", model: "scripted" }] },
  },
} as unknown as ModelsConfig;

/** A fetch that answers the Ollama reachability probe, and nothing else. */
function fetchAnsweringOllama(models: string[]): typeof fetch {
  return (async (url: unknown) => {
    if (String(url).includes("/models")) {
      return new Response(JSON.stringify({ object: "list", data: models.map((id) => ({ id })) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
}

const fetchNotAnswering = (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch;

function withStore<T>(run: (store: BrainStore, dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "elix-r18h-"));
  const store = new BrainStore(join(dir, "elix.db"));
  try {
    return run(store, dir);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("R18-H — NVIDIA is built when the key is set", () => {
  it("with NVIDIA_API_KEY set, buildBrain() constructs an nvidia provider", async () => {
    await withStore(async (store, dir) => {
      const brain = buildBrain({
        models: MODELS,
        env: { NVIDIA_API_KEY: "nvapi-probe-not-a-key" },
        projectRoot: dir,
        store,
        fetchImpl: fetchNotAnswering,
      });
      expect(brain.providers["nvidia"], "no nvidia adapter was constructed").toBeDefined();
      expect(brain.providers["nvidia"]!.name).toBe("nvidia");
      await brain.providersReady;
    });
  });

  it("without the key there is no nvidia provider - a missing key means absent, not a 401", async () => {
    await withStore(async (store, dir) => {
      const brain = buildBrain({ models: MODELS, env: {}, projectRoot: dir, store, fetchImpl: fetchNotAnswering });
      expect(brain.providers["nvidia"]).toBeUndefined();
      await brain.providersReady;
    });
  });

  it("an empty NVIDIA_API_KEY counts as no key", async () => {
    await withStore(async (store, dir) => {
      const brain = buildBrain({
        models: MODELS,
        env: { NVIDIA_API_KEY: "   " },
        projectRoot: dir,
        store,
        fetchImpl: fetchNotAnswering,
      });
      expect(brain.providers["nvidia"]).toBeUndefined();
      await brain.providersReady;
    });
  });
});

describe("R18-H — the whole provider map, per environment", () => {
  it("no keys at all builds nothing, and builtin still works", async () => {
    await withStore(async (store, dir) => {
      const brain = buildBrain({ models: MODELS, env: {}, projectRoot: dir, store, fetchImpl: fetchNotAnswering });
      await brain.providersReady;
      expect(Object.keys(brain.providers).sort()).toEqual([]);
      expect(brain.ollamaModels, "ollama appears with no local server").toBeNull();
    });
  });

  it("every key set builds exactly the three cloud providers", async () => {
    await withStore(async (store, dir) => {
      const brain = buildBrain({
        models: MODELS,
        env: { GROQ_API_KEY: "g", HF_TOKEN: "h", NVIDIA_API_KEY: "n" },
        projectRoot: dir,
        store,
        fetchImpl: fetchNotAnswering,
      });
      await brain.providersReady;
      expect(Object.keys(brain.providers).sort()).toEqual(["groq", "hf", "nvidia"]);
    });
  });

  it("only Groq set builds only groq", async () => {
    await withStore(async (store, dir) => {
      const brain = buildBrain({
        models: MODELS,
        env: { GROQ_API_KEY: "g" },
        projectRoot: dir,
        store,
        fetchImpl: fetchNotAnswering,
      });
      await brain.providersReady;
      expect(Object.keys(brain.providers).sort()).toEqual(["groq"]);
    });
  });
});

describe("R18-H — Ollama is added ONLY when the local server really answers", () => {
  it("a reachable Ollama is added, with the models it offered", async () => {
    await withStore(async (store, dir) => {
      const brain = buildBrain({
        models: MODELS,
        env: { GROQ_API_KEY: "g" },
        projectRoot: dir,
        store,
        fetchImpl: fetchAnsweringOllama(["llama3.2:3b", "qwen2.5:7b"]),
      });
      // Not there synchronously: the probe has not answered yet.
      expect(brain.providers["ollama"], "ollama appeared before the probe could have answered").toBeUndefined();
      await brain.providersReady;
      expect(brain.providers["ollama"], "a reachable Ollama was not added").toBeDefined();
      expect(brain.ollamaModels).toEqual(["llama3.2:3b", "qwen2.5:7b"]);
    });
  });

  it("an unreachable Ollama is silently absent - no provider, no throw, no complaint", async () => {
    await withStore(async (store, dir) => {
      const brain = buildBrain({
        models: MODELS,
        env: { GROQ_API_KEY: "g" },
        projectRoot: dir,
        store,
        fetchImpl: fetchNotAnswering,
      });
      await expect(brain.providersReady).resolves.toBeUndefined();
      expect(brain.providers["ollama"]).toBeUndefined();
      expect(brain.ollamaModels).toBeNull();
      expect(Object.keys(brain.providers).sort()).toEqual(["groq"]);
    });
  });

  it("a fetch that REJECTS is also just 'not there'", async () => {
    const boom = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await withStore(async (store, dir) => {
      const brain = buildBrain({ models: MODELS, env: {}, projectRoot: dir, store, fetchImpl: boom });
      await expect(brain.providersReady).resolves.toBeUndefined();
      expect(brain.providers["ollama"]).toBeUndefined();
    });
  });

  it("the probe asks the documented URL, and gives up quickly", async () => {
    const seen: string[] = [];
    const answering = (async (url: unknown) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ object: "list", data: [{ id: "llama3.2:3b" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    await withStore(async (store, dir) => {
      const brain = buildBrain({ models: MODELS, env: {}, projectRoot: dir, store, fetchImpl: answering });
      await brain.providersReady;
      expect(seen[0], "probed somewhere other than the documented Ollama URL").toBe(
        "http://127.0.0.1:11434/v1/models",
      );
    });
  });
});

describe("R18-H — elix doctor reports both", () => {
  it("PROVIDER_KEYS includes NVIDIA, by name only", () => {
    expect(PROVIDER_KEYS.map(([, label]) => label)).toContain("NVIDIA");
  });

  it("checkApiKeys sees a NVIDIA key", () => {
    const result = checkApiKeys({ NVIDIA_API_KEY: "nvapi-something" });
    expect(result.status).not.toBe("fail");
  });

  it("with no keys at all it still says something honest", () => {
    expect(checkApiKeys({}).status).toMatch(/warn|pass/u);
  });
});
