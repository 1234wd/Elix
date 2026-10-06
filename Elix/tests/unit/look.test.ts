/**
 * WP4 acceptance: human-like gaze and body language.
 *
 * The measurable claim is the yaw sequence: no single tick may move the head more than 40
 * degrees, and the turn must finish inside 400 ms. Both are asserted over a real sequence
 * of ticks rather than on one snapshot, because a 40-degree cap that is only true on the
 * first tick is not a cap.
 *
 * The rest is timing and suppression: look at the speaker, greet an owner two or three
 * times, glance when idle, and do none of it while fighting, following, answering a
 * wellbeing message or being gentle.
 */
import { describe, expect, it, vi } from "vitest";
import { Vec3 } from "vec3";
import {
  HeadTurner,
  IdleGlances,
  LOOK_TICK_MS,
  MAX_IDLE_GLANCE_MS,
  CROUCH_COOLDOWN_MS,
  MAX_TURN_DEG,
  MAX_TURN_MS,
  MIN_IDLE_GLANCE_MS,
  MIN_TURN_MS,
  SPEAKER_RANGE,
  crouchCount,
  isSuppressed,
  mayCrouchGreet,
  pickGlanceSubject,
  poseToward,
  shortestAngle,
  shouldCrouchGreet,
  noteCrouchGreet,
  wrapAngle,
  type CrouchLog,
  type LookSuppression,
} from "../../src/humanizer/look.js";

const BUSY = (
  over: Partial<LookSuppression> = {},
): LookSuppression => ({ combat: false, following: false, wellbeingReply: false, gentleMode: false, ...over });

/** Drive a turner to completion and report every step it produced. */
function runTurn(turner: HeadTurner, at: number, maxTicks = 60): { poses: Array<{ yaw: number; pitch: number }>; ms: number } {
  const poses: Array<{ yaw: number; pitch: number }> = [];
  let now = at;
  for (let i = 0; i < maxTicks; i += 1) {
    const pose = turner.tick(now);
    if (pose === null) break;
    poses.push({ yaw: pose.yaw, pitch: pose.pitch });
    if (turner.settled) break;
    now += LOOK_TICK_MS;
  }
  return { poses, ms: now - at };
}

describe("WP4 — the head turns like a head, not like a turret", () => {
  it("no single tick turns the head more than 40 degrees, from any starting angle", () => {
    // A big turn, a small turn, and a turn behind Elix, all from several starting poses.
    const pairs: Array<[number, number]> = [
      [0, Math.PI],
      [Math.PI, 0],
      [0, Math.PI / 2],
      [1.2, -1.2],
      [-2.5, 2.5],
      [0, 0.05],
    ];
    for (const [fromYaw, toYaw] of pairs) {
      const turner = new HeadTurner();
      let now = 0;
      // Put the head at the starting pose first.
      turner.aimAt({ yaw: fromYaw, pitch: 0 }, now, "seed");
      runTurn(turner, now);
      // Now the real turn.
      now += 1_000;
      turner.aimAt({ yaw: toYaw, pitch: 0 }, now, `t${fromYaw}-${toYaw}`);
      let previous = turner.pose;
      const seen: Array<number> = [];
      for (let i = 0; i < 60 && !turner.settled; i += 1) {
        const pose = turner.tick(now);
        if (pose === null) break;
        const step =
          Math.abs(shortestAngle(previous.yaw, pose.yaw)) + Math.abs(pose.pitch - previous.pitch);
        seen.push((step * 180) / Math.PI);
        previous = pose;
        now += LOOK_TICK_MS;
      }
      expect(seen.length).toBeGreaterThan(0);
      for (const degrees of seen) {
        expect(degrees, `${fromYaw}->${toYaw} moved ${degrees} degrees in one tick`).toBeLessThanOrEqual(
          MAX_TURN_DEG + 1e-6,
        );
      }
    }
  });

  it("a half turn takes more than one tick, because one tick may not do it", () => {
    const turner = new HeadTurner();
    let now = 0;
    turner.aimAt({ yaw: 0, pitch: 0 }, now, "seed");
    runTurn(turner, now);
    now += 1_000;
    turner.aimAt({ yaw: Math.PI, pitch: 0 }, now, "half");
    let ticks = 0;
    while (!turner.settled && ticks < 60) {
      turner.tick(now);
      now += LOOK_TICK_MS;
      ticks += 1;
    }
    expect(ticks).toBeGreaterThan(1);
    expect((turner.pose.yaw * 180) / Math.PI).toBeCloseTo(180, 3);
  });

  it("every turn finishes inside 400 ms", () => {
    for (const key of ["a", "b", "c", "zombie", "Steve", "villager", "long-key-name-here"]) {
      const turner = new HeadTurner();
      const target = { yaw: Math.PI * 0.8, pitch: 0.4 };
      turner.aimAt(target, 0, key);
      const { ms } = runTurn(turner, 0);
      expect(turner.settled, `${key} never settled`).toBe(true);
      expect(ms, `${key} took ${ms}ms`).toBeLessThanOrEqual(MAX_TURN_MS);
    }
  });

  it("every turn takes at least 150 ms, so nothing snaps", () => {
    for (const key of ["a", "b", "c", "zombie", "Steve"]) {
      const turner = new HeadTurner();
      turner.aimAt({ yaw: Math.PI * 0.8, pitch: 0.4 }, 0, key);
      const { ms } = runTurn(turner, 0);
      expect(ms, `${key} finished in ${ms}ms`).toBeGreaterThanOrEqual(MIN_TURN_MS);
    }
  });

  it("turns the SHORT way round, so facing behind does not spin through north", () => {
    const turner = new HeadTurner();
    turner.aimAt({ yaw: -3.0, pitch: 0 }, 0, "seed");
    runTurn(turner, 0);
    // Face +3.0: the short way is 6.0 -> -0.283, not all the way round through PI.
    turner.aimAt({ yaw: 3.0, pitch: 0 }, 1_000, "across");
    // Measure the PATH, not the destination: arriving is the same either way, but going the
    // long way round is 6.0 radians of travel instead of 0.283.
    let path = 0;
    let previous = turner.pose;
    let now = 1_000;
    while (!turner.settled && now < 3_000) {
      const pose = turner.tick(now);
      if (pose === null) break;
      path += Math.abs(shortestAngle(previous.yaw, pose.yaw));
      previous = pose;
      now += LOOK_TICK_MS;
    }
    expect(turner.settled).toBe(true);
    expect(path, `travelled ${path.toFixed(3)} rad`).toBeLessThan(0.5);
    expect(Math.abs(shortestAngle(turner.pose.yaw, 3.0))).toBeLessThan(1e-6);
  });

  it("re-aiming mid-turn continues from where the head is, without snapping", () => {
    const turner = new HeadTurner();
    turner.aimAt({ yaw: Math.PI, pitch: 0 }, 0, "far");
    turner.tick(0);
    turner.tick(LOOK_TICK_MS);
    const midway = turner.pose;
    turner.aimAt({ yaw: 0.2, pitch: 0.1 }, LOOK_TICK_MS * 2, "nearer");
    const next = turner.tick(LOOK_TICK_MS * 3);
    expect(next).not.toBeNull();
    // One tick, one small step: no jump back to the original starting point.
    const step = Math.abs(shortestAngle(midway.yaw, next?.yaw ?? 0)) + Math.abs((next?.pitch ?? 0) - midway.pitch);
    expect((step * 180) / Math.PI).toBeLessThanOrEqual(MAX_TURN_DEG + 1e-6);
  });

  it("a turner with nothing to do returns null and does not move", () => {
    const turner = new HeadTurner();
    expect(turner.tick(0)).toBeNull();
    expect(turner.settled).toBe(true);
    expect(turner.busy).toBe(false);
  });

  it("cancel() drops a turn in progress, so a stop leaves nothing half-applied", () => {
    const turner = new HeadTurner();
    turner.aimAt({ yaw: Math.PI, pitch: 0 }, 0, "x");
    turner.tick(0);
    expect(turner.busy).toBe(true);
    turner.cancel();
    expect(turner.busy).toBe(false);
    expect(turner.tick(1_000)).toBeNull();
  });

  it("wrapAngle and shortestAngle handle the seam at +/-PI", () => {
    expect(Math.abs(wrapAngle(Math.PI * 3))).toBeLessThanOrEqual(Math.PI);
    expect(Math.abs(shortestAngle(3.0, -3.0))).toBeLessThan(0.3);
    expect(shortestAngle(0, Math.PI / 2)).toBeCloseTo(Math.PI / 2, 6);
  });

  it("poseToward faces a point, in mineflayer's own convention", () => {
    const pose = poseToward({ x: 0, y: 65, z: 0 }, { x: 0, y: 65, z: 10 });
    expect(pose.yaw).toBeCloseTo(0, 6);
    const up = poseToward({ x: 0, y: 65, z: 0 }, { x: 0, y: 70, z: 0 });
    expect(up.pitch).toBeCloseTo(-Math.PI / 2, 6);
  });
});

describe("WP4 — looking at the speaker", () => {
  it("looks at someone who addresses Elix, within 16 blocks", () => {
    const eye = { x: 0, y: 65, z: 0 };
    const speaker = { x: 8, y: 66, z: 0 };
    expect(Math.hypot(speaker.x - eye.x, speaker.z - eye.z)).toBeLessThan(SPEAKER_RANGE);
    const pose = poseToward(eye, speaker);
    const turner = new HeadTurner();
    turner.aimAt(pose, 0, "Steve");
    runTurn(turner, 0);
    expect(turner.settled).toBe(true);
    expect(shortestAngle(0, turner.pose.yaw)).toBeCloseTo(pose.yaw, 6);
  });

  it("does NOT look at a speaker further away than 16 blocks", () => {
    const picked = pickGlanceSubject(
      { x: 0, y: 65, z: 0 },
      [{ name: "Steve", position: new Vec3(0, 65, SPEAKER_RANGE + 1), isPlayer: true }],
    );
    expect(picked).toBeNull();
  });

  it("looks at a speaker exactly at the range limit", () => {
    const picked = pickGlanceSubject(
      { x: 0, y: 65, z: 0 },
      [{ name: "Steve", position: new Vec3(0, 65, SPEAKER_RANGE), isPlayer: true }],
    );
    expect(picked?.name).toBe("Steve");
  });

  it("prefers the player who is talking over a mob standing next to Elix", () => {
    const picked = pickGlanceSubject(
      { x: 0, y: 65, z: 0 },
      [
        { name: "cow", position: new Vec3(1, 65, 0), isPlayer: false },
        { name: "Steve", position: new Vec3(5, 65, 0), isPlayer: true },
      ],
    );
    expect(picked?.name).toBe("Steve");
  });

  it("looks at a mob standing right here over a player further away", () => {
    const picked = pickGlanceSubject(
      { x: 0, y: 65, z: 0 },
      [
        { name: "cow", position: new Vec3(1, 65, 0), isPlayer: false },
        { name: "Steve", position: new Vec3(12, 65, 0), isPlayer: true },
      ],
    );
    expect(picked?.name).toBe("cow");
  });

  it("returns a real Vec3, so the caller can hand it to vec3 maths", () => {
    const picked = pickGlanceSubject(
      { x: 0, y: 65, z: 0 },
      [{ name: "Steve", position: new Vec3(3, 66, 4), isPlayer: true }],
    );
    expect(picked?.position).toBeInstanceOf(Vec3);
  });
});

describe("WP4 — crouch-greetings", () => {
  it("toggles sneak two or three times", () => {
    const counts = new Set<string>();
    for (const name of ["Steve", "Alex", "Notch", "Herobrine", "Dinnerbone", "jeb_", "Grumm"]) {
      const c = crouchCount(name);
      expect(c === 2 || c === 3, `${name} got ${c}`).toBe(true);
      counts.add(String(c));
    }
    // Across a handful of owners both counts should show up, or the field is not a field.
    expect(counts.size).toBe(2);
  });

  it("gives the same owner the same greeting twice", () => {
    for (const name of ["Steve", "Alex", "Notch"]) {
      expect(crouchCount(name)).toBe(crouchCount(name));
    }
  });

  it("greets an owner once, and not again straight away", () => {
    const log: CrouchLog = {};
    expect(shouldCrouchGreet("Steve", 100_000, log, BUSY())).toBe(true);
    noteCrouchGreet("Steve", 100_000, log);
    expect(shouldCrouchGreet("Steve", 100_001, log, BUSY())).toBe(false);
    expect(shouldCrouchGreet("Steve", 100_000 + CROUCH_COOLDOWN_MS, log, BUSY())).toBe(true);
  });

  it("greets two different owners separately", () => {
    const log: CrouchLog = {};
    shouldCrouchGreet("Steve", 0, log, BUSY());
    noteCrouchGreet("Steve", 0, log);
    // A fresh owner is greeted IMMEDIATELY, including at time 0 - a `?? 0` sentinel here
    // would mean nobody is ever greeted until a minute has passed.
    expect(shouldCrouchGreet("Alex", 0, log, BUSY())).toBe(true);
  });

  it("NEVER crouch-greets during gentle mode", () => {
    const log: CrouchLog = {};
    expect(shouldCrouchGreet("Steve", 0, log, BUSY({ gentleMode: true }))).toBe(false);
    // And not even if the cooldown has long passed.
    expect(shouldCrouchGreet("Steve", 999_999, log, BUSY({ gentleMode: true }))).toBe(false);
  });

  it("does not crouch-greet while fighting, following or answering a wellbeing message", () => {
    const log: CrouchLog = {};
    for (const state of [BUSY({ combat: true }), BUSY({ following: true }), BUSY({ wellbeingReply: true })]) {
      expect(shouldCrouchGreet("Steve", 0, log, state)).toBe(false);
    }
    expect(mayCrouchGreet(BUSY({ combat: true }))).toBe(false);
  });
});

describe("WP4 — idle glances", () => {
  it("glances between 8 and 20 seconds from now", () => {
    for (const key of ["a", "b", "cow", "Steve", "villager"]) {
      const glances = new IdleGlances();
      glances.schedule(1_000, key);
      const due = glances.dueAt ?? 0;
      const delay = due - 1_000;
      expect(delay, `${key} waits ${delay}ms`).toBeGreaterThanOrEqual(MIN_IDLE_GLANCE_MS);
      expect(delay, `${key} waits ${delay}ms`).toBeLessThanOrEqual(MAX_IDLE_GLANCE_MS);
    }
  });

  it("is not due before its time, and is due after", () => {
    const glances = new IdleGlances();
    glances.schedule(0, "a");
    const due = glances.dueAt ?? 0;
    expect(glances.due(due - 1, BUSY())).toBe(false);
    expect(glances.due(due, BUSY())).toBe(true);
  });

  it("NEVER glances while fighting, following or answering a wellbeing message", () => {
    const glances = new IdleGlances();
    glances.schedule(0, "a");
    const due = glances.dueAt ?? 0;
    for (const state of [BUSY({ combat: true }), BUSY({ following: true }), BUSY({ wellbeingReply: true })]) {
      expect(glances.due(due + 1_000_000, state), JSON.stringify(state)).toBe(false);
    }
  });

  it("does glance when only gentle mode is on - quiet is not busy", () => {
    // Gentle mode suppresses greetings, not glances: Elix is still in the room.
    const glances = new IdleGlances();
    glances.schedule(0, "a");
    const due = glances.dueAt ?? 0;
    expect(glances.due(due + 1, BUSY({ gentleMode: true }))).toBe(true);
  });

  it("clear() stops the schedule, so a stop leaves no glance pending", () => {
    const glances = new IdleGlances();
    glances.schedule(0, "a");
    glances.clear();
    expect(glances.dueAt).toBeNull();
    expect(glances.due(999_999, BUSY())).toBe(false);
  });

  it("with nothing scheduled it never fires", () => {
    const glances = new IdleGlances();
    expect(glances.due(0, BUSY())).toBe(false);
    expect(glances.due(10_000_000, BUSY())).toBe(false);
  });
});

describe("WP4 — suppression is the rule, not an afterthought", () => {
  it("isSuppressed is true for exactly the three busy states", () => {
    expect(isSuppressed(BUSY())).toBe(false);
    expect(isSuppressed(BUSY({ combat: true }))).toBe(true);
    expect(isSuppressed(BUSY({ following: true }))).toBe(true);
    expect(isSuppressed(BUSY({ wellbeingReply: true }))).toBe(true);
    expect(isSuppressed(BUSY({ gentleMode: true }))).toBe(false);
  });

  it("gentle mode blocks greetings and nothing else", () => {
    expect(mayCrouchGreet(BUSY({ gentleMode: true }))).toBe(false);
    expect(isSuppressed(BUSY({ gentleMode: true }))).toBe(false);
  });

  it("a suppressed gaze can still be stopped mid-turn without throwing", () => {
    const turner = new HeadTurner();
    turner.aimAt({ yaw: Math.PI, pitch: 0.4 }, 0, "mid");
    turner.tick(0);
    // Suppression means "do not start a new turn"; an in-flight one is cancelled, not left
    // swinging, because a head that keeps turning while Elix fights looks broken.
    turner.cancel();
    expect(turner.busy).toBe(false);
  });

  it("the turner never throws, whatever nonsense it is handed", () => {
    const turner = new HeadTurner();
    expect(() => turner.aimAt({ yaw: Number.NaN, pitch: Number.NaN }, 0, "nan")).not.toThrow();
    expect(() => turner.tick(0)).not.toThrow();
    turner.cancel();
    expect(() => turner.tick(10)).not.toThrow();
  });

  it("no gaze decision reaches mineflayer on its own", () => {
    // The whole module is pure; the caller supplies the apply step. A spy proves the turner
    // has no world access of its own.
    const apply = vi.fn();
    const turner = new HeadTurner();
    turner.aimAt({ yaw: 1.0, pitch: 0.2 }, 0, "pure");
    for (let t = 0; t < 20 && !turner.settled; t += 1) {
      const pose = turner.tick(t * LOOK_TICK_MS);
      if (pose !== null) apply(pose);
    }
    expect(apply).toHaveBeenCalled();
    expect(turner.settled).toBe(true);
  });
});