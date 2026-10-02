/**
 * The in-game chat bridge (B9).
 *
 * A deliberately small preview of the Phase 5 social layer:
 *   - only replies when a player addresses Elix by name
 *   - one short reply, persona-lite system prompt
 *   - the reply goes out through SayQueue, so rate limits still apply
 *   - a keyword/regex check runs BEFORE any provider call
 *   - an output filter runs AFTER, on every reply
 *   - only the player's name and their message are ever sent
 *
 * Config: brain.chatReplies (default true).
 */
import type { Logger } from "../core/logger.js";
import type { BrainRouter } from "./router.js";
import { SayQueue } from "../social/say.js";
import { buildChatMessages, isAddressedToElix, loadPersonaLite } from "./persona.js";
import { checkInputSafety, BLOCKED_LINES } from "./fallback.js";
import { checkOutputSafety, DEFLECTION_LINES } from "./leakFilter.js";
import { trimChatReply } from "./reasoning.js";
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
  /** Extra literals that must never appear in a reply, e.g. this server's host. */
  outputSecrets?: readonly string[];
  /** A4: cap in-game replies at this many characters. */
  maxReplyChars?: number;
}

export interface BridgeReply {
  replied: boolean;
  reason: string;
  text?: string;
  usedProvider?: string;
}

export class ChatBridge {
  private readonly opts: ChatBridgeOptions;
  private readonly persona: string;
  private readonly blockedRecent: string[] = [];
  private readonly deflectRecent: string[] = [];
  private replies = 0;

  /**
   * A9: one in-flight reply per player.
   *
   * If a player sends a second message while the first is still being answered,
   * the older request is abandoned — answering a stale question is worse than
   * answering the latest one, and two concurrent calls spend double the quota
   * for one conversation.
   */
  private readonly inFlight = new Map<string, { message: string; controller: AbortController }>();

  constructor(opts: ChatBridgeOptions) {
    this.opts = opts;
    this.persona = opts.personaLite ?? loadPersonaLite(PROJECT_ROOT);
  }

  get replyCount(): number {
    return this.replies;
  }

  /** How many replies are currently being generated. */
  get inFlightCount(): number {
    return this.inFlight.size;
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

    // Input check first — nothing goes to a provider if this trips (B9/A5).
    const safety = checkInputSafety(message);
    if (!safety.safe) {
      // A5: a dedicated pool. "brb, lag" as an answer to an injection attempt
      // made no sense and read as a malfunction.
      const line = this.pick(BLOCKED_LINES, this.blockedRecent);
      this.opts.log?.warn({ sender, rule: safety.reason }, "blocked suspected prompt injection");
      this.replies += 1;
      sayQueue?.say(line, false);
      return { replied: true, reason: "blocked-injection", text: line, usedProvider: "builtin" };
    }

    // A9: a newer message from the same player supersedes the one in flight.
    const superseded = this.inFlight.get(sender);
    if (superseded) superseded.controller.abort();
    const controller = new AbortController();
    this.inFlight.set(sender, { message, controller });

    try {
      const result = await this.opts.router.complete({
        messages: buildChatMessages(sender, message, this.persona),
        role: "fast",
        // A4: reasoning models need room to think or they return nothing. The
        // router clamps this up to its per-model floor.
        maxTokens: 200,
        // A3: answering someone who spoke to Elix is NOT idle chatter. The
        // idle budget is for unprompted remarks in Phase 5. Without this, a
        // player who asked 3 questions got "brb, lag" for the third.
        bypassIdleBudget: true,
        source: "chat-reply",
        signal: controller.signal,
        ...(this.opts.signal ? { signal: controller.signal } : {}),
      });

      // B7: an abort during the call means shutdown, not a reply worth sending.
      if (this.opts.signal?.aborted) {
        return { replied: false, reason: "aborted" };
      }
      // A9: a newer message arrived, so this answer is already out of date.
      if (this.inFlight.get(sender)?.controller !== controller) {
        return { replied: false, reason: "superseded" };
      }

      // A4: never send an empty reply. That was a silent no-answer in game.
      const raw = result.text.trim();
      if (raw.length === 0) {
        return { replied: false, reason: "empty-reply" };
      }

      // A5: the stronger guardrail. A model can be talked into printing a key
      // without any suspicious keyword, so scan the OUTPUT too.
      const leak = checkOutputSafety(raw, {
        ...(this.opts.outputSecrets ? { secrets: this.opts.outputSecrets } : {}),
      });
      if (!leak.safe) {
        const line = this.pick(DEFLECTION_LINES, this.deflectRecent);
        this.opts.log?.error({ sender, rule: leak.rule }, "reply blocked by leak filter");
        this.replies += 1;
        sayQueue?.say(line, false);
        return { replied: true, reason: "blocked-leak", text: line, usedProvider: "builtin" };
      }

      // A4: chat is not a place for a paragraph. Cap it after the safety
      // check, so a leak is detected in the FULL text, not the trimmed one.
      const text = trimChatReply(raw, this.opts.maxReplyChars ?? 200);

      this.replies += 1;
      sayQueue?.say(text, false);
      return {
        replied: true,
        reason: result.fromFallback ? "fallback" : "llm",
        text,
        usedProvider: `${result.provider}/${result.model}`,
      };
    } finally {
      // Only clear if we are still the current request for this player.
      if (this.inFlight.get(sender)?.controller === controller) {
        this.inFlight.delete(sender);
      }
    }
  }

  /** Round-robin over a pool, avoiding the last few used (B6 no-repeat rule). */
  private pick(pool: readonly string[], recent: string[]): string {
    const fresh = pool.filter((l) => !recent.includes(l));
    const candidates = fresh.length > 0 ? fresh : pool;
    const line = candidates[Math.floor(Math.random() * candidates.length)] ?? pool[0]!;
    recent.push(line);
    if (recent.length > 3) recent.shift();
    return line;
  }
}
