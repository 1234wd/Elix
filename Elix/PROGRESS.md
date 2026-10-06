# Round 16 — long run progress

Backlog WP1–WP12. One commit per WP: `WPn: <title>`. Never leave the tree red.

Read-only: `tests/unit/round13Probes.test.ts`, `round14Probes.test.ts`,
`round15Probes.test.ts`, `round16Probes.test.ts`. They must stay green after every WP.

| WP | Status | Commit | Tests added | Notes |
| --- | --- | --- | --- | --- |
| WP1 Part C against the real pathfinder | **DONE** | `7f18574` | `pathfinderContract.test.ts` (7), `round16Probes.test.ts` (6, read-only) | U1 real goals, U2 addressed-only, U3 whole intent, U4 come→speaker, U5 gateOwnLine |
| WP2 Survival reflexes | **BLOCKED (data)** | — | — | see "WP2 blocker" below |
| WP3 Protect the owner | TODO | | | |
| WP4 Human-like gaze | TODO | | | |
| WP5a gather | TODO | | | |
| WP5b craft | TODO | | | |
| WP5c give / deposit | TODO | | | |
| WP6 World memory | TODO | | | |
| WP7 NVIDIA + Ollama tiers | TODO | | | |
| WP8 Constrained tool calls | TODO | | | |
| WP9 Status + first-run safety | TODO | | | |
| WP10 e2e rows | TODO | | | |
| WP11 Split bot.ts / bridge.ts | TODO | | | |
| WP12 Voice plan | TODO | | | |

## WP2 blocker — found before writing any reflex code

The brief says rank food with `minecraft-data` foods (food points + saturation) and rank
armour/weapons with `minecraft-data` (armour points + attack damage). I probed both the
installed `minecraft-data` and the vendored 26.2 data. Results:

**Food ranking: possible.** `vendor/minecraft-data/data/pc/26.2/foods.json` has
`{ id, name, foodPoints, saturation, effectiveQuality, saturationRatio }` per food item.
`items.json` gives the item name → numeric id, so `foods` can be joined on id. Verified:
`beef` id 1139 → 3 food points / 1.8 saturation; `golden_apple` id 1014 → 4 / 9.6;
`rotten_flesh` id 1143 → 4 / 0.8.

**Armour points and attack damage: NOT in the data.** Neither the installed
`minecraft-data@1.21.4` nor the vendored 26.2 files carry numeric armour points or attack
damage. `items.json` for armour and weapons carries only `enchantCategories`
(`head_armor`, `chest_armor`, `leg_armor`, `foot_armor`, `weapon`, `melee_weapon`,
`sharp_weapon`), `repairWith` and `maxDurability`. So the brief's ranking source does not
exist in the data we are allowed to use.

**Also found, and it would have broken WP5a/WP5b/WP5c too:** the installed
`minecraft-data@1.21.4` is internally inconsistent. `foods` is keyed by a *different*
numeric id than `itemsByName` reports for the same item — `mushroom_stew` is key `849` in
`foods` but `itemsByName.mushroom_stew.id === 880`. Joining the two by id on the installed
package silently produces wrong or missing food data. The vendored 26.2 data does **not**
have this problem: `foods.json` ids match `items.json` ids (verified for beef, rotten
flesh, golden apple).

**Safest reasonable default, chosen without asking:** rank armour and weapons by the
**material tier**, derived from the item's `repairWith` material (leather < chainmail <
iron < gold < diamond < netherite) — which IS in the data and which orders armour and tools
correctly for this purpose. Name the table `MATERIAL_TIER` and document that it is NOT
minecraft-data, so nobody later mistakes it for a measured value. Eating, brewing and
potion effects are out of scope, so effectiveQuality is the right ranking key for food.

**Not yet written:** `src/reflexes/`. The data layer above is the expensive part to
rediscover, so it is recorded here rather than left in a probe script.

## Deviations

Changes to tests I wrote myself, with the reason. Each one encoded a bug WP1 fixed.

- `tests/unit/actions.test.ts` — "the acknowledgement goes through the same sender gate as
  any reply" asserted the Round 15 bug: the ack went through `gateScriptedReply`, which
  **classifies its argument as the sender's own words**, so "on my way" was audited as if
  the owner had said it. WP1/U5 changed the test to expect `gateOwnLine` and to assert that
  nothing Elix said is ever classified as the owner's.
- `tests/unit/actions.test.ts` — the controller tests asserted a goal shaped like our own
  intent object (`{ kind: "follow", distance }`). WP1/U1 replaced them with the library's
  real `GoalFollow` and its real `rangeSq` field.
- `tests/unit/actions.test.ts` — entity stubs were `{ id: 1 }`, which the real
  `GoalFollow` constructor throws on, because it reads `entity.position` in the
  constructor. Replaced with mineflayer-shaped entities (`Vec3` position, `isValid`).

Production code changed outside the new-module rule (the brief allows wiring lines only, and
this was a bug the brief itself reported):

- `src/connection/bot.ts` — `PathfinderModule.goals` only declared `GoalNear`, so
  `GoalFollow` was `undefined` at runtime and `new undefined(entity, 3)` threw inside the
  controller's guard. Every follow silently became `goal-build-failed`.
- `src/actions/commands.ts` — `parseAddressedCommand` lower-cased the line and then
  matched the bot's name **case-sensitively**, so `/(?:^|\s)Elix(?:$|\s)/` never matched
  "elix follow me" and no command worked at all. Round 16's U2/U3/U5 probes passed while
  follow did nothing, which is the safest possible failure and the hardest to notice.
- `src/connection/bot.ts` — the spawn-time walk ran `makeSafeMovements`, which needs a
  prismarine registry no unit-test bot has, and warned "walk failed" every 5 seconds in
  every test. Now gated on `canConfigureMovements(bot)`.

## Questions for the owner

- **Armour points and attack damage are not in the vendored `minecraft-data` 26.2.** Should
  WP2 rank armour/weapon by material tier (the default I chose), or may I add the numbers
  as a small explicit table with the source named? I will not invent numbers and call them
  data.
- The installed `minecraft-data@1.21.4` disagrees with itself about item ids (see above).
  Should everything version-sensitive read the vendored 26.2 files directly instead of the
  installed package? I have used the vendored files for this decision and would default to
  them.
- Does `owners` need to be per-profile rather than global? Chosen global: one server, one
  owner set, and a per-profile list would let a test profile grant itself.
- Should the WP10 e2e command rows be part of the default run or opt-in? Chosen opt-in via
  `--owners`, since the default run must never grant command rights.

## Gates at `7f18574` (WP1)

```
pnpm typecheck  0
pnpm lint       0
pnpm test       Tests  1554 passed | 2 skipped (1556)
round13Probes  8 passed      round14Probes  6 passed
round15Probes  5 passed      round16Probes  6 passed
secret scan    9 passed
```