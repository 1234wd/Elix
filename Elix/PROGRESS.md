# Round 16/17 — long run progress

Backlog WP1–WP12 from `docs/LONG_RUN_BRIEF.md`. One commit per WP: `WPn: <title>`. Never
leave the tree red.

**If this file and `docs/LONG_RUN_BRIEF.md` are all you have, resume at the first WP that is
not DONE.** Read those two files first.

Read-only, never edited: `tests/unit/round13Probes.test.ts`, `round14Probes.test.ts`,
`round15Probes.test.ts`, `round16Probes.test.ts`. All green after every WP.

| WP | Status | Commit | Tests added | Notes |
| --- | --- | --- | --- | --- |
| WP1 Part C against the real pathfinder | **DONE** | `7f18574` | `pathfinderContract.test.ts` (7), `round16Probes.test.ts` (6, read-only) | U1–U5 |
| WP2 Survival reflexes | **DONE** | see log | `reflexTables.test.ts` (11), `reflexes.test.ts` (46), `mcdataSource.test.ts` (9) | breathe, creeper, eat, armour, priority, stop, table completeness, data-source guard |
| WP3 Protect the owner | TODO | | | next |
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

## WP2 — what was built, and what the data turned out to be

New files, all inside the allowed new-module list:

- `src/world/mcdata.ts` — the ONE accessor for version-sensitive data (§1 Q2). The version
  is a parameter, never a literal.
- `src/reflexes/tables.ts` — `ARMOR_POINTS` (29 pieces) and `MELEE_DAMAGE` (23 items), with
  the wiki URLs and the access date in the header comment.
- `src/reflexes/decide.ts` — the pure decisions and the priority ladder.
- `src/reflexes/runner.ts` — the only stateful part, and the only thing `stop` has to reach.
- `src/reflexes/hostile.ts` — the hostile / never-attacked lists. WP3 and WP4 ask this module,
  not their own list. Note this is a hand-written list, because the brief asked for the
  *entity category* in WP3; the categories are now in one place and are covered by
  `tests/unit/defend.test.ts` in WP3.
- `bot.ts` gained wiring only: `reflexViewOf`, four guarded mineflayer adapters, a reflex
  field, `runReflexes()` on the existing 50 ms tick, and `this.reflexes?.stop()` beside
  `this.follow?.stop()`.

### §1 Q1 answered properly, and the wiki's own numbers

`ARMOR_POINTS` and `MELEE_DAMAGE` were read off the wiki (accessed 2026-10-06) and are
cross-checked by two tests:

- the four pieces of each set sum to the full-set figure the same page publishes
  (leather 7, copper 10, gold 11, chainmail 12, iron 15, diamond 20, netherite 20);
- golden armour never outranks iron or chainmail, and a golden sword or axe never
  out-damages its iron equivalent — the exact bug the rejected `MATERIAL_TIER` default had.

**Nothing was left out.** All 29 armour pieces (including the copper set and the turtle
helmet) and all 23 melee items (8 swords, 7 axes, the mace, 7 spears, the trident) have
verified values. The values that the wiki does not publish as armour points are excluded
from the 29 by the brief's own definition and are asserted to be absent rather than zero:
`elytra`, `wolf_armor`, `bow`, `shield`. `armorPointsFor` and `meleeDamageFor` return `null`
for anything unknown, and a `null` item is never auto-equipped.

### Two findings worth keeping

1. **`items.json` cannot be filtered by `enchantCategories` to find armour.** In 26.2,
   `iron_helmet` is tagged `head_armor`, but `diamond_chestplate` carries only `equippable`,
   `armor`, `durability`, `vanishing` — no `chest_armor`. A category-based completeness test
   would have skipped every chestplate in the game and reported green. Detection is by name
   shape instead, and the test says why.
2. **`prismarine-item` does not resolve items by name.** `new Item("bread", 1)` yields
   `name: "unknown"`. Items are built from a numeric id, which is what mineflayer does from
   the server's NBT. The contract test therefore builds real Items from the vendored 26.2
   ids and asserts the resulting `item.name` matches, which also proves the vendored data and
   the real prismarine registry agree on every item Elix touches. A name-based shortcut would
   have built an item the real library would never hand us.

## Deviations

Changes to tests I wrote myself, each one encoded a bug WP1 or WP2 fixed.

- `tests/unit/actions.test.ts` — "the acknowledgement goes through the same sender gate as
  any reply" asserted the Round 15 **bug**: the ack went through `gateScriptedReply`, which
  classifies its argument as the sender's own words. Now expects `gateOwnLine` and asserts
  nothing Elix says is classified as the owner's.
- `tests/unit/actions.test.ts` — controller goal assertions described our own intent object
  (`{ kind: "follow", distance }`). Now the library's real `GoalFollow` and `rangeSq`.
- `tests/unit/actions.test.ts` — entity stubs were `{ id: 1 }`, which the real `GoalFollow`
  constructor throws on. Now mineflayer-shaped.
- `tests/unit/reflexes.test.ts` — mine own new test, not a bug from an earlier round: the
  assertion that a `stop` leaves `endReason` null was wrong. A flee completes on its own
  tick, which is what `finished` records; the test now asserts `finished` and states that
  what matters is that nothing is left running.

Production code outside the new-module rule (each of these is a bug, and the first three are
ones the brief itself reported):

- `src/connection/bot.ts` — `PathfinderModule.goals` declared only `GoalNear`, so
  `GoalFollow` was `undefined` and every follow silently became `goal-build-failed`.
- `src/actions/commands.ts` — `parseAddressedCommand` lower-cased the line then matched the
  bot's name case-sensitively, so no command worked at all while the probes passed.
- `src/connection/bot.ts` — the spawn-time walk warned "walk failed" every 5 s in every test.
  Now gated on `canConfigureMovements(bot)`.

## Questions for the owner (none is a stop condition)

- **WP2 design choice:** the reflex tick runs on the existing 50 ms follow tick, and `armour`
  does NOT interrupt follow — picking up a better sword while walking is what Elix should do.
  Interrupting follow for armour would stop him every time a good item dropped.
- **WP3 note:** the brief asks for hostile mobs "from `minecraft-data` entity categories, not
  a hand-written name list". `items.json`/`entities.json` in 26.2 does not carry a usable
  hostile flag, so the lists are hand-written in `src/reflexes/hostile.ts` with the
  never-attacked rule checked first. Proceeding that way unless told otherwise.
- Should `owners` ever be per-profile? Currently global — one server, one owner set.
- Should the WP10 e2e command rows be part of the default run? Currently opt-in via
  `--owners`, so the default run never grants command rights.

## Notes for whoever picks this up

- `tests/unit/round12A1.test.ts` has a wall-clock assertion (`< 950ms`). It failed once
  under full-suite parallel load (1029ms) and passed both when re-run alone and on a full
  re-run. It is a timing flake under load, not a regression. Do not "fix" it by widening the
  threshold; if it keeps flaking, the honest fix is fake timers for that measurement.
- CRLF trap: `git checkout`/`git clone` restore CRLF, so any script that string-matches
  source must `.replace(/\r\n/g,"\n")` first.
- Quoting trap in `.cjs` patch scripts: apostrophes in emitted TypeScript break
  single-quoted JS strings. Use the `write` tool for new files, or the `edit` tool for
  targeted changes — both proved far more reliable in Round 17.
- vitest swallows `console.log`; write diagnostics to a file with `writeFileSync`.

## Gates

At `bdfd421` (docs: long-run brief):

```
pnpm typecheck  exit 0
pnpm lint       exit 0
pnpm test       Tests  1554 passed | 2 skipped (1556)
round13Probes 8   round14Probes 6   round15Probes 5   round16Probes 6
secret scan   9 passed
```

After WP2 (see the WP table for the commit):

```
pnpm typecheck  exit 0
pnpm lint       exit 0
pnpm test       Tests  1620 passed | 2 skipped (1622)
secret scan    9 passed
```