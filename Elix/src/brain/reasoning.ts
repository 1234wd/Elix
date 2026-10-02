/**
 * Strip reasoning traces from a chat response (B4).
 *
 * `openai/gpt-oss-20b` and `-120b` are reasoning models. Their API can return
 * the chain of thought either as a separate `reasoning` field or inline in
 * `content` wrapped in think tags. None of that may ever reach game chat — the
 * player would see the model's scratchpad, which is both confusing and a leak of
 * the system prompt's influence.
 */

export interface ReasoningSplit {
  /** Just the answer, safe to send to a player. */
  content: string;
  /** How many characters of reasoning text were removed. */
  reasoningChars: number;
}

/** Tags that may wrap reasoning, longest/most specific first. */
const REASONING_TAG_PAIRS: ReadonlyArray<readonly [RegExp, RegExp]> = [
  [/<think>/gi, /<\/think>/gi],
  [/\[thinking\]/gi, /\[\/thinking\]/gi],
  [/<\/?reasoning>/gi, /<\/?reasoning>/gi],
];

/**
 * Remove reasoning content from a raw assistant message.
 *
 * Handles all three shapes, and applies them cumulatively because providers
 * disagree about where reasoning ends up:
 *   { content: "<think>step 1...</think>final answer" }  inline tags
 *   { reasoning: "...", content: "final answer" }        dedicated field
 *   { reasoning: "...", content: "<think>x</think>hi" }  both at once
 */
export function stripReasoning(raw: unknown): ReasoningSplit {
  let content = "";
  let reasoningChars = 0;

  if (raw && typeof raw === "object" && "reasoning" in raw) {
    const obj = raw as { reasoning?: unknown; content?: unknown };
    const reasoningText =
      typeof obj.reasoning === "string"
        ? obj.reasoning
        : Array.isArray(obj.reasoning)
          ? obj.reasoning.map((r) => (typeof r === "string" ? r : "")).join("")
          : "";
    reasoningChars += reasoningText.length;
    content = typeof obj.content === "string" ? obj.content : "";
  } else if (typeof raw === "string") {
    content = raw;
  } else {
    return { content: "", reasoningChars: 0 };
  }

  // Inline tags can be present whether or not a `reasoning` field was sent, so
  // this runs on both shapes.
  let text = content;
  for (const [open, close] of REASONING_TAG_PAIRS) {
    const re = new RegExp(`${open.source}[\\s\\S]*?${close.source}`, "gi");
    text = text.replace(re, (match) => {
      reasoningChars += match.length;
      return "";
    });
  }
  // An unclosed <think> is a truncated stream; drop the remainder.
  const orphan = /<think>[\s\S]*$/i.exec(text);
  if (orphan) {
    reasoningChars += orphan[0].length;
    text = text.slice(0, orphan.index);
  }

  return { content: text.trim(), reasoningChars };
}

/**
 * Reasoning-effort setting per model (B4).
 *
 * gpt-oss accepts `reasoning_effort: "low" | "medium" | "high"`. Chat replies
 * do not need deep reasoning, so we ask for the lowest that still works rather
 * than burning quota on a full derivation for "hi".
 */
export function reasoningEffortFor(model: string): "low" | "medium" | "high" {
  const m = model.toLowerCase();
  if (m.includes("gpt-oss-120b")) return "low";
  if (m.includes("gpt-oss-20b")) return "low";
  // Non-reasoning models: the parameter is ignored, but harmless to omit.
  return "low";
}

/** Is this a reasoning model at all? */
export function isReasoningModel(model: string): boolean {
  const m = model.toLowerCase();
  return m.includes("gpt-oss") || m.includes("deepseek-r") || m.includes("qwq");
}