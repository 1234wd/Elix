# Round 16/17 — long run progress

Backlog WP1–WP12 from `docs/LONG_RUN_BRIEF.md`. One commit per WP: `WPn: <title>`. Never
leave the tree red.

Round 17 finished at `ba2c275`. The reviewer's Round 18 brief is in `docs/LONG_RUN_BRIEF.md`.

**RESUME HERE: R18-H - wire NVIDIA/Ollama (X7), then R18-G tool calls (X6), then R18-I wiring audit.** R18-A..R18-F DONE.
gather (X3), give (X4), world memory (X5), model tool calls (X6), NVIDIA/Ollama (X7).

The single most important rule this round is §1 of the brief: **an item is DONE only with a
BotSession-level test that drives the feature to a real mineflayer call.** Round 17 shipped 370
tests and a whole feature set that the bot could not do, because nothing called it.

Read-only, never edited: `tests/unit/round13Probes.test.ts`, `round14Probes.test.ts`,
`round15Probes.test.ts`, `round16Probes.test.ts`. All green after every WP.

| WP | Status | Commit | Tests added | Notes |
| --- | --- | --- | --- | --- |
| WP1 Part C against the real pathfinder | **DONE** | `7f18574` | `pathfinderContract.test.ts` (7), `round16Probes.test.ts` (6, read-only) | U1–U5 |
| WP2 Survival reflexes | **DONE** | `3599ae5` | `reflexTables.test.ts` (11), `reflexes.test.ts` (46), `mcdataSource.test.ts` (9) | breathe/creeper/eat/armour, priority, stop, table completeness, data-source guard |
| WP3 Protect the owner | **DONE** | `360f476` | `defend.test.ts` (38) | target selection, reaction bounds per skillCap, cooldown, retreat, never a player |
| WP4 Human-like gaze | **DONE** | `40ac355` | `look.test.ts` (33) | 40°/tick cap, 150–400 ms, speaker look, crouch-greet, idle glances, suppression |
| WP5a gather | **DONE** | `0f2af6b` | `gather.test.ts` (46) | allow-list, leaves-or-not, protected places, real `harvestTools`, `bot.dig` contract |
| WP5b craft | **DONE** | `f380555` | `craft.test.ts` (35) | real 26.2 recipes, table placement rules, `bot.recipesFor`/`bot.craft` contract |
| WP5c give / deposit | **DONE** | `ae82a1a` | `give.test.ts` (34) | give only to the asker, deposit only, **never withdraw**, `bot.toss` contract |
| WP6 World memory | **DONE** | `c5ed596` | `worldMemory.test.ts` (29) | tested migration on a copy of the old schema, whisper-only coordinates |
| WP7 NVIDIA + Ollama | **DONE** | `bf1ce94` | `providers.test.ts` (34) | 24 h 402 breaker, silent-absent local probe, no hard-coded model ids, call deadlines |
| WP8 Constrained tool calls | **DONE** | `95da322` | `toolCalls.test.ts` (26) | closed zod list, owner-only, dropped-reply drops calls, gentle mode, 1/reply + 6/min |
| WP9 Status + first run | **DONE** | `2a939d7` | `status.test.ts` (27) | key redaction, no chat text, owner/offline-server warnings, README checklist |
| WP10 e2e rows | **DONE** | `3564c4e` | — (script) | command rows, opt-in `--owners`, ❌ **not run** — no server reachable from here |
| WP11 Split bot.ts / bridge.ts | **PARTIAL** | `0d74e79` | — (no test changes) | hazard + reflex-adapter blocks moved out, re-exported; bot.ts 2600 → 2249 |
| WP12 Voice plan | **DONE** | see log | — (document) | `docs/VOICE_PLAN.md`; no code, no runtime deps |

## Round 18 — item state

| Item | Status | Commit | Probes |
| --- | --- | --- | --- |
| R18-A portability | **DONE** | `f99b70b` | X0 ✅ |
| R18-B reflex units | **DONE** | `f4432c9` | X1 ✅ X2 ✅ |
| R18-C wire gather | **DONE** | `3e8bee9` | X3 pass (17 new tests) |
| R18-D wire craft | **DONE** | `b4f1f93` | 16 new tests, real-lib contract |
| R18-E wire give/deposit | **DONE** | `cc46aab` | 17 new tests (X4 pass) |
| R18-F wire world memory | **DONE** | `573f5e8` | 17 new tests (X5 pass) |
| R18-G wire tool calls | **NEXT** | - | X6 |
| R18-H wire NVIDIA/Ollama | **NEXT** | - | X7 |
| R18-I wiring audit | TODO | | — |
| R18-J setup wizard | TODO | | — |
| R18-K sleep | TODO | | — |
| R18-L finish splitting | TODO | | — |
| R18-M voice step 1 | TODO | | — |

Baseline at `ba2c275`: **8 failed / 1 passed**. Now: **5 failed / 4 passed** (X0, X1, X2 and the
fixture check).

### R18-A — how the fresh-clone gate works, and the ordering problem

`scripts/fresh-gate.ps1` (git root) clones into `.fresh/`, installs, and runs the three gates.
Two things that cost time and will again:

- **It clones from git, so it can only see COMMITTED work.** Commit first, then gate. A gate run
  before the commit tests the previous commit and will "fail" on work that is already correct.
- PowerShell treats pnpm's stderr banner as a terminating error under `ErrorActionPreference =
  'Stop'`. The script keeps `Continue` and judges each gate by its own exit code.

### R18-B — the real bug, and the trap behind it

`bot.oxygenLevel` is `Math.round(air_supply / 15)` — **0 to 20**. The threshold was 120, on a
0-300 scale, so in ANY water at FULL air the breathe reflex fired every tick and outranked
follow, defend and everything else. On a live server that is a bot that swims up constantly and
ignores its owner. Now `LOW_OXYGEN = 6` and the unknown-field fallback is 20, not 300.

`MINECRAFT_SCALES` in `src/reflexes/decide.ts` holds the documented ranges in one place
(health 0-20, food 0-20, foodSaturation 0-20, oxygenLevel 0-20) so there is one place to check
them against `node_modules/mineflayer/docs/api.md`.

`swim-up` now calls `bot.setControlState("jump", true)` for `JUMP_HOLD_TICKS` (8 ticks =
400 ms) and releases it. `stop()` releases jump too — a stop that clears control states but not
the key Elix is physically holding leaves him jumping in place.

Two more bugs found on the way:

- **`runReflexes` read `interruptedFollow` one tick late.** It does `void runner.tick()` and
  then asks whether follow is being held off, and the answer was always about the PREVIOUS
  tick. `tick()` now settles that flag before its first await.
- **A patch script aborted mid-run and wrote nothing**, which silently dropped the jump press
  and cost twenty minutes of staring at correct code. **Every `.cjs` patch script must verify it
  found every anchor before writing** — and if it throws, assume NOTHING landed.

## WP11 — PARTIAL, and exactly what is left

**Done (`0d74e79`):** two cohesive blocks moved out of `bot.ts` **verbatim**, with every moved
name re-exported from `bot.ts` so that **no import path in `src/` or `tests/` changed**.
That last part is the whole trick, and it is why this was safe: 1924 tests green with zero test
edits, which is what WP11 allows.

- `src/connection/hazards.ts` (172 lines) — `WALK_DISTANCES`, `HAZARD_BLOCKS`,
  `HAZARD_PASSABLE_REJECTS`, `toVec3`, `stopForHazard`, `isSafeFloor`, `isPassable`,
  `isStandable`, `pickWalkDirection`, and the `WalkOutcome`/`WalkSkipReason` types.
- `src/connection/reflexAdapters.ts` (237 lines) — the WP2–WP4 view builders
  (`reflexViewOf`, `defendViewOf`, `entityOf`, `inventoryOf`, `equippedOf`,
  `numberField`) and the five guarded mineflayer calls (`equipOf`, `consumeOf`,
  `lookAtOf`, `clearControlStatesOf`, `findItemOf`).

**Still to do, and why it was not done in this session:** `BotSession` itself is ~1500 of
bot.ts's remaining 2249 lines. Reaching the brief's ≤800 target means splitting a class that
40-odd test files construct directly and poke at, which is exactly the case where a "mechanical"
refactor starts quietly changing behaviour. The brief's own instruction for that situation is to
stop and mark the WP PARTIAL, so that is what this is. Next session:

1. `src/connection/chatDispatch.ts` — `handleChat` and `runCommand`.
2. `src/connection/presence.ts` — `installCrashGuards`, `greetingFor`, `isGreetingFor`,
   `hasFollowUp`, `lookAround`, the greeting tables.
3. `src/connection/initiative.ts` — the 5 s poll and its wiring.
4. `src/connection/followWiring.ts` — `runReflexes`, `runDefend`, `runGaze`,
   `maybeSayHurtLine`, `gazeState`, `gazeCandidates`, `setSneak`, `startFollow`,
   `startCome`.
5. Then `bridge.ts` (1433): audit store and gate, chat reply, wellbeing reply — same
   re-export trick.

Rule unchanged: test edits are allowed **only** in import paths; if a move needs a behaviour
change, stop and leave the WP PARTIAL rather than fixing it in place.

## WP11 — original plan, for reference

Target: no file over 800 lines. Measured at `3564c4e`:

At the start of WP11:
```
2600  src/connection/bot.ts      <- the big one
1433  src/brain/bridge.ts
 991  src/memory/store.ts
 967  src/brain/router.ts
 898  src/social/wellbeing.ts
```

The brief names what should move out of `bot.ts`: chat dispatch, initiative wiring, presence,
crash guards, command routing. Out of `bridge.ts`: audit store and gate, chat reply, wellbeing
reply.

Wiring added in WP2–WP8 that WP11 will have to move along with it (all in `bot.ts`, all with
thin local adapters next to them):

- `reflexViewOf`, `entityOf`, `inventoryOf`, `equippedOf`, `numberField` → the WP2 reflex view
- `equipOf`, `consumeOf`, `lookAtOf`, `clearControlStatesOf`, `findItemOf` → WP2 adapters
- `defendViewOf` → WP3
- `runReflexes`, `runDefend`, `maybeSayHurtLine`, `runGaze`, `gazeState`, `gazeCandidates`,
  `setSneak` → WP2–WP4 tick wiring
- `realGoalFactory` construction inside `start()` → WP1

**Rule for WP11: test changes are allowed ONLY in import paths.** If any behaviour change is
needed to make a move work, stop and mark the WP PARTIAL rather than fixing it in place.

## Findings worth not rediscovering

- **`minecraft-data.items` is an OBJECT keyed by numeric id** — not an array, not keyed by
  name. `for (const item of data.items)` throws. Use `allItems()` in `src/world/mcdata.ts`.
- **`entitiesByName[x].category` is a plain STRING** in 26.2 (`"Hostile mobs"`), not an array.
  Reading only the array shape makes every mob look passive.
- **`prismarine-item`'s export is a LOADER**, not a class: `require('prismarine-item')(registry)`
  returns the Item class. Items are built from a **numeric id**; `new Item("bread", 1)` gives
  `name: "unknown"`. Its `slot` is set by the inventory, so an item handed to `bot.equip` must
  have one.
- **`bot.consume()` throws `Food is full` at food 20**, so never start an eat there.
- **`bot.dig(block)` throws on a null block** and on `digTime === Infinity`; it reads
  `block.position` and `block.name`.
- **`bot.toss(itemType, metadata, count)` has no zero-count guard of its own** — it relies on
  `bot.transfer`, which only throws on an empty source or a full destination.
- **26.2 crafts stone tools from `cobbled_deepslate`**, not from cobblestone.
- **`recipes.json` is keyed by RESULT id** and holds several rows per key; the first row for
  `crafting_table` is the cherry-planks one, so assert the shape, not the plank.
- **`items.json` cannot be filtered by `enchantCategories` to find armour**: chestplates carry
  only `equippable`/`armor`/`durability`/`vanishing`, with no `chest_armor`. Use name shape.
- **`minecraft-data@1.21.4` disagrees with itself about ids** (`foods` vs `itemsByName`), which
  is why everything reads the vendored 26.2 through `src/world/mcdata.ts`.
- **The secret scanner flags credential-shaped strings in ANY file**, including tests. Build
  fake keys from parts (`["sk","..."].join("-")`) — the scanner is not weakened, it just has
  nothing to find in the file.
- **`MemoryStore` holds the database open**, so a temp-dir cleanup on Windows needs an explicit
  `close()` before `rmSync`.

## Bugs the tests found this round (all fixed)

Each of these was a real defect, not a test problem:

| Found by | Bug |
| --- | --- |
| WP1 probes | `PathfinderModule.goals` declared only `GoalNear`, so `GoalFollow` was `undefined` and every follow silently failed |
| WP1 probes | `parseAddressedCommand` lower-cased the line then matched the name case-sensitively, so **no command worked at all** while the probes passed |
| WP2 tables | A material-tier tool ranking put **gold above iron** — the exact error the owner rejected for armour |
| WP3 tests | `isPlayerEntity`'s username regex matched `"zombie"`, so Elix refused to defend the owner against a zombie |
| WP3 tests | `bogged` was in the never-attacked list; the game data says it is hostile |
| WP3 tests | `entityCategories` read only the array shape and ignored 26.2's plain-string category |
| WP4 tests | `shouldCrouchGreet` used `0` as "never greeted", so nobody was greeted while the clock read 0 |
| WP6 tests | `parseRemember` accepted "home and follow me" as one place name — two instructions in one hat |
| WP7 tests | `.env` exists locally and is gitignored; the test asserted absence, which was the wrong invariant |
| WP7 tests | `canReturnJson` did not know `openai/gpt-oss`, the guard role's own first choice |
| WP9 tests | The localhost regex required end-of-string after `127.`, so `127.0.0.1` was reported as a **public** address |
| WP9 secrets | My own status test contained credential-shaped literals, and the scanner was right to flag them |

## Deviations this round (test changes I made)

- `tests/unit/craft.test.ts` - two assertions changed from `needsTable("crafting_table") === true`
  to `false`, and the same for `recipeFor("crafting_table").needsTable`. Reason: a 2x2 recipe is an
  inventory recipe; the old value made "make a crafting table" impossible. My own Round 17 tests,
  encoding the bug this backlog fixes.
- `src/skills/give.ts` - no test change, but `HAND_CRAFTABLE` in `craft.ts` gained
  `crafting_table`, which changes `needsTable()` behaviour on purpose (see above).
- Test fakes changed to be MORE faithful to mineflayer, never less: the gather/craft/give fakes
  now update `heldItem` on equip, because a fake that does not makes the weapon reflex re-equip
  every tick and any equip assertion then measures the reflex instead of the skill.

## Deviations

Changes to tests I wrote myself, each one encoded a bug or a rule this backlog changed.

- `tests/unit/actions.test.ts` — three changes, all WP1: the acknowledgement was asserted to go
  through `gateScriptedReply` (the Round 15 **bug** — it classifies its input as the player's
  words); the goal assertions described our own intent object rather than the library's real
  `GoalFollow`/`rangeSq`; and entity stubs were `{ id: 1 }`, which the real `GoalFollow`
  constructor throws on.
- `tests/unit/config.test.ts` — "uses only the two cloud providers plus builtin" and
  `removedVendorName()` both encoded the pre-WP7 world. The second used NVIDIA as its
  "removed vendor" fixture, so after WP7 re-added NVIDIA it would have fed the schema a REAL
  provider and proved nothing. Both now state the WP7 rule, and the guard-role list gained a
  `canReturnJson` assertion.
- `tests/unit/reflexes.test.ts` — my own new test asserted a `stop` leaves `endReason` null; a
  flee completes on its own tick, which is what `finished` records.
- `tests/unit/status.test.ts` — the fake key literals were assembled from parts because the
  secret scanner flags credential-shaped strings in any file. The scanner is untouched.

Production code changed outside the new-module rule — all wiring, signatures or types the
brief itself required:

- `src/connection/bot.ts` — the `PathfinderModule.goals` type, the spawn-walk gate, and the
  `ACKNOWLEDGEMENTS` table made `Partial` as WP5 actions were added.
- `src/actions/commands.ts` — `ActionName` grew the WP5/WP8 action names.
- `src/memory/store.ts` — WP6 added `places()`, `addDeath`, `lastDeath`, `deaths`,
  `deathCount`. Row type is spelled `Row` because `Record` is shadowed in that file.
- `src/core/config.ts` — the provider enum gained `nvidia` and `ollama`.
- `config/models.yaml`, `config/elix.yaml`, `.env.example`, `README.md` — WP7/WP9.

## Questions for the owner (none was a stop condition)

- **WP2:** the reflex tick runs on the existing 50 ms follow tick, and `armour` deliberately does
  **not** interrupt follow — picking up a better sword while walking is what Elix should do.
  Chosen; say if you want it to interrupt.
- **WP3:** the brief asked for hostile mobs "from minecraft-data entity categories, not a
  hand-written list". 26.2 *does* have `entitiesByName[x].category`, so `isHostileMob()` asks the
  data first and keeps the hand-written set only as the fallback for a missing data pack.
  `tests/unit/defend.test.ts` asserts every name in it agrees with the category.
- **`owners` is global** (agreed). A per-profile list would let a test profile grant itself.
- **WP10 command rows are opt-in** (agreed) via `--owners`, so a default run never grants
  command rights.
- **Still open from earlier rounds:** the owner's three manual in-game results are blank, and
  **both API keys need rotating** (`.env` is gitignored but has been on this machine a long
  time).

## Gates

At `3564c4e` (WP10):

```
pnpm typecheck  exit 0
pnpm lint       exit 0
pnpm test       Tests  1924 passed | 2 skipped (1926)
round13Probes 8   round14Probes 6   round15Probes 5   round16Probes 6
secret scan   9 passed
```

Progression this round: 1554 → 1620 → 1658 → 1691 → 1737 → 1772 → 1806 → 1835 → 1869 →
1895 → 1922 → **1924** passed.

## Notes for whoever picks this up

- `tests/unit/round12A1.test.ts` and `partA.test.ts > counts a timeout toward the circuit
  breaker` both contain **wall-clock / load-sensitive assertions**. Each failed once under
  full-suite parallel load and passed alone and on re-run. Do not widen a threshold to make
  them stable; the honest fix is fake timers for that measurement.
- CRLF trap: `git checkout`/`git clone` restore CRLF, so any script that string-matches source
  must `.replace(/\r\n/g,"\n")` first.
- Quoting trap in `.cjs` patch scripts: apostrophes in emitted TypeScript break single-quoted JS
  strings. The `write` and `edit` tools proved far more reliable in Round 17 — prefer them, and
  when a patch script throws "not found", the anchor almost always has different indentation
  than assumed. `Select-String -Context` shows **more** indentation than the file has.
- vitest swallows `console.log`; write diagnostics to a file with `writeFileSync`.
- `require()` is **not** available inside vitest test files (ESM). Import the module, or read
  the file with `readFileSync`.
- `packages/` test files cannot import a transitive dependency directly. `better-sqlite3` is
  resolved through `tests/unit/sqliteLoader.ts`, which fails loudly if it cannot find a driver.
### R18-C - what the gather rules cost, and two real bugs the tests found

- `GoalGetToBlock(x, y, z)` takes **three numbers**, not a position object. Passing an object
  silently yields NaN coordinates (`Math.floor({})` is NaN), so the goal paths nowhere. This is
  exactly the bug class the real-library contract rule exists for - the fake accepted a shape the
  real library rejects. Assert the goal's four per-tick methods AND its numeric fields.
- Player clearance is `<= PLAYER_CLEARANCE`, not `<`. "Within 2 blocks of a player" includes the
  block exactly two away; the test caught the boundary being read the other way.
- **Test-fake trap:** mineflayer's `heldItem` changes when you equip. A fake that does not update it
  makes the WEAPON reflex re-equip on every single tick - 149 equip calls for 5 digs - and any
  equip assertion then measures the reflex, not the skill. Keep heldItem faithful.
- To prove the GATHER equipped a pickaxe (not the reflex), hold a sword too: the reflex has a reason
  to equip the sword, so a pickaxe in hand afterwards can only have come from the dig.
- **A stop after a gather FINISHED proves nothing.** Ask for 64 items so the gather is still running
  when the stop lands.
### R18-D..R18-F - the real mineflayer API, read rather than assumed

- **`bot.placeBlock(referenceBlock, faceVector)` takes NO item.** It places the HELD item.
  So placing a table is equip-then-place, and a runtime that forgets the equip does nothing
  while looking like it worked. `docs/api.md` is explicit about this.
- **`bot.recipesFor(...)` is SYNCHRONOUS** and returns an array; `bot.craft(recipe, count, table)`
  THROWS `Recipe requires craftingTable` when the table argument is null. The recipe object handed
  to `craft` must come from `bot.recipesFor` - minecraft-data's recipe is a DIFFERENT shape and
  the real library would reject it while every fake accepted it.
- **`GoalGetToBlock(x,y,z)` and `GoalNear(x,y,z,range)` take NUMBERS.** Passing a position object
  gives NaN coordinates through `Math.floor`, and Elix walks confidently in the wrong direction.
- **A crafting table is a 2x2 recipe**, i.e. the INVENTORY grid. Round 17 listed it as needing a
  table, which made "make a crafting table" impossible. Changed `HAND_CRAFTABLE`; two of my own
  Round 17 assertions said the opposite and were corrected (see Deviations).
- **`bot.toss(itemType, metadata, count)` / `window.deposit(itemType, metadata, count, nbt)`.**
  The chest is a one-way door: `giveRuntime.ts` contains no `withdraw` call and a test asserts
  that at the source level as well as in behaviour.
- **A regression the read-only round16 probe caught:** `parseGoTo` listed `come` as a verb, so
  "elix come here" became "walk to a place called here" and the real follow command never ran.
  Removed `come`, and moved world memory AFTER `parseAddressedCommand` so no parser added later
  can shadow follow/come/stop.
- **The place book lives in MEMORY first and the store second.** A session with no store (every
  bare unit test, and a bot whose data dir does not exist yet) must still remember a place told
  to it thirty seconds ago, or "remember this place" silently does nothing.

