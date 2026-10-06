/**
 * WP8 — letting the brain ask for actions, without letting it run anything.
 *
 * The model cannot execute code, and it cannot name a function that does not exist. It can
 * emit ONE JSON block asking for one of eight named actions, and this module decides whether
 * that request is allowed. Everything it emits is validated by a schema; nothing it emits is
 * ever evaluated.
 *
 * The rules, in the order they are applied. The order is the point:
 *
 *   1. PARSE. Fenced JSON only, and a schema. An unparseable block is one log line and
 *      nothing else.
 *   2. KNOWN TOOL. An unknown name is ignored. The model does not get to invent `exec`.
 *   3. OWNER ONLY. A stranger's line may never produce an action, however well-formed it is.
 *   4. DROPPED REPLY DROPS ITS TOOL CALLS. If any gate suppressed the reply, the actions go
 *      with it - otherwise Elix would act on something he was not allowed to say.
 *   5. GENTLE MODE narrows the list to `stop` and `follow`. Nothing else.
 *   6. RATE. At most one per reply, and at most six a minute.
 *   7. LOG without the message text. What was asked for and who asked - never what they said.
 */
import { z } from "zod";

/** The fixed list. Nothing outside it is ever accepted. */
export const TOOL_NAMES = [
  "follow",
  "come",
  "stop",
  "gather",
  "craft",
  "give",
  "goTo",
  "rememberPlace",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

/** Tools that stay allowed during gentle mode. */
export const GENTLE_MODE_TOOLS: ReadonlySet<ToolName> = Object.freeze(
  new Set<ToolName>(["stop", "follow"]),
);

/** At most one tool call per reply. */
export const MAX_TOOLS_PER_REPLY = 1;

/** At most this many tool calls a minute, across every player. */
export const MAX_TOOLS_PER_MINUTE = 6;

export const RATE_WINDOW_MS = 60_000;

/**
 * The schema for one tool call.
 *
 * `z.discriminatedUnion` on the tool name is what makes "an unknown tool" and "a known tool
 * with the wrong arguments" two different, separately-tested failures.
 */
export const toolCallSchema = z.discriminatedUnion("tool", [
  z.object({
    tool: z.literal("follow"),
    /** Who to follow. Resolved against the tracked players by the caller. */
    player: z.string().min(1).max(16),
  }),
  z.object({ tool: z.literal("come") }),
  z.object({ tool: z.literal("stop") }),
  z.object({
    tool: z.literal("gather"),
    block: z.string().min(1).max(48),
    count: z.number().int().min(1).max(64).optional(),
  }),
  z.object({
    tool: z.literal("craft"),
    item: z.string().min(1).max(48),
    count: z.number().int().min(1).max(64).optional(),
  }),
  z.object({
    tool: z.literal("give"),
    item: z.string().min(1).max(48),
    count: z.number().int().min(1).max(64).optional(),
  }),
  z.object({
    tool: z.literal("goTo"),
    place: z.string().min(1).max(32),
  }),
  z.object({
    tool: z.literal("rememberPlace"),
    key: z.string().min(1).max(32),
  }),
]);

export type ToolCall = z.infer<typeof toolCallSchema>;

/** What came out of the model. */
export type ParseOutcome =
  | { ok: true; calls: ToolCall[] }
  | { ok: false; reason: "no-block" | "unparseable" | "unknown-tool" | "bad-arguments"; detail: string };

/**
 * Find and parse the tool block in a model reply.
 *
 * Only a FENCED block counts. A bare `{"tool":"stop"}` in the middle of prose is something a
 * player could type and get Elix to act on, so it is not read at all - which is also why the
 * fence is required on both sides.
 */
export function parseToolCalls(text: string): ParseOutcome {
  const fence = /```(?:tool_calls|elix_tools|json)?\s*\n([\s\S]*?)```/gu;
  const found: string[] = [];
  for (const m of text.matchAll(fence)) {
    const body = m[1];
    if (body !== undefined) found.push(body.trim());
  }
  if (found.length === 0) return { ok: false, reason: "no-block", detail: "no fenced tool block" };

  const calls: ToolCall[] = [];
  for (const body of found) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (err) {
      return {
        ok: false,
        reason: "unparseable",
        detail: err instanceof Error ? err.message : "invalid JSON",
      };
    }
    const list = Array.isArray(parsed) ? parsed : [parsed];
    for (const entry of list) {
      if (entry === null || typeof entry !== "object") {
        return { ok: false, reason: "bad-arguments", detail: "not an object" };
      }
      const name = (entry as { tool?: unknown }).tool;
      if (typeof name !== "string" || !(TOOL_NAMES as readonly string[]).includes(name)) {
        return {
          ok: false,
          reason: "unknown-tool",
          // The name is included, the content is not. A model that asked for `rm -rf` should
          // be visible in the log; what it wrapped in it should not.
          detail: `unknown tool: ${String(name).slice(0, 32)}`,
        };
      }
      const result = toolCallSchema.safeParse(entry);
      if (!result.success) {
        return {
          ok: false,
          reason: "bad-arguments",
          detail: `${name}: ${result.error.issues.map((i) => i.path.join(".")).join(",") || "invalid"}`,
        };
      }
      calls.push(result.data);
    }
  }
  return { ok: true, calls };
}

/** Why a parsed call was not run. */
export type ToolRefusal =
  | "not-an-owner"
  | "dropped-reply"
  | "gentle-mode"
  | "rate-limited"
  | "too-many-in-one-reply";

/** Everything the gate needs to know. */
export interface ToolGateInput {
  /** Who the reply was for. */
  askedBy: string;
  /** Is that person an owner? */
  isOwner: boolean;
  /** Did any gate drop the reply this block came with? */
  replyDropped: boolean;
  /** Is Elix in gentle mode? */
  gentleMode: boolean;
  /** How many tool calls have run in the last minute. */
  callsThisMinute: number;
}

/** What the gate decided. */
export type ToolGateResult =
  | { ok: true; call: ToolCall }
  | { ok: false; reason: ToolRefusal };

/**
 * Decide whether ONE parsed call may run.
 *
 * Dropped-reply is checked before ownership, because a dropped reply is not a reply at all:
 * if Elix was not allowed to say it, he is certainly not allowed to act on it.
 */
export function gateToolCall(call: ToolCall, input: ToolGateInput): ToolGateResult {
  if (input.replyDropped) return { ok: false, reason: "dropped-reply" };
  if (!input.isOwner) return { ok: false, reason: "not-an-owner" };
  if (input.gentleMode && !GENTLE_MODE_TOOLS.has(call.tool)) {
    return { ok: false, reason: "gentle-mode" };
  }
  if (input.callsThisMinute >= MAX_TOOLS_PER_MINUTE) {
    return { ok: false, reason: "rate-limited" };
  }
  return { ok: true, call };
}

/**
 * The whole path: parse, then gate the calls in order, keeping at most the first.
 *
 * Returns the calls that may run AND the reason for the first one that may not, so the
 * caller can log exactly one line about what it ignored.
 */
export function selectToolCalls(
  text: string,
  input: ToolGateInput,
): { calls: ToolCall[]; refused: ToolRefusal | null; detail: string | null } {
  const parsed = parseToolCalls(text);
  if (!parsed.ok) return { calls: [], refused: null, detail: `${parsed.reason}: ${parsed.detail}` };

  const allowed: ToolCall[] = [];
  let refused: ToolRefusal | null = null;
  for (const call of parsed.calls) {
    if (allowed.length >= MAX_TOOLS_PER_REPLY) {
      refused = "too-many-in-one-reply";
      break;
    }
    const gate = gateToolCall(call, input);
    if (gate.ok) {
      allowed.push(gate.call);
      continue;
    }
    refused = gate.reason;
    break;
  }
  return { calls: allowed, refused, detail: null };
}

/** The rate limiter, so the count in `input` is one somebody maintains. */
export class ToolRateLimiter {
  private stamps: number[] = [];

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** How many calls are inside the current window. */
  get callsThisMinute(): number {
    const cutoff = this.now() - RATE_WINDOW_MS;
    this.stamps = this.stamps.filter((t) => t > cutoff);
    return this.stamps.length;
  }

  /** Record one call. */
  hit(): void {
    this.stamps.push(this.now());
  }

  /** Forget everything, for tests. */
  reset(): void {
    this.stamps = [];
  }
}

/**
 * The log line for a tool call.
 *
 * Deliberately has no field for the player's message. `toJSON` returns exactly these keys so
 * a caller cannot pass a whole reply object in and leak the text by accident.
 */
export function toolLogLine(
  call: ToolCall,
  askedBy: string,
  refused: ToolRefusal | null,
): { tool: string; askedBy: string; refused: ToolRefusal | null } {
  return { tool: call.tool, askedBy, refused };
}