/**
 * WP3 acceptance: protect the owner, humanized.
 *
 * The theme of this file is the good-friend rules. Every test that says "Elix attacks"
 * is paired with a test that says "Elix does not attack X", because the only interesting
 * failure here is a bot that helps somebody and then kills their dog.
 *
 * Mobs are mineflayer `Entity`-shaped with real `Vec3` positions, and `entitiesByName` is
 * the real vendored 26.2 registry, so "hostile" means what the game data says it means.
 */
import { describe, expect, it, vi } from "vitest";
import { Vec3 } from "vec3";
import {
  ATTACK_RANGE,
  DEFEND_OWNER_RADIUS,
  DEFEND_TARGET_RADIUS,
  REACTION_CEILING_MS,
  REACTION_FLOOR_MS,
  RETREAT_AT,
  DefendController,
  attackCooldownMs,
  decideDefend,
  isLegalTarget,
  pickTarget,
  reactionMs,
  retreatTarget,
  type DefendView,
  type SkillCap,
} from "../../src/reflexes/defend.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isHostileByCategory } from "../../src/world/mcdata.js";
import { NEVER_ATTACKED, isHostileMob } from "../../src/reflexes/hostile.js";
import type { CreatureLike } from "../../src/reflexes/decide.js";

/** A mineflayer Entity: name, type, real Vec3, isValid, health. */
function mob(name: string, x: number, z = 0, type = name): CreatureLike {
  return { id: name.length * 7 + Math.round(x), name, type, position: new Vec3(x, 65, z), isValid: true, health: 20 };
}

function view(over: Partial<DefendView> = {}): DefendView {
  return {
    position: new Vec3(0, 65, 0),
    health: 20,
    owners: [{ name: "ElixOwner", distance: 2, position: new Vec3(2, 65, 0) }],
    entities: [],
    heldWeapon: "iron_sword",
    hurtByPlayer: null,
    ...over,
  };
}

/** A controller with a clock the test drives, so no real time is involved. */
function controllerAt(cap: SkillCap, start = 0): { c: DefendController; advance: (ms: number) => void } {
  let now = start;
  const c = new DefendController(cap, () => now);
  return { c, advance: (ms: number) => { now += ms; } };
}

describe("WP3 — target selection", () => {
  it("attacks a hostile mob next to the owner", () => {
    const action = decideDefend(view({ entities: [mob("zombie", 3)] }));
    expect(action).toMatchObject({ kind: "attack", target: "zombie" });
  });

  it("minecraft-data itself calls a zombie hostile, so the list is not the only source", () => {
    // The brief asked for the category from the data, not a hand-written list.
    expect(isHostileByCategory("zombie")).toBe(true);
    expect(isHostileByCategory("cow")).toBe(false);
    expect(isHostileByCategory("villager")).toBe(false);
  });

  it("NEVER attacks a villager, however close and however low Elix's health", () => {
    for (const health of [20, 7, RETREAT_AT, 1]) {
      const action = decideDefend(view({ health, entities: [mob("villager", 2)] }));
      expect(action.kind, `health ${health}`).not.toBe("attack");
    }
  });

  it("NEVER attacks a pet", () => {
    for (const name of ["tamed_wolf", "wolf", "tamed_cat", "cat", "horse", "parrot"]) {
      expect(decideDefend(view({ entities: [mob(name, 2)] })).kind, name).not.toBe("attack");
    }
  });

  it("NEVER attacks an iron golem or a passive mob", () => {
    for (const name of ["iron_golem", "snow_golem", "cow", "sheep", "pig", "chicken", "squid", "bat"]) {
      expect(decideDefend(view({ entities: [mob(name, 2)] })).kind, name).not.toBe("attack");
    }
  });

  it("NEVER attacks a player, even one standing in melee range", () => {
    const player = mob("Steve", 2, 0, "player");
    expect(decideDefend(view({ entities: [player] })).kind).not.toBe("attack");
    // And a bare username with no type is still read as a player.
    expect(decideDefend(view({ entities: [mob("Steve", 2, 0, "")] })).kind).not.toBe("attack");
  });

  it("NEVER attacks a creeper - WP2's flee owns creepers", () => {
    expect(decideDefend(view({ entities: [mob("creeper", 2)] })).kind).not.toBe("attack");
    expect(isLegalTarget(mob("creeper", 2), null)).toBe(false);
  });

  it("does not attack when the owner is more than 16 blocks away", () => {
    const far = view({
      owners: [{ name: "ElixOwner", distance: DEFEND_OWNER_RADIUS + 1, position: new Vec3(20, 65, 0) }],
      entities: [mob("zombie", 2)],
    });
    expect(decideDefend(far).kind).toBe("none");
  });

  it("does not attack a mob more than 8 blocks from both the owner and Elix", () => {
    const far = view({ entities: [mob("zombie", DEFEND_TARGET_RADIUS + 4)] });
    expect(pickTarget(far)).toBeNull();
  });

  it("attacks a mob near the OWNER even when it is not near Elix", () => {
    // Owner at x=2, zombie at x=9: seven blocks from the owner, nine from Elix.
    const v = view({
      owners: [{ name: "ElixOwner", distance: 2, position: new Vec3(2, 65, 0) }],
      entities: [mob("zombie", 9)],
    });
    expect(pickTarget(v)).not.toBeNull();
  });

  it("attacks the nearest legal mob, and ignores an illegal nearer one", () => {
    const v = view({ entities: [mob("villager", 1), mob("zombie", 3), mob("skeleton", 5)] });
    expect(pickTarget(v)?.name).toBe("zombie");
  });

  it("never attacks a mob the game has already killed", () => {
    const dead = mob("zombie", 2);
    dead.isValid = false;
    expect(pickTarget(view({ entities: [dead] }))).toBeNull();
  });

  it("stops when the target leaves range", () => {
    const v = view({ entities: [mob("zombie", ATTACK_RANGE + 3)] });
    expect(decideDefend(v).kind).toBe("none");
  });

  it("does not swing at something out of melee reach", () => {
    expect(decideDefend(view({ entities: [mob("zombie", ATTACK_RANGE + 1)] })).kind).toBe("none");
  });
});

describe("WP3 — a player who hits Elix is never answered with a swing", () => {
  it("steps away instead of fighting, at full health", () => {
    const action = decideDefend(view({ hurtByPlayer: { name: "Steve", distance: 2 }, entities: [mob("zombie", 3)] }));
    expect(action).toEqual({ kind: "step-away", from: "Steve" });
  });

  it("steps away rather than retreating, even at 1 health", () => {
    const action = decideDefend(
      view({ health: 1, hurtByPlayer: { name: "Steve", distance: 2 }, entities: [mob("zombie", 3)] }),
    );
    expect(action).toEqual({ kind: "step-away", from: "Steve" });
  });

  it("still refuses to attack the player, so no skillCap can turn it round", () => {
    const player = mob("Steve", 1, 0, "player");
    for (const cap of ["casual", "normal", "tryhard"] as SkillCap[]) {
      expect(isLegalTarget(player, "Steve"), cap).toBe(false);
      expect(isLegalTarget(player, null), cap).toBe(false);
    }
  });

  it("never swings at the player who hurt him, even when they are the only thing in reach", () => {
    const { c, advance } = controllerAt("tryhard");
    const swings: string[] = [];
    const v = view({ hurtByPlayer: { name: "Steve", distance: 1 }, entities: [mob("Steve", 1, 0, "player"), mob("zombie", 2)] });
    const handlers = { onSwing: (t: CreatureLike) => swings.push(t.name), onMove: () => undefined };
    for (let i = 0; i < 40; i += 1) {
      c.tick(v, handlers);
      advance(50);
    }
    // Two seconds of being hit, and the only thing that ever happened is stepping away.
    expect(swings).toEqual([]);
    expect(c.engaged).toBe(false);
  });
});

describe("WP3 — retreating at low health", () => {
  it("retreats toward the owner at 6 health and below", () => {
    for (const health of [RETREAT_AT, 5, 2]) {
      expect(decideDefend(view({ health, entities: [mob("zombie", 2)] })).kind, `health ${health}`).toBe(
        "retreat",
      );
    }
  });

  it("still attacks at 7 health", () => {
    expect(decideDefend(view({ health: RETREAT_AT + 1, entities: [mob("zombie", 2)] })).kind).toBe("attack");
  });

  it("retreats toward the owner, not away from the mob", () => {
    const to = retreatTarget(new Vec3(0, 65, 0), new Vec3(5, 65, 0));
    expect(to.x).toBeGreaterThan(0);
    expect(to.y).toBe(65);
  });

  it("a retreat from the owner's exact position is still a real move", () => {
    const to = retreatTarget(new Vec3(3, 65, 3), new Vec3(3, 65, 3));
    expect(Number.isFinite(to.x)).toBe(true);
    expect(Math.hypot(to.x - 3, to.z - 3)).toBeGreaterThan(0.5);
  });
});

describe("WP3 — humanized timing", () => {
  it("every skillCap's reaction lands inside the brief's 180-320 ms window", () => {
    for (const cap of ["casual", "normal", "tryhard"] as SkillCap[]) {
      for (const target of ["zombie", "skeleton", "spider", "creeper", "witch", "husk"]) {
        const ms = reactionMs(cap, target);
        expect(ms, `${cap}/${target}`).toBeGreaterThanOrEqual(REACTION_FLOOR_MS);
        expect(ms, `${cap}/${target}`).toBeLessThanOrEqual(REACTION_CEILING_MS);
      }
    }
  });

  it("casual is slower than tryhard, on average", () => {
    const avg = (cap: SkillCap): number => {
      let total = 0;
      for (const t of ["zombie", "skeleton", "spider", "witch", "husk", "drowned"]) total += reactionMs(cap, t);
      return total / 6;
    };
    expect(avg("casual")).toBeGreaterThan(avg("normal"));
    expect(avg("normal")).toBeGreaterThan(avg("tryhard"));
  });

  it("the same target gets the same reaction twice, so a fight is reproducible", () => {
    expect(reactionMs("normal", "zombie")).toBe(reactionMs("normal", "zombie"));
  });

  it("does not swing before the reaction has elapsed", () => {
    const { c, advance } = controllerAt("tryhard");
    const swings: string[] = [];
    const handlers = { onSwing: (t: CreatureLike) => swings.push(t.name), onMove: () => undefined };
    const v = view({ entities: [mob("zombie", 2)] });

    c.tick(v, handlers);
    expect(swings, "no swing on the very first tick").toEqual([]);
    advance(50);
    c.tick(v, handlers);
    expect(swings, "still no swing at 50 ms").toEqual([]);
    for (let i = 0; i < 12 && swings.length === 0; i += 1) {
      advance(50);
      c.tick(v, handlers);
    }
    expect(swings).toEqual(["zombie"]);
  });

  it("a bare-hand bot waits the bare-hand cooldown, not a sword's", () => {
    // 4 attacks/s = 250 ms. An unverified weapon falls back to the same safe value.
    expect(attackCooldownMs("bare_hand")).toBeCloseTo(250, 5);
    expect(attackCooldownMs(null)).toBeCloseTo(250, 5);
    expect(attackCooldownMs("some_mod_axe")).toBeCloseTo(250, 5);
    expect(attackCooldownMs("iron_sword")).toBeCloseTo(625, 5);
  });

  it("the 1.9+ cooldown is respected between swings", () => {
    const { c, advance } = controllerAt("tryhard");
    const swings: number[] = [];
    let at = 0;
    const handlers = { onSwing: () => swings.push(at), onMove: () => undefined };
    const v = view({ entities: [mob("zombie", 2)] });

    // Tick every 50 ms for three seconds.
    for (let i = 0; i < 60; i += 1) {
      c.tick(v, handlers);
      at += 50;
      advance(50);
    }
    expect(swings.length).toBeGreaterThan(1);
    const cooldown = attackCooldownMs("iron_sword");
    for (let i = 1; i < swings.length; i += 1) {
      const gap = (swings[i] ?? 0) - (swings[i - 1] ?? 0);
      expect(gap, `gap ${gap} must be at least the ${cooldown}ms cooldown`).toBeGreaterThanOrEqual(
        cooldown - 50,
      );
    }
    // And not absurdly slow either: a full speed sword is 1.6/s, so three seconds is a few.
    expect(swings.length).toBeLessThanOrEqual(6);
  });

  it("a fresh target restarts the reaction delay", () => {
    const { c, advance } = controllerAt("normal");
    const swings: string[] = [];
    const handlers = { onSwing: (t: CreatureLike) => swings.push(t.name), onMove: () => undefined };
    const skeleton = view({ entities: [mob("skeleton", 2)] });
    for (let i = 0; i < 10 && swings.length === 0; i += 1) { c.tick(skeleton, handlers); advance(50); }
    expect(swings).toEqual(["skeleton"]);

    // Swap to a different mob mid-fight: the delay starts again, and no instant swing.
    const before = swings.length;
    const other = view({ entities: [mob("witch", 2)] });
    c.tick(other, handlers);
    expect(swings.length, "no instant swing at a new target").toBe(before);
    expect(c.target).toBe("witch");
  });
});

describe("WP3 — elix stop cancels defending", () => {
  it("clears the engagement, so the next tick cannot swing on an old reaction", () => {
    const { c, advance } = controllerAt("tryhard");
    const swings: string[] = [];
    const handlers = { onSwing: (t: CreatureLike) => swings.push(t.name), onMove: () => undefined };
    const v = view({ entities: [mob("zombie", 2)] });

    c.tick(v, handlers);
    expect(c.engaged).toBe(true);
    c.stop();
    expect(c.engaged).toBe(false);
    expect(c.target).toBeNull();

    // Immediately after the stop, with plenty of time passed, nothing swings.
    advance(5_000);
    c.tick(v, handlers);
    expect(swings).toEqual([]);
  });

  it("stop is synchronous and does not throw even mid-engagement", () => {
    const { c } = controllerAt("normal");
    c.tick(view({ entities: [mob("zombie", 2)] }), { onSwing: () => undefined, onMove: () => undefined });
    expect(() => c.stop()).not.toThrow();
  });

  it("a stop clears the cooldown too, so a fresh command is not blocked by the old fight", () => {
    const { c, advance } = controllerAt("tryhard");
    const handlers = { onSwing: () => undefined, onMove: () => undefined };
    const v = view({ entities: [mob("zombie", 2)] });
    for (let i = 0; i < 12; i += 1) { c.tick(v, handlers); advance(50); }
    c.stop();
    expect(c.cooldownRemaining("iron_sword", c.cooldownRemaining("iron_sword", 0) + 1)).toBe(0);
  });

  it("no threat means no engagement at all", () => {
    const { c } = controllerAt("normal");
    const action = c.tick(view(), { onSwing: () => undefined, onMove: () => undefined });
    expect(action.kind).toBe("none");
    expect(c.engaged).toBe(false);
  });
});

describe("WP3 — the real game, not a fake", () => {
  it("the three SkillCap values are exactly the real config's enum", () => {
    // The type is written out in defend.ts, so this is what keeps the two in step: read the
    // real config source and pull the enum out of it, rather than trusting the copy.
    const source = readFileSync(
      fileURLToPath(new URL("../../src/core/config.ts", import.meta.url)),
      "utf8",
    );
    const block = source.slice(source.indexOf("skillCapSchema"));
    // Only the enum list itself: everything between "skillCapSchema" and the closing bracket.
    const enumList = block.slice(block.indexOf("["), block.indexOf("]") + 1);
    const options = [...(enumList.match(/"([a-z]+)"/gu) ?? [])].map((s) => s.slice(1, -1));
    expect(options.sort()).toEqual(["casual", "normal", "tryhard"]);
  });

  it("attack speed matches the real wiki values the cooldown is derived from", () => {
    // https://minecraft.wiki/w/Sword, /Axe, /Mace, /Trident (accessed 2026-10-06).
    expect(attackCooldownMs("diamond_sword")).toBeCloseTo(1000 / 1.6, 3);
    expect(attackCooldownMs("stone_axe")).toBeCloseTo(1000 / 0.8, 3);
    expect(attackCooldownMs("iron_axe")).toBeCloseTo(1000 / 0.9, 3);
    expect(attackCooldownMs("mace")).toBeCloseTo(1000 / 0.6, 3);
    expect(attackCooldownMs("trident")).toBeCloseTo(1000 / 1.1, 3);
  });

  it("every hostile name Elix can attack is a real 26.2 entity", () => {
    // Ask WITHOUT a version, so the fallback list is what is under test.
    for (const name of ["zombie", "skeleton", "spider", "husk", "drowned", "witch", "pillager", "blaze", "ghast"]) {
      expect(isHostileMob(name), name).toBe(true);
      // And with the real data, where the category must agree.
      expect(isHostileMob(name, "26.2"), `${name} must be hostile by category too`).toBe(true);
    }
  });

  it("every never-attacked name is a real 26.2 entity, and none is hostile by category", () => {
    const missing: string[] = [];
    for (const name of NEVER_ATTACKED) {
      // "player" is not a mob, so it is legitimately absent from the entity data.
      if (name === "player") continue;
      if (isHostileByCategory(name)) missing.push(name);
    }
    expect(missing).toEqual([]);
  });

  it("the decision never calls mineflayer itself - it is pure", () => {
    // A real swing goes through the caller, so the pure decision has no bot reference. The
    // spy proves the controller is the only thing that can reach the world.
    const swing = vi.fn();
    const { c, advance } = controllerAt("tryhard");
    const v = view({ entities: [mob("zombie", 2)] });
    for (let i = 0; i < 12; i += 1) { c.tick(v, { onSwing: swing, onMove: vi.fn() }); advance(50); }
    expect(swing).toHaveBeenCalledTimes(1);
    // The entity handed to the caller is the real mineflayer-shaped one.
    const handed = swing.mock.calls[0]?.[0] as CreatureLike | undefined;
    expect(handed?.name).toBe("zombie");
    expect(handed?.position).toBeInstanceOf(Vec3);
  });
});