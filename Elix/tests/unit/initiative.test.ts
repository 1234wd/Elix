/**
 * Round 13 B — initiative.
 *
 * `shouldInitiate()` had no caller for three rounds, and reading it then showed it was
 * missing three of the four conditions that matter: it never asked whether Elix was busy,
 * whether anyone was nearby, or whether he had just spoken to that person. A function with
 * no caller cannot have its missing conditions discovered, so these are the tests that
 * would have caught it.
 *
 * One named test per check, plus the all-pass case. Every threshold is configurable, so
 * there is a test here that the config section and this module agree on the defaults —
 * a silent divergence between the two would be invisible otherwise, and it is exactly how
 * "16 blocks" quietly became "20".
 *
 * Zero network, zero clock: every time is passed in.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_INITIATIVE,
  INITIATIVE_MIN_GAP_MS,
  shouldInitiate,
  type InitiativeOptions,
} from "../../src/social/manners.js";
import { elixConfigSchema } from "../../src/core/config.js";

const MINUTE = 60_000;

/** Everything passes. Each test breaks exactly ONE thing. */
const BASE: InitiativeOptions = {
  ...DEFAULT_INITIATIVE,
  drive: "connection",
  pull: 0.8,
  budgetRemaining: 40,
  now: 10 * MINUTE,
  lastInitiativeAt: 0,
  busy: false,
  nearestPlayerBlocks: 4,
  lastWellbeingReplyAt: null,
  nearestPlayer: "Steve",
  pendingAuditNearby: false,
};

describe("B — shouldInitiate refuses when it must", () => {
  it("refuses while Elix is busy with a skill or a reply in flight", () => {
    expect(shouldInitiate({ ...BASE, busy: true })).toBe(false);
  });

  it("refuses when nobody is online", () => {
    expect(shouldInitiate({ ...BASE, nearestPlayerBlocks: null })).toBe(false);
  });

  it("refuses when the nearest player is out of range", () => {
    expect(shouldInitiate({ ...BASE, nearestPlayerBlocks: 17 })).toBe(false);
  });

  it("allows a player exactly at the configured distance", () => {
    // Boundary, not "further than": 16 is allowed and 17 is not, because a bot that
    // needs to be strictly closer is a bot with a different rule than the one configured.
    expect(shouldInitiate({ ...BASE, nearestPlayerBlocks: 16 })).toBe(true);
  });

  it("refuses while an audit for a nearby player is pending", () => {
    // The Round 12 lesson, one layer down: an unprompted line must never overtake a
    // safety decision that is still in flight.
    expect(shouldInitiate({ ...BASE, pendingAuditNearby: true })).toBe(false);
  });

  it("refuses inside the wellbeing quiet window for that player", () => {
    const now = 30 * MINUTE;
    expect(
      shouldInitiate({ ...BASE, now, lastWellbeingReplyAt: now - 19 * MINUTE }),
    ).toBe(false);
  });

  it("allows it again once the wellbeing window has passed", () => {
    const now = 30 * MINUTE;
    expect(
      shouldInitiate({ ...BASE, now, lastWellbeingReplyAt: now - 21 * MINUTE }),
    ).toBe(true);
  });

  it("respects a configured quiet window rather than a hard-coded one", () => {
    // If this fails, a config change would be silently ignored — the failure mode that
    // made the old 0.25 pull constant look configurable when it was not.
    const now = 30 * MINUTE;
    expect(
      shouldInitiate({
        ...BASE,
        wellbeingQuietMs: 60 * MINUTE,
        now,
        lastWellbeingReplyAt: now - 30 * MINUTE,
      }),
    ).toBe(false);
  });

  it("refuses when the idle budget is spent", () => {
    expect(shouldInitiate({ ...BASE, budgetRemaining: 0 })).toBe(false);
  });

  it("refuses inside the self-started gap", () => {
    expect(shouldInitiate({ ...BASE, now: INITIATIVE_MIN_GAP_MS - 1 })).toBe(false);
  });

  it("refuses when no drive is pulling", () => {
    expect(shouldInitiate({ ...BASE, pull: 0.25 })).toBe(false);
    expect(shouldInitiate({ ...BASE, pull: 0.1 })).toBe(false);
  });

  it("refuses when initiative is switched off", () => {
    expect(shouldInitiate({ ...BASE, enabled: false })).toBe(false);
  });
});

describe("B — shouldInitiate allows exactly when everything passes", () => {
  it("true for an idle, nearby, quiet moment with budget and pull", () => {
    expect(shouldInitiate(BASE)).toBe(true);
  });

  it("and it is only ever the conjunction: every single refusal flips it", () => {
    const refusals: Array<[string, Partial<InitiativeOptions>]> = [
      ["busy", { busy: true }],
      ["nobody online", { nearestPlayerBlocks: null }],
      ["too far", { nearestPlayerBlocks: 99 }],
      ["audit pending", { pendingAuditNearby: true }],
      ["no budget", { budgetRemaining: 0 }],
      ["too soon", { lastInitiativeAt: 10 * MINUTE - 1 }],
      ["inside wellbeing quiet window", { lastWellbeingReplyAt: 10 * MINUTE - MINUTE }],
      ["no pull", { pull: 0 }],
      ["disabled", { enabled: false }],
    ];
    for (const [name, patch] of refusals) {
      expect(shouldInitiate({ ...BASE, ...patch }), name).toBe(false);
    }
    expect(shouldInitiate(BASE)).toBe(true);
  });
});

describe("B — the config section and the module agree", () => {
  it("every default is the same number in both places", () => {
    // Parsed through the real schema rather than read from the YAML, so a config file
    // that omits the section still gets the shipped defaults checked.
    const cfg = elixConfigSchema.parse({
      version: 1,
      bot: { username: "Elix", version: "26.2", serverAllowlist: [] },
      server: { profile: null },
      profiles: {},
      brain: {
        fastMaxTokens: 1500,
        smartMaxTokens: 4000,
        timeoutsMs: { fast: 6000, smart: 20000 },
        idleChatterBudgetPerHour: 60,
        chatReplies: true,
      },
      voice: { enabled: false, textOnlyFallback: true },
      safety: { contentLevel: "kid-safe", chatRateLimitPer2s: 1, helplineText: "", allowEmoji: false },
    });
    expect(cfg.initiative).toEqual(DEFAULT_INITIATIVE);
  });

  it("the documented policy numbers are the ones in force", () => {
    // 16 blocks and 20 minutes are the two numbers the vision names, so they are pinned
    // here rather than left to whatever the schema happens to say today.
    expect(DEFAULT_INITIATIVE.nearbyBlocks).toBe(16);
    expect(DEFAULT_INITIATIVE.wellbeingQuietMs).toBe(20 * MINUTE);
    expect(DEFAULT_INITIATIVE.idlePollMs).toBe(5_000);
    expect(DEFAULT_INITIATIVE.memoryImportance).toBe(5);
    expect(DEFAULT_INITIATIVE.memoryGapMs).toBe(20 * MINUTE);
  });
});
