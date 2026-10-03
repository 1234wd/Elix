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
  /**
   * A3: a gate consulted before every embedding request, so a provider in a
   * cooldown is skipped rather than called every two minutes.
   */
  embedAvailable?: () => boolean;
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

/**
 * A5: "my favourite block is <value>", where the value stops at the first clause
 * break.
 *
 * The lazy `.+?` plus the lookahead is the whole trick: the engine grows the
 * capture one character at a time until a break is in front of it, so
 *
 *   my favourite block is cherry planks and i love it   -> "cherry planks"
 *   my favourite block is cherry planks, it's nice      -> "cherry planks"
 *   my favourite block is cherry planks. full stop      -> "cherry planks"
 *   my favourite block is cherry planks                 -> "cherry planks"
 *
 * A pattern like `([\w\s'-]{2,40})` has no stopping condition at all and stores
 * the entire sentence, which is exactly what happened.
 */
const PREFERENCE_PATTERN =
  /\bmy\s+favou?rite\s+(\w+)\s+is\s+(.+?)(?=\s+(?:and|but|so|because|then|though|although)\b|[,.!?;]|$)/i;

/** Trim, lowercase, and drop a trailing filler word the regex cannot see past. */
function cleanPreferenceValue(raw: string): string {
  let v = raw.trim().toLowerCase();
  // The lookahead stops before these, but a value may END with one.
  v = v.replace(/\s+(?:and|but|so|lol|lmao|because|then)\s*$/i, "").trim();
  // A leading article reads badly as a stored value.
  v = v.replace(/^(?:the|a|an)\s+/, "").trim();
  return v;
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
      ...(opts.embedAvailable ? { isAvailable: opts.embedAvailable } : {}),
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
        this.store.bumpRelation(player, { familiarity: 0.02, affection: 0.005, trust: 0.005 }, ts);
      }
    }

    // D7: an Elix line that commits to something is a promise.
    //
    // A7: the REDACTED text, not the raw input. Promises were recorded straight
    // from `input.text`, which is the one string in this file that never passes
    // through redactPersonalInfo — so a promise could store the phone number or
    // address that the episode beside it had already had removed. D4 is not an
    // episode-level rule.
    let promiseId: number | undefined;
    if (input.speaker === "elix" && player) {
      const p = this.promises.record(text, player, id);
      if (p) promiseId = p.id;
    }

    return { id, importance: scoreImportance({ kind, text, speaker: input.speaker, player, isFirstMeeting }), redacted, ...(promiseId ? { promiseId } : {}) };
  }

  /**
   * The memory block for a chat prompt.
   *
   * Never throws. A retrieval failure yields an empty block, because a reply
   * without memory beats no reply.
   *
   * A4: `excludeIds` carries the ids written by THIS turn. The bridge retrieves
   * before it records, so its own question is not in the index yet — but the
   * exclusion is belt and braces, and it is what makes the ordering not matter.
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

  /**
   * Pull a preference out of raw chat, so it works before any consolidation.
   *
   * A5, two bugs in one place:
   *
   *  - The old pattern `([\w\s'-]{2,40})` had NO stopping condition, so
   *    "my favourite block is cherry planks and i love it" stored the whole
   *    sentence as the value. The value now ends at the first clause break.
   *  - The old code ADDED to `people.preferences` with a Set, so changing a
   *    preference left every previous one behind and `preference()` returned
   *    whichever sorted first — the STALE one. A kind now holds exactly ONE
   *    live value, and the old value stays in `facts` linked forward, which is
   *    where the history belongs.
   */
  capturePreference(player: string, text: string): string | null {
    const m = PREFERENCE_PATTERN.exec(text);
    if (!m) return null;
    const kind = (m[1] ?? "").toLowerCase();
    const value = cleanPreferenceValue(m[2] ?? "");
    if (value.length === 0) return null;
    const person = this.store.person(player);
    const prefs = new Map<string, string>();
    for (const pref of person?.preferences ?? []) {
      const sep = pref.indexOf(": ");
      if (sep > 0) prefs.set(pref.slice(0, sep), pref.slice(sep + 2));
    }
    // REPLACE, never add: one live value per kind.
    prefs.set(kind, value);
    this.store.setPersonJson(player, "preferences", [...prefs].map(([k, v]) => `${k}: ${v}`));
    // Also a fact, so retrieval finds it as a memory too. addFact() links any
    // previous value for this subject+predicate forward instead of erasing it.
    this.store.addFact({
      ts: this.now(),
      subject: player,
      predicate: `favourite ${kind}`,
      object: value,
      confidence: 0.9,
    });
    return value;
  }

  /**
   * Read back a stored preference by kind.
   *
   * A5: the latest LIVE FACT wins, because it is the only one carrying a
   * timestamp and supersession history. The profile list is the fallback for a
   * kind that was only ever written there.
   */
  preference(player: string, kind: string): string | null {
    const wanted = kind.toLowerCase();
    const predicate = `favourite ${wanted}`;
    // factsFor() already filters superseded and expired rows, oldest first.
    const facts = this.store.factsFor(player, 200).filter((f) => f.predicate === predicate);
    if (facts.length > 0) return facts[facts.length - 1]!.object;
    for (const pref of this.store.person(player)?.preferences ?? []) {
      const sep = pref.indexOf(": ");
      if (sep > 0 && pref.slice(0, sep) === wanted) return pref.slice(sep + 2);
    }
    return null;
  }

  /** Episodes the backfill still owes, for `elix memory stats`. */
  get unembeddedCount(): number {
    return this.store.countUnembedded();
  }

  /**
   * A1: whether an embedding call is even possible.
   *
   * The shutdown sequence uses this to skip the drain instead of spending its
   * remaining budget discovering there is no HF key.
   */
  get hasEmbeddings(): boolean {
    return this.embedder.canEmbed;
  }

  get embeddingModelName(): string {
    return this.embeddingModel;
  }
}

export type { Episode };
