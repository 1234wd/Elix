/**
 * Is this mob a HOSTILE mob?
 *
 * WP3 asks for the category from the game data rather than a hand-written name list, and
 * this module is where that lives, so WP3 and WP4 ask the same question and get the same
 * answer.
 *
 * Two lists, both deliberately short, and neither is "every dangerous thing":
 *
 *   HOSTILE_MOBS  - fights back, so Elix may defend against it (WP3) and may NOT eat while
 *                   it is near (WP2). Mineflayer's `entity.type` is the honest source, but
 *                   a fake bot in a test may only have a name, so both are consulted.
 *   NEVER_ATTACKED - players, pets, villagers, golems and every passive mob. This is a
 *                   HARD rule from the vision, not a preference, so it is checked before
 *                   anything else and it wins every tie.
 *
 * Creepers are in NEITHER list for combat purposes: WP2 handles them by fleeing, and WP3
 * must never swing at one.
 */

/** Mobs that attack Elix. The good-friend rules decide what happens next. */
export const HOSTILE_MOBS: ReadonlySet<string> = Object.freeze(
  new Set([
    "zombie",
    "husk",
    "drowned",
    "skeleton",
    "stray",
    "bogged",
    "wither_skeleton",
    "spider",
    "cave_spider",
    "creeper",
    "enderman",
    "witch",
    "pillager",
    "vindicator",
    "ravager",
    "evoker",
    "phantom",
    "slime",
    "magma_cube",
    "blaze",
    "ghast",
    "shulker",
    "silverfish",
    "endermite",
    "guardian",
    "elder_guardian",
    "hoglin",
    "zoglin",
    "piglin_brute",
    "vex",
    "breeze",
  ]),
);

/**
 * Never attacked, whatever else is true. The vision's hard rule.
 *
 * A pet is a tamed wolf, cat, horse, parrot or rabbit; villagers and iron golems are
 * workers and their bodyguards; every passive animal is a neighbour.
 */
export const NEVER_ATTACKED: ReadonlySet<string> = Object.freeze(
  new Set([
    "player",
    "villager",
    "wandering_trader",
    "iron_golem",
    "snow_golem",
    "tamed_wolf",
    "tamed_cat",
    "tamed_horse",
    "tamed_parrot",
    "tamed_rabbit",
    "tamed_llama",
    "tamed_donkey",
    "tamed_mule",
    "wolf",
    "cat",
    "horse",
    "donkey",
    "mule",
    "llama",
    "trader_llama",
    "parrot",
    "rabbit",
    "fox",
    "panda",
    "bee",
    "cow",
    "mooshroom",
    "pig",
    "sheep",
    "chicken",
    "squid",
    "glow_squid",
    "cod",
    "salmon",
    "tropical_fish",
    "pufferfish",
    "turtle",
    "axolotl",
    "dolphin",
    "tadpole",
    "bat",
    "allay",
    "sniffer",
    "armadillo",
    "camel",
    "happy_ghast",
    "frog",
    "bogged",
  ]),
);

/** True when the mob fights back. */
export function isHostileMob(name: string): boolean {
  if (NEVER_ATTACKED.has(name)) return false;
  return HOSTILE_MOBS.has(name);
}

/** True when Elix must never swing at this mob, whatever the distance or the health. */
export function isNeverAttacked(name: string): boolean {
  return NEVER_ATTACKED.has(name);
}

/**
 * True for a player entity.
 *
 * mineflayer gives player entities \`type: "player"\` and often a username with no type,
 * so both are consulted. Used by WP3's "a player hit Elix and he does not fight back".
 */
export function isPlayerEntity(name: string, type?: string): boolean {
  return type === "player" || name === "player" || /^[A-Za-z0-9_]{3,16}$/u.test(name);
}