/**
 * WP1 — the REAL library contract.
 *
 * Round 15 shipped 22 green tests around goals that would have crashed the real pathfinder
 * on the first tick. The controller handed `setGoal` a plain object, mineflayer-pathfinder
 * 2.4.5 called `goal.isValid()` on the next `physicsTick`, and that became an
 * uncaughtException — Elix quits, reconnects, and six times in a minute is a crash burst.
 *
 * A fake that accepts what the library rejects is worse than no test, because it reports
 * success. So these tests build goals through the library itself and then make the four
 * calls the library makes on every tick, plus `setGoal`'s own argument handling.
 *
 * If a future goal type is added to the controller, add it HERE too — the point of this file
 * is that the controller's output is checked by the consumer, not by the author's intent
 * object.
 */
import { describe, expect, it } from "vitest";
import { Vec3 } from "vec3";
import { requirePathfinder } from "../../src/connection/bot.js";
import { FollowController, realGoalFactory, type GoalFactory } from "../../src/actions/follow.js";
import type { PathfinderLike } from "../../src/actions/follow.js";

/** The per-tick calls, copied from mineflayer-pathfinder 2.4.5's index.js. */
function perTick(goal: unknown): void {
  const g = goal as {
    isValid: () => boolean;
    hasChanged: () => boolean;
    heuristic: (n: Vec3) => number;
    isEnd: (n: Vec3) => number | boolean;
    tick?: (n: Vec3) => void;
  };
  const node = new Vec3(0, 65, 0);
  expect(typeof g.isValid, "isValid must exist").toBe("function");
  g.isValid();
  g.hasChanged();
  g.heuristic(node);
  g.isEnd(node);
  if (typeof g.tick === "function") g.tick(node);
}

/** A mineflayer Entity, with the fields the library actually reads. */
function entity(x: number, z = 0) {
  return {
    username: "Steve",
    id: 7,
    position: new Vec3(x, 65, z),
    velocity: new Vec3(0, 0, 0),
    isValid: true,
    height: 1.8,
    width: 0.6,
    type: "player",
    name: "Steve",
  };
}

function recorder(): PathfinderLike & { goals: unknown[]; stops: number } {
  const box = { goals: [] as unknown[], stops: 0 };
  return {
    get goals() {
      return box.goals;
    },
    get stops() {
      return box.stops;
    },
    setGoal: (g: unknown) => box.goals.push(g),
    stop: () => {
      box.stops += 1;
    },
  } as PathfinderLike & { goals: unknown[]; stops: number };
}

const factory: GoalFactory = realGoalFactory(() => requirePathfinder() as never);

describe("WP1 — the real library, not a description of it", () => {
  it("mineflayer-pathfinder exports the goal classes the controller uses", () => {
    const { goals } = requirePathfinder();
    // This assertion is the one that would have caught U1. A TYPE that lists fewer goal
    // classes than the library has is how `new undefined(entity, 3)` gets written.
    expect(typeof goals.GoalFollow).toBe("function");
    expect(typeof goals.GoalNear).toBe("function");
  });

  it("a GoalFollow from the factory survives the per-tick calls", () => {
    const goal = factory.follow(entity(6), 3);
    expect(() => perTick(goal)).not.toThrow();
    const g = goal as { entity?: unknown; rangeSq?: number };
    // The library's own field names, not ours.
    expect(g.entity).toBeDefined();
    expect(g.rangeSq).toBe(9);
  });

  it("a GoalNear from the factory survives the per-tick calls", () => {
    const goal = factory.near(12, 65, -4, 2);
    expect(() => perTick(goal)).not.toThrow();
    const g = goal as { x?: number; y?: number; z?: number };
    expect(g.x).toBe(12);
    expect(g.y).toBe(65);
    expect(g.z).toBe(-4);
  });

  it("the controller hands the pathfinder a goal that runs, for BOTH commands", () => {
    const p = recorder();
    const c = new FollowController(p, () => 1000, factory);

    expect(c.follow(entity(6), "Steve").ok).toBe(true);
    expect(p.goals).toHaveLength(1);
    expect(() => perTick(p.goals[0])).not.toThrow();

    expect(c.come({ x: 9, y: 65, z: -3 }).ok).toBe(true);
    expect(p.goals).toHaveLength(2);
    expect(() => perTick(p.goals[1])).not.toThrow();
  });

  it("a goal the library rejects never reaches setGoal", () => {
    // The failure mode U1 turned into a crash: an unbuildable goal handed over anyway.
    const p = recorder();
    const broken: GoalFactory = {
      follow: () => {
        throw new Error("no such goal class");
      },
      near: () => {
        throw new Error("no such goal class");
      },
    };
    const c = new FollowController(p, () => 1000, broken);
    const got = c.follow(entity(6), "Steve");
    expect(got.ok).toBe(false);
    expect(String(got.reason)).toMatch(/goal-build-failed/);
    expect(p.goals).toHaveLength(0);
    // And canBuildGoals reports it rather than discovering it on the next tick.
    expect(c.canBuildGoals()).toBe(false);
  });

  it("the real factory reports that it can build goals", () => {
    const c = new FollowController(recorder(), () => 1000, factory);
    expect(c.canBuildGoals()).toBe(true);
  });

  it("GoalFollow reads entity.position, so an entity without one cannot be followed", () => {
    // Documented as a property of the LIBRARY, not of our controller: this is exactly the
    // throw the constructor does, and the controller turns it into a refusal.
    const { goals } = requirePathfinder();
    expect(() => new goals.GoalFollow({}, 3)).toThrow();
    const p = recorder();
    const c = new FollowController(p, () => 1000, factory);
    // The controller's own guard catches it first, which is the nicer error.
    expect(c.follow(null, "Steve").reason).toBe("target-not-tracked");
  });
});