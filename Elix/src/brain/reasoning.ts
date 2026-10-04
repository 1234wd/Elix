/**
 * Reasoning models (A4).
 *
 * Verified against Groq's live docs on 2026-10-02
 * (https://console.groq.com/docs/reasoning):
 *
 *   "With openai/gpt-oss-20b and openai/gpt-oss-120b, the reasoning_format
 *    parameter is not supported. By default, these models will include
 *    reasoning content in the reasoning field of the assistant response. You
 *    can also control whether reasoning is included in the response by setting
 *    the include_reasoning parameter."
 *
 *   "The include_reasoning parameter cannot be used together with
 *    reasoning_format. These parameters are mutually exclusive."
 *
 *   reasoning_effort for GPT-OSS : low | medium | high   (20B and 120B only)
 *   reasoning_effort for Qwen3.8: none | default | low | medium | high
 *   reasoning_format             : parsed | raw | hidden
 *
 * So the two families need DIFFERENT parameters. Sending reasoning_format to a
 * gpt-oss model is the bug this file exists to prevent.
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
  [/\[thinking\]/gi, [/\[\/thinking\]/gi] as unknown as RegExp],
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

/** Is this a reasoning model at all? Non-reasoning models get no extra params. */

/* ------------------------------------------------------- leaked reasoning */

/**
 * Prefixes that mean the model's ANALYSIS, not its answer, got sent to a player.
 *
 * gpt-oss emits its scratchpad into `content` when the reasoning channel is not
 * separated, and what reaches the game reads like this:
 *
 *     "We have **………..?????..?....????…"
 *
 * The punctuation-run check caught that one, but only by luck. The real defect is
 * the PREFIX: a coherent leaked sentence passes every other check there is. This
 * is the actual observed coherent leak:
 *
 *     "We need to answer the user about their favourite block."
 *
 * Nothing about that is malformed. It is a well-formed sentence, it is simply not
 * something to say to someone in a Minecraft server.
 *
 * Matched on the FIRST few characters only. A mid-message "the user" is
 * legitimate — Elix talks about the person he is talking to — so this must not
 * fire on a stray mention.
 */
const LEAKED_REASONING_PREFIXES: ReadonlyArray<readonly [RegExp, string]> = [
  // CAPITALISED analysis openers. The leading \** absorbs the markdown bold the
  // model wraps its scratchpad in.
  //
  // Case is a real signal, not a stylistic guess: persona.md says Elix writes casual
  // LOWERCASE chat, and every observed leak is capitalised. The previous rule
  // matched any case, and so discarded ordinary replies like "we have enough iron
  // for that" — a line Elix says naturally — silently wasting a call and pushing
  // the answer to a fallback.
  [/^\**\s*We\s+(?:have|need|should|must|want|can|could|are|will)\b/, "we-" + "prefix"],
  [/^\**\s*The\s+user\b/, "the-user"],
  [/^\**\s*Let(?:'?s|\s+us)\s+(?:think|consider|analy[sz]e|break\s+it\s+down)\b/, "lets-think"],
  [/^\**\s*Analysis\b/, "analysis"],
  // A numbered or bulleted scratchpad that slipped through.
  [/^\**\s*(?:Step\s+\d|Reasoning\s*:)/, "scratchpad-marker"],
];

/**
 * Vocabulary that only analysis uses.
 *
 * This is the catch-all that lets the prefix list stay capitalisation-sensitive
 * without becoming case-blind. Elix has no reason to say any of it: he talks about
 * a game and to the person in front of him.
 */
const ANALYSIS_VOCABULARY =
  /\b(?:the user(?:'s| has| wants| asked| is asking| mentioned)?|the player (?:asked|wants|said|is asking)|we need to (?:answer|respond|reply)|we should (?:answer|respond|reply|say)|the (?:system )?prompt|instructions?|let me think|analysis|reasoning (?:about|process)|as an? (?:ai|language model)|based on the (?:prompt|instructions))\b/i;

/** Does this text carry analysis vocabulary anywhere in it? */
export function analysisVocabulary(text: string): boolean {
  return ANALYSIS_VOCABULARY.test(text);
}

export interface LeakedReasoningResult {
  leaked: boolean;
  /** Which prefix matched. Never the text itself. */
  rule: string;
}

/**
 * Is this analysis rather than an answer?
 *
 * TRUE POSITIVES matter more than a missed one here, because the failure mode is
 * mild: the router treats it as a failed attempt and tries the NEXT model. The
 * worst false positive is that a perfectly good reply from one model gets
 * discarded in favour of another model's answer.
 *
 * That is the trade, and it is worth making. The cost of the opposite mistake —
 * sending "We need to answer the user about their favourite block" to a player on
 * a public server — is the whole product looking broken.
 *
 * THE KNOWN COLLISION SURFACE, measured rather than assumed. These are ordinary
 * things Elix might say that this rule will still discard:
 *
 *     "we have enough iron for that"
 *     "we should meet at spawn"
 *     "the user of this server is not me"
 *
 * That is the accepted cost, and it is the right way round: a discarded reply
 * means one extra model call and a slightly different answer, while a leaked
 * sentence means a player on a public server is told "We need to answer the user
 * about their favourite block". tests/unit/leakedReasoning.test.ts asserts these
 * specific collisions, so the surface is a measured property rather than
 * something to be surprised by later.
 */
export function detectLeakedReasoning(text: string): LeakedReasoningResult {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { leaked: false, rule: "empty" };
  // Only the opening of the message. A leak is a model that starts its answer
  // with its scratchpad.
  const head = trimmed.slice(0, 120);
  for (const [re, rule] of LEAKED_REASONING_PREFIXES) {
    if (re.test(head)) return { leaked: true, rule };
  }
  // Case-independent, but only on vocabulary Elix would never use. This is what
  // keeps the detector honest about capitalisation while still catching a leak
  // that does not happen to begin at position zero.
  if (ANALYSIS_VOCABULARY.test(trimmed)) return { leaked: true, rule: "analysis-vocabulary" };
  return { leaked: false, rule: "no-prefix-match" };
}

export function isReasoningModel(model: string): boolean {
  const m = model.toLowerCase();
  return (
    m.includes("gpt-oss") ||
    m.includes("qwen3.8") ||
    m.includes("qwen3-") ||
    m.includes("deepseek-r") ||
    m.includes("qwq") ||
    m.includes("minimax-m")
  );
}

/**
 * Does this model accept `reasoning_format`?
 *
 * gpt-oss does NOT — sending it is the A4 bug. Everything else in Groq's
 * supported reasoning list does.
 */
export function supportsReasoningFormat(model: string): boolean {
  return !model.toLowerCase().includes("gpt-oss");
}

/**
 * Lowest effort that still answers. Deep reasoning is wasted on chat.
 *
 * Takes the model so a future family with a different cheapest value can be
 * added without changing the callers; both documented families take "low".
 */
export function reasoningEffortFor(_model: string): "low" | "medium" | "high" {
  return "low";
}

/**
 * The reasoning parameters to put in the request body.
 *
 * Exactly one of the two mutually exclusive mechanisms, chosen per model.
 */
export function reasoningParams(model: string): Record<string, unknown> {
  if (!isReasoningModel(model)) return {};
  if (supportsReasoningFormat(model)) {
    return { reasoning_effort: reasoningEffortFor(model), reasoning_format: "hidden" };
  }
  // gpt-oss: reasoning_format is unsupported and would be rejected.
  return { reasoning_effort: reasoningEffortFor(model), include_reasoning: false };
}

/**
 * Minimum completion tokens a reasoning model needs before it will emit any
 * visible content (A4).
 *
 * Reasoning tokens are counted against the completion limit, so a 120-token
 * ceiling lets a reasoning model spend its entire budget thinking and return
 * empty content. Groq's own quick start uses max_completion_tokens: 1024.
 */
export const REASONING_MIN_COMPLETION_TOKENS = 512;

/** Clamp a requested max-tokens up to the floor a reasoning model needs. */
export function completionTokenLimit(model: string, requested: number): number {
  if (!isReasoningModel(model)) return requested;
  return Math.max(requested, REASONING_MIN_COMPLETION_TOKENS);
}

/**
 * Keep a chat reply short without relying on the model to comply (A4).
 *
 * Two sentences or ~200 characters, whichever comes first, cut on sentence
 * boundaries so it never ends mid-word. Used only for in-game chat, where a
 * wall of text in the chat box is unreadable.
 */
export function trimChatReply(text: string, maxChars = 200): string {
  let t = text.trim();
  if (t.length === 0) return t;
  if (t.length > maxChars) {
    const cut = t.slice(0, maxChars);
    const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    t = lastStop > 0 ? cut.slice(0, lastStop + 1) : cut.trimEnd();
  }
  // Cap the sentence count too.
  const parts = t.split(/(?<=[.!?])\s+/);
  if (parts.length > 2) t = parts.slice(0, 2).join(" ").trim();
  return t;
}
