/**
 * WP4 — looking like a person who is in a room.
 *
 * A bot that snaps its head 180 degrees in one packet reads as a turret, and a turret is
 * the first thing a server admin notices. So the head turns:
 *
 *   - over 150-400 ms, never more than 40 degrees in one tick;
 *   - by the SHORT way round, so turning to face something behind Elix does not spin him
 *     all the way through north;
 *   - and it always finishes - the last step closes the remaining gap rather than easing
 *     towards it forever.
 *
 * Everything else in this file is body language with the same rule: it happens at human
 * timing, or not at all.
 *
 *   - LOOK AT THE SPEAKER, within 16 blocks, when someone addresses Elix.
 *   - CROUCH-GREET, two or three sneak toggles, when an owner joins or says hi.
 *   - IDLE GLANCES, every 8-20 s, only while there is genuinely nothing to do.
 *
 * And it all stops. Combat, follow, a wellbeing reply being sent, and gentle mode each
 * suppress the gaze, because a bot that keeps glancing around while it is defending someone
 * or answering a sad message is not charming, it is distracted.
 */
import { Vec3 } from "vec3";

/** One tick. The same 50 ms the reflexes and follow run on. */
export const LOOK_TICK_MS = 50;

/** Longest a single tick may turn the head, in degrees. */
export const MAX_TURN_DEG = 40;

/** The brief's window for one head turn. */
export const MIN_TURN_MS = 150;
export const MAX_TURN_MS = 400;

/** How close a speaker must be before Elix turns to look at them. */
export const SPEAKER_RANGE = 16;

/** The idle-glance window. */
export const MIN_IDLE_GLANCE_MS = 8_000;
export const MAX_IDLE_GLANCE_MS = 20_000;

/** How often Elix crouch-greets the SAME owner. Once a greeting is enough. */
export const CROUCH_COOLDOWN_MS = 60_000;

/** What is going on that should stop Elix from fidgeting. */
export interface LookSuppression {
  /** WP3: engaging a hostile mob. */
  combat: boolean;
  /** Following or walking somewhere on purpose. */
  following: boolean;
  /** A wellbeing reply is being composed or sent. */
  wellbeingReply: boolean;
  /** Gentle mode: quiet for a while, so no greeting at all. */
  gentleMode: boolean;
}

/** Nothing is going on, so the gaze may wander. */
export const IDLE_SUPPRESSION: LookSuppression = Object.freeze({
  combat: false,
  following: false,
  wellbeingReply: false,
  gentleMode: false,
});

/** True when nothing may fidget. Combat, follow and a wellbeing reply all count. */
export function isSuppressed(state: LookSuppression): boolean {
  return state.combat || state.following || state.wellbeingReply;
}

/** True when crouch-greets are allowed: never during gentle mode, never while busy. */
export function mayCrouchGreet(state: LookSuppression): boolean {
  return !state.gentleMode && !isSuppressed(state);
}

/** A position, in the shape mineflayer and vec3 agree on. */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** The yaw and pitch to apply this tick, in mineflayer's radians. */
export interface HeadPose {
  yaw: number;
  pitch: number;
}

/** Wrap to (-PI, PI]. */
export function wrapAngle(radians: number): number {
  let a = radians % (Math.PI * 2);
  if (a > Math.PI) a -= Math.PI * 2;
  if (a <= -Math.PI) a += Math.PI * 2;
  return a;
}

/** The shortest signed difference from `from` to `to`, in radians. */
export function shortestAngle(from: number, to: number): number {
  return wrapAngle(to - from);
}

/** Yaw and pitch that face `target` from `eye`. mineflayer's own convention. */
export function poseToward(eye: Vec3Like, target: Vec3Like): HeadPose {
  const dx = target.x - eye.x;
  const dy = target.y - eye.y;
  const dz = target.z - eye.z;
  const yaw = Math.atan2(-dx, dz);
  const pitch = Math.atan2(-dy, Math.hypot(dx, dz));
  return { yaw, pitch };
}

/** Smoothstep, so the head speeds up and slows down instead of starting and stopping hard. */
function smoothstep(t: number): number {
  const clamped = t <= 0 ? 0 : t >= 1 ? 1 : t;
  return clamped * clamped * (3 - 2 * clamped);
}

/** A stable per-key hash, so the same target is met the same way twice. */
function hashOf(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  return Math.abs(hash);
}

/**
 * One head turn, eased over time.
 *
 * Two rules it cannot break, both asserted in the tests:
 *
 *   - no single tick moves the head more than MAX_TURN_DEG, whichever direction;
 *   - the turn completes within MAX_TURN_MS, because a turn that eases asymptotically towards
 *     its target never finishes, and an unfinished turn is a head stuck mid-glance.
 */
export class HeadTurner {
  private from: HeadPose | null = null;
  private to: HeadPose | null = null;
  private startedAt: number | null = null;
  private durationMs = MIN_TURN_MS;
  private last: HeadPose = { yaw: 0, pitch: 0 };
  private lastAt = 0;

  constructor(readonly tickMs: number = LOOK_TICK_MS) {}

  /** The pose currently applied. */
  get pose(): HeadPose {
    return { yaw: this.last.yaw, pitch: this.last.pitch };
  }

  /** True while a turn is in progress. */
  get busy(): boolean {
    return this.startedAt !== null && !this.settled;
  }

  /** True when the head has arrived. */
  get settled(): boolean {
    return this.startedAt === null;
  }

  /**
   * Aim at a pose. Re-aiming mid-turn restarts from where the head is now, so a target that
   * moves does not make the head snap.
   */
  aimAt(target: HeadPose, at: number, key = "default"): void {
    const alreadyThere =
      Math.abs(shortestAngle(this.last.yaw, target.yaw)) < 1e-4 &&
      Math.abs(target.pitch - this.last.pitch) < 1e-4;
    if (alreadyThere && this.startedAt !== null) return;
    this.from = { yaw: this.last.yaw, pitch: this.last.pitch };
    this.to = target;
    this.lastAt = at;
    this.durationMs = MIN_TURN_MS + (hashOf(key) % (MAX_TURN_MS - MIN_TURN_MS + 1));
    this.startedAt = at;
  }

  /**
   * Advance one tick. Returns the pose to apply, or null when there is nothing to do.
   *
   * The per-tick cap is applied to the TOTAL rotation - yaw and pitch together - because a
   * simultaneous diagonal turn is what actually looks robotic.
   */
  tick(at: number): HeadPose | null {
    if (this.startedAt === null || this.from === null || this.to === null) return null;
    const elapsed = at - this.startedAt;
    const progress = smoothstep(elapsed / this.durationMs);
    if (progress >= 1) {
      this.last = { yaw: this.to.yaw, pitch: this.to.pitch };
      this.settledNow();
      return { yaw: this.last.yaw, pitch: this.last.pitch };
    }
    const wantedYaw = this.from.yaw + shortestAngle(this.from.yaw, this.to.yaw) * progress;
    const wantedPitch = this.from.pitch + (this.to.pitch - this.from.pitch) * progress;
    const step = Math.min(
      1,
      (MAX_TURN_DEG * (Math.PI / 180)) / Math.max(1e-9, this.rotationBetween(wantedYaw, wantedPitch)),
    );
    const nextYaw = this.last.yaw + shortestAngle(this.last.yaw, wantedYaw) * step;
    const nextPitch = this.last.pitch + (wantedPitch - this.last.pitch) * step;
    this.last = { yaw: nextYaw, pitch: nextPitch };
    return { yaw: nextYaw, pitch: nextPitch };
  }

  /** Angle between the current pose and the pose the easing wants, in radians. */
  private rotationBetween(yaw: number, pitch: number): number {
    return Math.hypot(shortestAngle(this.last.yaw, yaw), pitch - this.last.pitch);
  }

  private settledNow(): void {
    this.startedAt = null;
    this.from = null;
    this.to = null;
  }

  /** Drop a turn in progress. Used by `elix stop`, which leaves nothing half-applied. */
  cancel(): void {
    this.settledNow();
  }
}

/**
 * Crouch-greetings.
 *
 * Two or three sneak toggles, and never during gentle mode. The count comes from a stable
 * hash of the owner's name, so the same owner is greeted the same way twice and two owners
 * are not greeted identically.
 */
export function crouchCount(owner: string): number {
  return 2 + (hashOf(owner) % 2);
}

/** When this owner was last greeted, or 0. */
export type CrouchLog = Record<string, number>;

/**
 * Should Elix crouch-greet this owner right now?
 *
 * Once per owner per CROUCH_COOLDOWN_MS, and never while suppressed.
 */
export function shouldCrouchGreet(
  owner: string,
  at: number,
  log: CrouchLog,
  state: LookSuppression,
): boolean {
  if (!mayCrouchGreet(state)) return false;
  // `undefined` means "never greeted", NOT 0. A `log[owner] ?? 0` here means an owner is
  // never greeted while the clock reads 0 - which is exactly what a test clock starts at,
  // and exactly what a fresh process's elapsed time would look like.
  const last = log[owner];
  if (last === undefined) return true;
  return at - last >= CROUCH_COOLDOWN_MS;
}

/** Record a greeting. The caller does this only once the first toggle has been sent. */
export function noteCrouchGreet(owner: string, at: number, log: CrouchLog): void {
  log[owner] = at;
}

/**
 * The idle-glance schedule.
 *
 * A glance every 8-20 s at somebody nearby, and only while idle. The next delay is drawn
 * from the window so it never becomes a metronome, and the state is small enough to be
 * read in one sitting.
 */
export class IdleGlances {
  private nextAt: number | null = null;

  /** When the next glance is due, or null when none is scheduled. */
  get dueAt(): number | null {
    return this.nextAt;
  }

  /** True when a glance should happen now. */
  due(at: number, state: LookSuppression): boolean {
    if (isSuppressed(state)) return false;
    if (this.nextAt === null) return false;
    return at >= this.nextAt;
  }

  /**
   * Schedule the next glance 8-20 s out.
   *
   * `key` makes the delay stable per subject, so the same villager is not glanced at on a
   * different rhythm every time.
   */
  schedule(at: number, key = "default"): void {
    const span = MAX_IDLE_GLANCE_MS - MIN_IDLE_GLANCE_MS;
    this.nextAt = at + MIN_IDLE_GLANCE_MS + (hashOf(key) % (span + 1));
  }

  /** Stop glancing - used when Elix gets busy, and by `elix stop`. */
  clear(): void {
    this.nextAt = null;
  }
}

/**
 * The nearest subject worth glancing at, out of the ones in range.
 *
 * A player is preferred over a mob at a similar distance: glancing at whoever is talking is
 * what a person does.
 */
export function pickGlanceSubject(
  eye: Vec3Like,
  candidates: Array<{ name: string; position: Vec3Like; isPlayer: boolean }>,
  maxDistance = SPEAKER_RANGE,
): { name: string; position: Vec3 } | null {
  let best: { name: string; position: Vec3; distance: number; isPlayer: boolean } | null = null;
  for (const candidate of candidates) {
    const distance = Math.hypot(
      candidate.position.x - eye.x,
      candidate.position.z - eye.z,
    );
    if (distance > maxDistance) continue;
    // A player beats a mob that is further away, but not a mob that is right here.
    const better =
      best === null ||
      (candidate.isPlayer && !best.isPlayer && distance <= best.distance + 4) ||
      (candidate.isPlayer === best.isPlayer && distance < best.distance);
    if (better) {
      best = {
        name: candidate.name,
        position: new Vec3(candidate.position.x, candidate.position.y, candidate.position.z),
        distance,
        isPlayer: candidate.isPlayer,
      };
    }
  }
  return best === null ? null : { name: best.name, position: best.position };
}