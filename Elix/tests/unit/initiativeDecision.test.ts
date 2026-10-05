/**
 * Round 13 B — the initiative DECISION, one branch at a time.
 *
 * `shouldInitiate()` is the policy table and is tested in `initiative.test.ts`. This file
 * tests the layer above it: the thing that turns the world (who is online, how far away,
 * what is in flight, when anything last happened) into one decision and one named reason.
 *
 * The reason strings are the point. `shouldInitiate` returns a boolean, which is all a
 * boolean can say; `decideInitiative` returns WHY, and an owner watching a bot that
 * speaks or does not speak needs the why far more than the what. Each refusal below is
 * therefore a distinct test rather than a table row, because two refusals sharing a
 * message would be indistinguishable in a log and useless in a bug report.
 *
 * Zero network, zero clock, no bot. Every time is passed in.
 */
import { describe, expect, it } from "vitest";
import {
  INITIATIVE_LINES,
  decideInitiative,
  distance,
  nearestPlayer,
  nextShape,
  type InitiativeContext,
} from "../../src/connection/initiative.js";
import { DEFAULT_INITIATIVE } from "../../src/social/manners.js";

const MINUTE = 60_000;
const NOW = 100 * MINUTE;

const HERE = { x: 0, y: 64, z: 0 };

const BASE: InitiativeContext = {
  thresholds: DEFAULT_INITIATIVE,
  players: {
    Elix: { position: HERE },
    Steve: { position: { x: 3, y: 64, z: 4 } }, // 5 blocks
  },
  selfName: "Elix",
  selfPosition: HERE,
  now: NOW,
  busy: false,
  pendingAuditNearby: false,
  lastInitiativeAt: 0,
  lastWellbeingAt: new Map(),
  lastMemoryCallbackAt: new Map(),
  idleBudgetUsed: 0,
  shutdown: false,
  recallImportant: () => null,
};

const decide = (patch: Partial<InitiativeContext> = {}, shape: Parameters<typeof decideInitiative>[1] = "question-about-their-day") =>
  decideInitiative({ ...BASE, ...patch }, shape, "connection");

describe("B — nearest player is measured, not assumed", () => {
  it("distance is straight-line", () => {
    expect(distance({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0 })).toBe(5);
  });

  it("picks the closest player who is not Elix", () => {
    const ctx = {
      ...BASE,
      players: {
        Elix: { position: HERE },
        Steve: { position: { x: 12, y: 64, z: 0 } },
        Alex: { position: { x: 2, y: 64, z: 0 } },
      },
    };
    expect(nearestPlayer(ctx)?.name).toBe("Alex");
  });

  it("returns null when nobody else is online", () => {
    expect(nearestPlayer({ ...BASE, players: { Elix: { position: HERE } } })).toBeNull();
  });

  it("returns null when Elix has no position yet", () => {
    // Rather than treating himself as 0,0,0 and speaking to whoever is at spawn.
    expect(nearestPlayer({ ...BASE, selfPosition: undefined })).toBeNull();
  });
});

describe("B — every refusal, named", () => {
  it("disabled by config", () => {
    expect(decide({ thresholds: { ...DEFAULT_INITIATIVE, enabled: false } }).reason).toBe("disabled");
  });

  it("shutting down", () => {
    expect(decide({ shutdown: true }).reason).toBe("shutdown");
  });

  it("busy: a reply is in flight", () => {
    expect(decide({ busy: true }).reason).toBe("busy");
  });

  it("nobody online", () => {
    expect(decide({ players: { Elix: { position: HERE } } }).reason).toBe("nobody-online");
  });

  it("the nearest player is too far away", () => {
    const ctx = { ...BASE, players: { Elix: { position: HERE }, Steve: { position: { x: 17, y: 64, z: 0 } } } };
    expect(decide(ctx).reason).toBe("too-far");
  });

  it("exactly at nearbyBlocks is close enough", () => {
    // 16 is allowed. A bot that needs to be strictly nearer has a different rule from
    // the one the config says, and the config is what an owner edits.
    const ctx = { ...BASE, players: { Elix: { position: HERE }, Steve: { position: { x: 16, y: 64, z: 0 } } } };
    expect(decide(ctx).speak).toBe(true);
  });

  it("an audit is in flight for a nearby player", () => {
    expect(decide({ pendingAuditNearby: true }).reason).toBe("audit-pending");
  });

  it("the hourly idle budget is spent", () => {
    expect(decide({ idleBudgetUsed: 60 }).reason).toBe("no-budget");
  });

  it("too soon after the last unprompted line", () => {
    expect(decide({ lastInitiativeAt: NOW - DEFAULT_INITIATIVE.minGapMs + 1 }).reason).toBe("too-soon");
  });

  it("a wellbeing check-in to this player is still inside its quiet window", () => {
    const ctx = { ...BASE, lastWellbeingAt: new Map([["Steve", NOW - 19 * MINUTE]]) };
    expect(decide(ctx).reason).toBe("inside-wellbeing-quiet-window");
  });

  it("and allowed again once that window passes", () => {
    const ctx = { ...BASE, lastWellbeingAt: new Map([["Steve", NOW - 21 * MINUTE]]) };
    expect(decide(ctx).speak).toBe(true);
  });

  it("the quiet window is per player, not global", () => {
    // A check-in to Alex must not silence Elix to Steve.
    const ctx = { ...BASE, lastWellbeingAt: new Map([["Alex", NOW - 1 * MINUTE]]) };
    expect(decide(ctx).speak).toBe(true);
  });

  it("a memory callback with nothing to recall changes shape rather than speaking", () => {
    // Declining is right: falling through to a proposal would quietly make the
    // round-robin lie about what shape it was on.
    expect(decide({}, "memory-callback").reason).toBe("no-memory");
  });

  it("a configured quiet window is honoured instead of a hard-coded one", () => {
    const ctx = {
      ...BASE,
      thresholds: { ...DEFAULT_INITIATIVE, wellbeingQuietMs: 60 * MINUTE },
      lastWellbeingAt: new Map([["Steve", NOW - 30 * MINUTE]]),
    };
    expect(decide(ctx).reason).toBe("inside-wellbeing-quiet-window");
  });
});

describe("B — the yes case", () => {
  it("speaks once, to the nearest player, and says why", () => {
    const got = decide();
    expect(got.speak).toBe(true);
    expect(got.reason).toBe("ok");
    expect(got.target).toBe("Steve");
    expect(got.shape).toBe("question-about-their-day");
    expect(got.line).toBe("how is your day going so far, Steve?");
  });
});

describe("B — the four shapes", () => {
  it("a memory callback quotes the memory and only at the configured importance", () => {
    const seen: Array<[string, number]> = [];
    const ctx = {
      ...BASE,
      recallImportant: (player: string, importance: number) => {
        seen.push([player, importance]);
        return "the cave base";
      },
    };
    const got = decideInitiative(ctx, "memory-callback", "competence");
    expect(got.speak).toBe(true);
    expect(got.line).toContain("the cave base");
    expect(seen).toEqual([["Steve", DEFAULT_INITIATIVE.memoryImportance]]);
  });

  it("none of the four lines claims a feeling about Elix himself", () => {
    // C4, and stricter here than in a reply: nobody asked for this line either.
    for (const shape of ["question-about-their-day", "open-promise", "activity-proposal"] as const) {
      const line = INITIATIVE_LINES[shape]("Steve");
      expect(line, shape).not.toMatch(/\bi (?:feel|care|miss|love|hate|am happy|am sad|get sad)\b/i);
    }
  });

  it("the round-robin covers all four shapes and skips the callback without memory", () => {
    const withMemory = [0, 1, 2, 3].map((n) => nextShape(n, true));
    expect(new Set(withMemory).size).toBe(4);
    const without = [0, 1, 2, 3, 4].map((n) => nextShape(n, false));
    expect(without).not.toContain("memory-callback");
    expect(new Set(without).size).toBe(3);
  });

  it("every line is short enough to read mid-game", () => {
    for (const shape of ["question-about-their-day", "open-promise", "activity-proposal"] as const) {
      expect(INITIATIVE_LINES[shape]("Steve").length, shape).toBeLessThanOrEqual(120);
    }
  });
});
