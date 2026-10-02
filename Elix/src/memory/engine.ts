/**
 * The memory engine (D7): everything the chat bridge needs, in one object.
 *
 *   record(...)   every chat line and every Elix reply becomes an episode
 *   context(...)  the memory block for a prompt, quoted as data
 *
 * Written and read separately on purpose. `record` never fails a reply, and
 * `context` never blocks chat: if retrieval throws, the prompt is built with no
 * memory rather than no reply.
 */
import type { MemoryStore, Episode, Speaker, EpisodeKind } from "./store.js";
import { Memory, type RetrievalOptions } from "./retrieval.js";
import { Embedder } from "./embedder.js";
import { Promises } from "./promises.js";
import { scoreImportance, redactPersonalInfo } from "./importance.js";
import type { HuggingFaceProvider } from "../brain/hf.js";

export interface MemoryEngineOptions {
  store: MemoryStore;
  embeddingProvider: HuggingFaceProvider | null;
  embeddingModel: string;
  now?: () => number;
}

export interface RecordInput {
  text: string;
  speaker: Speaker;
  player?: string | null;
  kind?: EpisodeKind;
  meta?: string | null;
  x?: number | null;
  y?: number | null;
  z?: number | null;
  dimension?: string | null;
  server?: string | null;
  emotion?: string | null;
}

export interface RecordResult {
  id: number;
  importance: number;
  redacted: boolean;
  /** Set when a promise was detected in Elix's own line. */
  promiseId?: number;
}

export class MemoryEngine {
  readonly store: MemoryStore;
  readonly memory: Memory;
  readonly embedder: Embedder;
  readonly promises: Promises;
  private readonly now: () => number;
  private readonly embeddingModel: string;

  constructor(opts: MemoryEngineOptions) {
    this.store = opts.store;
    this.now = opts.now ?? Date.now;
    this.embeddingModel = opts.embeddingModel;
    this.memory = new Memory(opts.store);
    this.embedder = new Embedder({
      store: opts.store,
      provider: opts.embeddingProvider,
      model: opts.embeddingModel,
    });
    this.promises = new Promises(opts.store, this.now);
  }

  /**
   * Store one thing that happened.
   *
   * D4: personal info is redacted BEFORE storage, so a phone number or address
   * never reaches disk, the vector index, or a cloud prompt.
   */
  record(input: RecordInput): RecordResult {
    const ts = this.now();
    const player = input.player ?? null;
    const isFirstMeeting =
      player !== null && this.store.person(player) === null;

    const { text, redacted } = redactPersonalInfo(input.text);
    const kind = input.kind ?? "chat";

    const id = this.store.addEpisode({
      ts,
      kind,
      player,
      speaker: input.speaker,
      text,
      meta: input.meta ?? null,
      importance: scoreImportance({
        kind,
        text,
        speaker: input.speaker,
        player,
        isFirstMeeting,
      }),
      x: input.x ?? null,
      y: input.y ?? null,
      z: input.z ?? null,
      dimension: input.dimension ?? null,
      server: input.server ?? null,
      emotion: input.emotion ?? null,
      redacted,
    });

    if (player) {
      this.store.touchPerson(player, ts);
      // Direct chat with Elix builds familiarity faster than silence does.
      if (kind === "chat") {
        this.store.bumpRelation(player, { familiarity: 0.02, affection: 0.005, trust: 0.005 });
      }
    }

    // D7: an Elix line that commits to something is a promise.
    let promiseId: number | undefined;
    if (input.speaker === "elix" && player) {
      const p = this.promises.record(input.text, player, id);
      if (p) promiseId = p.id;
    }

    return { id, importance: scoreImportance({ kind, text, speaker: input.speaker, player, isFirstMeeting }), redacted, ...(promiseId ? { promiseId } : {}) };
  }

  /**
   * The memory block for a chat prompt.
   *
   * Never throws. A retrieval failure yields an empty block, because a reply
   * without memory beats no reply.
   */
  context(
    player: string,
    query: string,
    queryVector: number[] | null,
    opts: RetrievalOptions = {},
  ): string {
    try {
      return this.memory.buildContext(player, query, queryVector, opts).block;
    } catch {
      return "";
    }
  }

  /**
   * Facts about a player, for a direct question like "what's my favourite block".
   *
   * This is what makes the D7 live proof work: the fact was written by
   * consolidation, or captured directly, and survives a restart because it is in
   * SQLite rather than in a prompt.
   */
  factsAbout(player: string): string[] {
    return this.memory.safeFacts(player, 20).map((f) => f.object);
  }

  /** Pull a preference out of raw chat, so it works before any consolidation. */
  capturePreference(player: string, text: string): string | null {
    const m =
      /\bmy\s+favou?rite\s+(\w+)\s+is\s+([\w\s'-]{2,40})/i.exec(text);
    if (!m) return null;
    const kind = (m[1] ?? "").toLowerCase();
    const value = (m[2] ?? "").trim().toLowerCase();
    if (value.length === 0) return null;
    const person = this.store.person(player);
    const prefs = new Set(person?.preferences ?? []);
    prefs.add(`${kind}: ${value}`);
    this.store.setPersonJson(player, "preferences", [...prefs]);
    // Also a fact, so retrieval finds it as a memory too.
    this.store.addFact({
      ts: this.now(),
      subject: player,
      predicate: `favourite ${kind}`,
      object: value,
      confidence: 0.9,
    });
    return value;
  }

  /** Read back a stored preference by kind. */
  preference(player: string, kind: string): string | null {
    const wanted = kind.toLowerCase();
    for (const pref of this.store.person(player)?.preferences ?? []) {
      const [k, v] = pref.split(": ");
      if (k === wanted) return v ?? null;
    }
    for (const f of this.store.factsFor(player, 50)) {
      if (f.predicate === `favourite ${wanted}`) return f.object;
    }
    return null;
  }

  /** Episodes the backfill still owes, for `elix memory stats`. */
  get unembeddedCount(): number {
    return this.store.countUnembedded();
  }

  get embeddingModelName(): string {
    return this.embeddingModel;
  }
}

export type { Episode };
