/**
 * The thin mineflayer adapters behind WP2-WP4: view builders, and five guarded calls.
 *
 * WP11 - moved out of `bot.ts` verbatim. Not one line of behaviour changed; the only edit is
 * the imports below, and `bot.ts` re-exports every name here so that every existing import
 * path - in `src/` and in all 40-odd test files - keeps working untouched.
 *
 * The rule this file exists to keep honest: mineflayer's shape is read through RUNTIME
 * GUARDS, never through a cast. A fake bot and a real bot do not agree on which fields exist,
 * and these run on a 50 ms tick where a throw takes the bot down.
 */
import type { BotLike, Vec3Like } from "./bot.js";
import type { CreatureLike, ReflexView, StackLike } from "../reflexes/decide.js";
import type { DefendView } from "../reflexes/defend.js";
import type { EquipSlot } from "../reflexes/tables.js";
import { isHostileMob } from "../reflexes/hostile.js";
import { playerPosition } from "./bot.js";

/**
 * Assemble the reflex view from mineflayer's own fields.
 *
 * Every read is guarded at runtime rather than cast, because a fake bot and a real bot do
 * not agree on which of these exist, and a reflex that throws on the tick takes the bot
 * with it. `ReflexRunner` decides; this only reports.
 */
export function reflexViewOf(bot: BotLike): ReflexView {
  const position = bot.entity?.position;
  const me: Vec3Like = position ?? { x: 0, y: 64, z: 0 };
  // bot.entity.isInWater exists on a real bot; a fake may not have it, and "not in water"
  // is the safe reading because "breathe" is the one reflex that must never fire on a guess.
  const inWater = (bot.entity as { isInWater?: unknown } | undefined)?.isInWater === true;

  // Entities: mineflayer keys bot.entities by id, and each one has name/position/isValid.
  let hostile: ReflexView["hostile"] = null;
  let creeper: ReflexView["creeper"] = null;
  const entities = (bot as { entities?: Record<string, unknown> }).entities ?? {};
  for (const key of Object.keys(entities)) {
    const entity = entityOf(entities[key]);
    if (entity === null || entity.isValid === false) continue;
    const distance = Math.hypot(entity.position.x - me.x, entity.position.z - me.z);
    if (entity.name === "creeper") {
      if (creeper === null || distance < creeper.distance) {
        creeper = { name: entity.name, distance, position: entity.position };
      }
      continue;
    }
    if (!isHostileMob(entity.name)) continue;
    if (hostile === null || distance < hostile.distance) {
      hostile = { name: entity.name, distance };
    }
  }

  const inventory = inventoryOf(bot);
  return {
    position: me,
    inWater,
    oxygenLevel: numberField(bot, "oxygenLevel", 300),
    food: numberField(bot, "food", 20),
    hostile,
    creeper,
    inventory,
    equipped: equippedOf(bot),
  };
}

/**
 * One numeric field off the bot, read through a guard, with the SAFE default when absent.
 *
 * `food` and `oxygenLevel` are real mineflayer bot fields, but BotLike does not declare
 * them and several unit-test fakes do not set them. The defaults matter: no food field
 * reads as 20 (never hungry, never eats by accident) and no oxygen field reads as 300
 * (never drowns on a guess).
 */
export function numberField(bot: BotLike, key: "food" | "oxygenLevel" | "health", fallback: number): number {
  const raw = (bot as unknown as Record<string, unknown>)[key];
  return typeof raw === "number" ? raw : fallback;
}

/** A mineflayer Entity, read through runtime guards. */
export function entityOf(value: unknown): CreatureLike | null {
  if (value === null || typeof value !== "object") return null;
  const raw = value as { name?: unknown; type?: unknown; position?: unknown; isValid?: unknown; health?: unknown };
  if (typeof raw.name !== "string") return null;
  const pos = raw.position as { x?: unknown; y?: unknown; z?: unknown } | undefined;
  if (
    pos === undefined ||
    typeof pos.x !== "number" ||
    typeof pos.y !== "number" ||
    typeof pos.z !== "number"
  ) {
    return null;
  }
  return {
    name: raw.name,
    type: typeof raw.type === "string" ? raw.type : undefined,
    position: { x: pos.x, y: pos.y, z: pos.z },
    isValid: raw.isValid === true,
    health: typeof raw.health === "number" ? raw.health : undefined,
  };
}

/** mineflayer's bot.inventory.items(), mapped to { name, count }. */
export function inventoryOf(bot: BotLike): StackLike[] {
  const items = (bot as { inventory?: { items?: () => unknown } }).inventory;
  if (items === undefined || typeof items.items !== "function") return [];
  const list = items.items();
  if (!Array.isArray(list)) return [];
  const out: StackLike[] = [];
  for (const entry of list) {
    if (entry === null || typeof entry !== "object") continue;
    const item = entry as { name?: unknown; count?: unknown };
    if (typeof item.name !== "string") continue;
    out.push({ name: item.name, count: typeof item.count === "number" ? item.count : 1 });
  }
  return out;
}

/** What is worn and held, by item name. Empty slots read as null. */
export function equippedOf(bot: BotLike): Partial<Record<EquipSlot, string | null>> {
  const out: Partial<Record<EquipSlot, string | null>> = {};
  const get = (path: string): string | null => {
    let node: unknown = bot;
    for (const key of path.split(".")) {
      if (node === null || typeof node !== "object") return null;
      node = (node as Record<string, unknown>)[key];
    }
    if (node === null || node === undefined) return null;
    const named = node as { name?: unknown };
    return typeof named.name === "string" ? named.name : null;
  };
  out.head = get("inventory.slots.5");
  out.torso = get("inventory.slots.6");
  out.legs = get("inventory.slots.7");
  out.feet = get("inventory.slots.8");
  // The held item is the quick-bar slot the client currently has selected.
  const heldSlot = get("quickBarSlot");
  if (typeof heldSlot === "string") out.hand = heldSlot;
  return out;
}

/**
 * The four mineflayer calls the reflexes need, each guarded.
 *
 * A reflex that throws takes the bot with it, and these run on a 50 ms tick, so every one
 * of them swallows its own failure rather than letting an exception reach the interval.
 * None of them awaits anything that could block the tick.
 */
export async function equipOf(bot: BotLike, item: unknown, destination: EquipSlot): Promise<void> {
  const equip = (bot as { equip?: (i: unknown, d: string) => Promise<unknown> }).equip;
  if (typeof equip !== "function") return;
  if (item === null || typeof item !== "object") return;
  try {
    await equip.call(bot, item, destination);
  } catch {
    // mineflayer throws "Invalid item object in equip (...)" and "invalid destination: x".
    // Both mean "do not equip this one", not "crash the tick".
  }
}

/** mineflayer's bot.consume(). Throws "Food is full" at 20; decideEat never gets there. */
export async function consumeOf(bot: BotLike): Promise<void> {
  const consume = (bot as { consume?: () => Promise<unknown> }).consume;
  if (typeof consume !== "function") return;
  try {
    await consume.call(bot);
  } catch {
    // Nothing to eat, or already eating. The next tick decides again.
  }
}

/** Look at a point, if this bot can look. */
export function lookAtOf(bot: BotLike, target: { x: number; y: number; z: number }): void {
  const look = (bot as { look?: (y: number, p: number, force?: boolean) => void }).look;
  if (typeof look !== "function") return;
  const me = bot.entity?.position;
  if (!me) return;
  const dx = target.x - me.x;
  const dy = target.y - me.y;
  const dz = target.z - me.z;
  const yaw = Math.atan2(-dx, dz);
  const pitch = Math.atan2(-dy, Math.hypot(dx, dz));
  try {
    look.call(bot, yaw, pitch, true);
  } catch {
    // A look the server rejects is not worth a tick.
  }
}

/** Drop control states, so a stop leaves nothing half-applied. */
export function clearControlStatesOf(bot: BotLike): void {
  const clear = (bot as { clearControlStates?: () => void }).clearControlStates;
  if (typeof clear !== "function") return;
  try {
    clear.call(bot);
  } catch {
    // A dead bot has nothing to clear.
  }
}

/** Find a real prismarine Item by name, which is what bot.equip requires. */
export function findItemOf(bot: BotLike, name: string): unknown | null {
  const items = (bot as { inventory?: { items?: () => unknown } }).inventory;
  if (items === undefined || typeof items.items !== "function") return null;
  let list: unknown;
  try {
    list = items.items();
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;
  for (const entry of list) {
    if (entry === null || typeof entry !== "object") continue;
    const item = entry as { name?: unknown };
    if (item.name === name) return entry;
  }
  return null;
}

/**
 * Assemble the defend view from mineflayer's own fields.
 *
 * Owners come from the configured owner list, matched against the tracked players, so a
 * stranger's name is never enough - the same rule the command path uses.
 */
export function defendViewOf(bot: BotLike, owners: string[], hurtByPlayer: string | null): DefendView {
  const me = bot.entity?.position;
  const position: Vec3Like = me ?? { x: 0, y: 64, z: 0 };
  const wanted = owners.map((o) => o.toLowerCase());
  const players = bot.players ?? {};
  const ownerDistances: DefendView["owners"] = [];
  for (const name of Object.keys(players)) {
    if (!wanted.includes(name.toLowerCase())) continue;
    const pos = playerPosition(players[name]);
    if (pos === undefined) continue;
    ownerDistances.push({
      name,
      distance: Math.hypot(pos.x - position.x, pos.z - position.z),
      position: { x: pos.x, y: pos.y, z: pos.z },
    });
  }
  const entities: CreatureLike[] = [];
  const raw = (bot as { entities?: Record<string, unknown> }).entities ?? {};
  for (const key of Object.keys(raw)) {
    const entity = entityOf(raw[key]);
    if (entity !== null) entities.push(entity);
  }
  return {
    position,
    health: numberField(bot, "health", 20),
    owners: ownerDistances,
    entities,
    heldWeapon: equippedOf(bot).hand ?? null,
    hurtByPlayer: hurtByPlayer === null ? null : { name: hurtByPlayer, distance: 0 },
  };
}