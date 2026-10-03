/**
 * Consolidation ("sleep") — D5.
 *
 * Each in-game night and on shutdown, the `smart` model turns raw episodes into
 * facts, updates people profiles, and writes a diary entry in Elix's own voice.
 *
 * The hard part is that a busy day does not fit in one 4K prompt. So:
 *   chunk -> summarise each chunk -> merge
 * with a hard cap of 5 calls per night plus 1 on shutdown. Hitting the cap is
 * not an error: the remaining episodes wait for the next night and a line is
 * logged saying so.
 *
 * Output must be strict JSON validated with zod. Invalid JSON means NO writes
 * and exactly one retry — a second invalid response is a provider problem, not
 * something to keep retrying.
 */
import { z } from "zod";
import type { MemoryStore, Episode } from "./store.js";
import type { BrainRouter } from "../brain/router.js";
import { scoreImportance } from "./importance.js";

/** Calls per night, plus one for shutdown. */
export const NIGHT_CALL_CAP = 5;
export const SHUTDOWN_CALL_CAP = 1;

/** Episodes per summarise call. Small enough that 4K tokens covers it. */
export const CHUNK_SIZE = 25;

const factSchema = z.object({
  subject: z.string().min(1).max(40),
  predicate: z.string().min(1).max(40),
  object: z.string().min(1).max(200),
  confidence: z.number().min(0).max(1),
});

const chunkSummarySchema = z.object({
  facts: z.array(factSchema).max(8),
  diaryNote: z.string().max(400).optional(),
});

const mergeSchema = z.object({
  facts: z.array(factSchema).max(20),
  diary: z.string().max(1200),
  importanceAdjust: z
    .array(z.object({ episode: z.number().int(), importance: z.number().min(0).max(10) }))
    .max(30)
    .optional(),
});

export type ChunkSummary = z.infer<typeof chunkSummarySchema>;
export type MergedSummary = z.infer<typeof mergeSchema>;

const CHUNK_SYSTEM = `You turn a day of Minecraft chat into durable facts.

Rules:
- Only record a fact if the log states it. Never guess or invent.
- Keep each object's wording as the player said it, lowercased, under 200 characters.
- Skip small talk, greetings and anything that is not a lasting fact.
- Reply with ONLY a JSON object, no prose and no code fence:
  {"facts":[{"subject":"...","predicate":"...","object":"...","confidence":0.0-1.0}],"diaryNote":"one short sentence in Elix's voice about this stretch, lowercase"}
- If there are no facts, reply {"facts":[],"diaryNote":"..."}`;

const MERGE_SYSTEM = `You combine several partial summaries of one day into one.

Rules:
- Keep only facts that are actually supported. Drop duplicates and contradictions,
  keeping the most recent version of a changed fact.
- diary is Elix's own diary entry for the day, in first person, lowercase, 2-4
  sentences, warm and honest. Never claim real feelings; write what happened.
- Reply with ONLY a JSON object, no prose and no code fence:
  {"facts":[...],"diary":"...","importanceAdjust":[{"episode":123,"importance":7}]}`;

export interface ConsolidationResult {
  ok: boolean;
  episodesConsidered: number;
  chunks: number;
  calls: number;
  factsMade: number;
  diary: string | null;
  /** Set when the call cap was hit; the rest waits for the next night. */
  deferred: number;
  /** A2: the highest episode id summarised, i.e. the new watermark. 0 if none. */
  watermark: number;
  status: "ok" | "capped" | "invalid-json" | "no-episodes" | "no-model" | "error";
  error?: string;
}

export interface ConsolidatorOptions {
  store: MemoryStore;
  router: BrainRouter;
  /** Chunk size for the first pass. */
  chunkSize?: number;
  /** Max calls, defaults to 5 (night) or 1 (shutdown). */
  callCap?: number;
  /**
   * Episodes newer than this are not yet consolidated.
   *
   * A2: a SECOND lower bound. The real one is the watermark in `meta`, which
   * records the highest episode id already summarised. `since` alone meant every
   * run re-sent the same day's episodes: duplicate facts, repeated diary entries,
   * and the same smart quota spent again.
   */
  since: number;
  /**
   * A2: set false to ignore the watermark and re-consolidate from `since`. Only
   * tests that deliberately re-run identical input need this.
   */
  useWatermark?: boolean;
  now?: number;
}

/**
 * Run one consolidation pass.
 *
 * Never throws. A failure is recorded in `consolidation_log` with its status, so
 * `elix memory stats` can show the last outcome rather than pretending it worked.
 */
export async function consolidate(opts: ConsolidatorOptions): Promise<ConsolidationResult> {
  const { store, router } = opts;
  const now = opts.now ?? Date.now();
  const chunkSize = opts.chunkSize ?? CHUNK_SIZE;
  const callCap = opts.callCap ?? NIGHT_CALL_CAP;

  // A2: only what has never been consolidated. Both bounds apply.
  const useWatermark = opts.useWatermark ?? true;
  const watermark = useWatermark ? store.consolidatedWatermark() : 0;
  const candidates = useWatermark
    ? store.episodesAfterId(watermark, 400)
    : store.episodesSince(opts.since, 400);
  const episodes = candidates.filter((e) => e.ts >= opts.since);
  if (episodes.length === 0) {
    return {
      ok: true,
      episodesConsidered: 0,
      chunks: 0,
      calls: 0,
      factsMade: 0,
      diary: null,
      deferred: 0,
      watermark,
      status: "no-episodes",
    };
  }

  const chunks: Episode[][] = [];
  for (let i = 0; i < episodes.length; i += chunkSize) {
    chunks.push(episodes.slice(i, i + chunkSize));
  }

  // One call per chunk, capped. A capped run is a partial success: the
  // summaries it did get are still written, and the rest is deferred.
  const usable = chunks.slice(0, Math.max(0, callCap - 1));
  const deferredChunks = chunks.slice(Math.max(0, callCap - 1));
  const deferred = deferredChunks.reduce((n, c) => n + c.length, 0);

  const summaries: ChunkSummary[] = [];
  let calls = 0;
  let invalid = false;

  for (const chunk of usable) {
    const log = chunk
      .map((e) => `- [${e.id}] ${e.player ?? "Elix"}: ${e.text}`)
      .join("\n");
    const text = await callJson(router, CHUNK_SYSTEM, log, chunkSummarySchema, chunk.length);
    calls++;
    if (text === null) {
      invalid = true;
      break;
    }
    summaries.push(text);
  }

  if (invalid) {
    store.logConsolidation({
      ts: now,
      episodes: episodes.length,
      factsMade: 0,
      status: "invalid-json",
    });
    return {
      ok: false,
      episodesConsidered: episodes.length,
      chunks: chunks.length,
      calls,
      factsMade: 0,
      diary: null,
      deferred,
      // A2: a failed run must NOT advance the watermark, or those episodes are
      // never summarised again.
      watermark,
      status: "invalid-json",
      error: "model did not return valid JSON after one retry",
    };
  }

  // Merge. With a single chunk there is nothing to merge, so build the diary
  // from that chunk's notes directly and spend no extra call.
  let merged: MergedSummary | null = null;
  if (summaries.length > 1) {
    const combined = summaries
      .map(
        (s, i) =>
          `part ${i + 1}: ${JSON.stringify({ facts: s.facts, diaryNote: s.diaryNote ?? "" })}`,
      )
      .join("\n");
    const text = await callJson(router, MERGE_SYSTEM, combined, mergeSchema, episodes.length);
    calls++;
    if (text === null) {
      store.logConsolidation({
        ts: now,
        episodes: episodes.length,
        factsMade: 0,
        status: "invalid-json",
      });
      return {
        ok: false,
        episodesConsidered: episodes.length,
        chunks: chunks.length,
        calls,
        factsMade: 0,
        diary: null,
        deferred,
        watermark,
        status: "invalid-json",
        error: "merge did not return valid JSON after one retry",
      };
    }
    merged = text;
  } else {
    const only = summaries[0];
    if (only) {
      merged = {
        facts: only.facts,
        diary: only.diaryNote ?? "",
        importanceAdjust: [],
      };
    }
  }

  const facts = merged?.facts ?? [];
  let factsMade = 0;
  for (const f of facts) {
    try {
      // D1: addFact never updates an old row's text; it links it forward.
      store.addFact({
        ts: now,
        subject: f.subject.toLowerCase(),
        predicate: f.predicate.toLowerCase(),
        object: f.object.toLowerCase(),
        confidence: f.confidence,
        sourceEpisode: episodes[episodes.length - 1]?.id ?? null,
      });
      factsMade++;
    } catch {
      // One bad fact must not lose the batch.
    }
  }

  // Consolidation may adjust importance, per D2.
  for (const adj of merged?.importanceAdjust ?? []) {
    const ep = store.episode(adj.episode);
    if (!ep) continue;
    store.setImportance(adj.episode, adj.importance);
  }

  const diary = merged?.diary?.trim() || null;
  if (diary) store.addSelf("diary", diary, now);

  // A2: advance the watermark ONLY now, with every write committed, and only to
  // the last episode that was actually SUMMARISED. A capped run stops here: the
  // deferred chunks are still above the watermark, so the next night picks them
  // up instead of them being silently skipped.
  const summarisedIds: number[] = [];
  for (let c = 0; c < usable.length; c++) {
    for (const e of chunks[c]!) summarisedIds.push(e.id);
  }
  const newWatermark = summarisedIds.length > 0 ? Math.max(...summarisedIds) : watermark;
  if (newWatermark > watermark) store.setConsolidatedWatermark(newWatermark);

  const status: ConsolidationResult["status"] = deferred > 0 ? "capped" : "ok";
  store.logConsolidation({
    ts: now,
    episodes: episodes.length,
    factsMade,
    diary,
    status,
  });

  return {
    ok: true,
    episodesConsidered: episodes.length,
    chunks: chunks.length,
    calls,
    factsMade,
    diary,
    deferred,
    watermark: newWatermark,
    status,
  };
}

/**
 * One model call, one retry on invalid JSON, then give up.
 *
 * The retry is inside here, which is what "one retry" means in the spec.
 */
async function callJson<T>(
  router: BrainRouter,
  system: string,
  userContent: string,
  schema: z.ZodType<T>,
  sourceCount: number,
): Promise<T | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let raw = "";
    try {
      const res = await router.complete({
        messages: [
          { role: "system", content: system, importance: 1000, pinned: true },
          { role: "user", content: userContent, importance: 1000, pinned: true },
        ],
        role: "smart",
        maxTokens: 1200,
        // A direct reply is never idle chatter, and consolidation must not be
        // starved by the chat budget.
        bypassIdleBudget: true,
        source: "consolidation",
      });
      raw = res.text;
    } catch {
      return null;
    }
    const parsed = parseLooseJson(raw, schema);
    if (parsed !== null) return parsed;
    void sourceCount;
  }
  return null;
}

/**
 * Pull a JSON object out of a model response and validate it.
 *
 * Models wrap JSON in prose or code fences even when told not to, so a strict
 * JSON.parse would fail on a perfectly good answer. The schema is still the
 * authority: nothing is written unless it validates.
 */
export function parseLooseJson<T>(raw: string, schema: z.ZodType<T>): T | null {
  const text = raw.trim();
  if (text.length === 0) return null;
  const candidates: string[] = [text];

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));

  for (const candidate of candidates) {
    try {
      const parsed = schema.safeParse(JSON.parse(candidate));
      if (parsed.success) return parsed.data;
    } catch {
      // Try the next candidate shape.
    }
  }
  return null;
}

/** Re-score an episode's importance with the current rules. */
export function rescoreEpisode(
  store: MemoryStore,
  id: number,
  isFirstMeeting: boolean,
): number | null {
  const ep = store.episode(id);
  if (!ep) return null;
  return scoreImportance({
    kind: ep.kind,
    text: ep.text,
    speaker: ep.speaker,
    player: ep.player,
    isFirstMeeting,
  });
}
