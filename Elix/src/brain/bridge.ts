/**
 * The in-game chat bridge (B9).
 *
 * A deliberately small preview of the Phase 5 social layer:
 *   - only replies when a player addresses Elix by name
 *   - one short reply, persona-lite system prompt
 *   - the reply goes out through SayQueue, so rate limits still apply
 *   - a keyword/regex check runs BEFORE any provider call, so a suspected
 *     injection attempt never leaves the machine
 *   - only the player's name and their message are ever sent
 *
 * Config: brain.chatReplies (default true).
 */
import type { Logger } from "../core/logger.js";
import type { BrainRouter } from "./router.js";
import { SayQueue } from "../social/say.js";
import { buildChatMessages, isAddressedToElix, loadPersonaLite } from "./persona.js";
import { checkInputSafety, pickFallbackLine, classifySituation } from "./fallback.js";
import { PROJECT_ROOT } from "../core/config.js";

export interface ChatBridgeOptions {
  router: BrainRouter;
  username: string;
  log: Logger;
  personaLite?: string;
  /** Stop after this many replies — used by tests. */
  maxReplies?: number;
  /**
   * B7: aborting this signal cancels an in-flight provider call, so Ctrl+C
   * never waits on the network. Wired to the same AbortController the router's
   * startup model discovery uses.
   */
  signal?: AbortSignal;
}

export interface BridgeReply {
  replied: boolean;
  reason: string;
  text?: string;
  usedProvider?: string;
}

export class ChatBridge {
  private readonly opts: ChatBridgeOptions;
  private readonly recentLines: string[] = [];
  private readonly persona: string;
  private replies = 0;

  constructor(opts: ChatBridgeOptions) {
    this.opts = opts;
    this.persona = opts.personaLite ?? loadPersonaLite(PROJECT_ROOT);
  }

  get replyCount(): number {
    return this.replies;
  }

  /**
   * Handle one inbound chat line. Returns why it did or did not reply, so the
   * decision is observable in tests and in logs.
   */
  async handle(sender: string, message: string, sayQueue?: SayQueue): Promise<BridgeReply> {
    if (this.opts.signal?.aborted) {
      return { replied: false, reason: "shutting-down" };
    }
    if (this.opts.maxReplies !== undefined && this.replies >= this.opts.maxReplies) {
      return { replied: false, reason: "max-replies" };
    }
    if (!isAddressedToElix(message, this.opts.username)) {
      return { replied: false, reason: "not-addressed" };
    }

    // Input check first — nothing goes to a provider if this trips (B9).
    const safety = checkInputSafety(message);
    if (!safety.safe) {
      // Answer locally from the scripted pool. No network, no cost.
      const line = pickFallbackLine("generic", this.recentLines);
      this.opts.log?.warn({ sender, pattern: safety.reason }, "blocked suspected prompt injection");
      this.replies += 1;
      sayQueue?.say(line, false);
      return { replied: true, reason: "blocked-injection", text: line, usedProvider: "builtin" };
    }

    const result = await this.opts.router.complete({
      messages: buildChatMessages(sender, message, this.persona),
      role: "fast",
      maxTokens: 120,
      source: "chat-reply",
      ...(this.opts.signal ? { signal: this.opts.signal } : {}),
    });

    // B7: an abort during the call means shutdown, not a reply worth sending.
    if (this.opts.signal?.aborted) {
      return { replied: false, reason: "aborted" };
    }

    const text = result.text.trim();
    if (text.length === 0) {
      return { replied: false, reason: "empty-reply" };
    }

    this.replies += 1;
    sayQueue?.say(text, false);
    return {
      replied: true,
      reason: result.fromFallback ? "fallback" : "llm",
      text,
      usedProvider: `${result.provider}/${result.model}`,
    };
  }
}

/** Situation classifier re-exported so the bot's own greeting path can use it. */
export { classifySituation };