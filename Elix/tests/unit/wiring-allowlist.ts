/**
 * Exports that are deliberately NOT imported by production code, with one reason each.
 *
 * The wiring audit (`tests/unit/wiring.test.ts`) fails on any export nothing outside its own
 * module uses. An entry here is the escape hatch, and every entry says plainly WHY there is no
 * production caller - because the failure mode Round 18 exists to prevent is a feature that only
 * tests exercise. If an entry's reason ever becomes false, delete it: the audit will tell you.
 *
 * Every entry below is a PURE value or a PURE predicate, reached only from its own module and
 * from a unit test. None of them is a feature: nothing in the running bot is missing because
 * they are unreachable. The first version of this list claimed several of them were "surfaced by
 * doctor" or "read by the wizard", which was not true, and an allow-list that lies is worse than
 * no allow-list.
 */
export const WIRING_ALLOWLIST: Readonly<Record<string, string>> = Object.freeze({
  // --- src/skills/craft.ts -----------------------------------------------------
  CRAFTABLE: "Pure list read inside its own module by isCraftable; unit-tested in craft.test.ts; no runtime caller by design.",
  // --- src/skills/gather.ts ----------------------------------------------------
  REFUSAL_TEXT: "Pure word table read inside its own module; unit-tested in gather.test.ts; the runtime speaks its own words.",
  // --- src/skills/give.ts ------------------------------------------------------
  ALLOWED_CHEST_ACTION: "The single allowed chest action, read by decideGive as the check that no other one exists.",
  // --- src/world/memory.ts -----------------------------------------------------
  migrate: "Schema migration entry point, invoked by the store constructor; no module imports it.",
  coordinateWords: "Pure parser used by the memory tests and the setup wizard's prompt text; no runtime caller yet.",
  // --- src/brain/toolCalls.ts --------------------------------------------------
  TOOL_NAMES: "Pure vocabulary the owner prompt formats from; unit-tested in toolCalls.test.ts.",
  toolLogLine: "Pure formatter for a tool-call audit line; the router logs the fields itself.",
  // --- read by another module, listed for completeness -------------------------
  GIVE_REFUSALS: "Read by src/connection/bot.ts to word a give refusal; listed so the entry has a file.",
  looksLikeCoordinates: "Read by src/world/memoryRuntime.ts so one definition of 'has numbers' is shared.",
});

/**
 * Files whose exports are checked but whose internals are deliberately private.
 *
 * A pure helper used only inside its own module should not be exported at all, so this list
 * names the directories where an unimported export is a real smell rather than a missing wire.
 */
export const AUDITED_DIRECTORIES: readonly string[] = Object.freeze([
  "src/skills",
  "src/world",
  "src/reflexes",
  "src/brain/providers",
  "src/humanizer",
]);

/** Single files audited alongside the directories. */
export const AUDITED_FILES: readonly string[] = Object.freeze(["src/brain/toolCalls.ts"]);
