# ROUND 19 — LONG RUN (plan for 5+ hours of continuous work)

You are continuing the Elix project at 8807eb8. The reviewer re-ran Round 18 on a fresh clone: typecheck 0, lint 0, 2027 passed / 2 skipped, and every probe file is green and unchanged. The wiring audit was a good idea and it worked: every Round 18 feature is now reachable from chat.

But the reviewer then ran the skills **at real speed**, and most of them do not work in a real game yet. The Round 18 fakes resolve `dig`, `toss`, `openContainer`, `placeBlock` and `craft` in the same microtask, and the fake pathfinder never moves. Real ones take hundreds of milliseconds to seconds. On top of that, the real mineflayer-pathfinder **clears the path and the control states on every `setGoal`** (`index.js` `resetPath('goal_updated')`, `clearStates = true`).

`tests/unit/round19Probes.test.ts` uses a fake bot with real timing and real mineflayer rules. On 8807eb8, **5 fail and 1 passes**:

- **Z1, gather.** `step()` runs every 50 ms with no in-flight guard and no arrival check. It digs 50 ms after setting the walk goal, out of reach, and the next tick's `dig` aborts the first one (mineflayer `digging.js` line 127). The gather ends with nothing gathered.
- **Z2, give from far away.** `walkToAsker()` calls `setGoal` on every tick (measured: 400 resets in 20 s), so the real pathfinder never moves Elix. Nothing is given.
- **Z3, give from close by.** `toss()` is re-entered while the first toss is awaited, so the owner gets the item 7 times.
- **Z4, deposit.** It never starts. `bot.findBlocks` returns **coordinates, not blocks** (mineflayer `docs/api.md`), but `chestViewOf()` reads `found[0].position`, which is always undefined, so every chest is "too far". Behind that, `chestNear()` passes that Vec3 to `openContainer()`, which needs a Block, and `openContainer` would be re-entered every tick.
- **Z5, craft.** `run()` advances the plan synchronously on each tick, so "crafting" starts while "place-table" is still awaiting `placeBlock`. It finds no table and refuses ("nowhere here to put a crafting table").

Make all 6 pass by fixing the CODE.

---

## 0. How to work for a long time without stopping

**Step 0, before anything else:** overwrite `docs/LONG_RUN_BRIEF.md` with this whole message, unchanged, and commit it as `docs: round 19 brief`. After any reset, compaction or restart, read `docs/LONG_RUN_BRIEF.md` and `PROGRESS.md` first, and continue from the first unfinished item.

1. **Permissions are pre-approved, and questions are disabled.** Never wait for approval and never ask. Write questions into `PROGRESS.md`, take the safest default, record it under "Deviations", and keep going.
2. **Fresh-clone gate inside the workspace**, as in Round 18 (`.fresh/elix`, gitignored). Run it at the end of **every** item.
3. **One item at a time, no reports in between.** For each item:
   1. Write the acceptance tests first and watch them fail.
   2. Implement.
   3. Run the working-tree gates, then the fresh-clone gate, then `secrets.test.ts`.
   4. Commit as `R19-<letter>: <title>`.
   5. Update `PROGRESS.md`.
   6. **Go straight to the next item.**
4. **Partial beats blocked.** **90-minute time box** per item; after that, reset to the last item commit and mark the item BLOCKED. Never commit red.
5. **Stop only when:**
   - every item is DONE, PARTIAL or BLOCKED;
   - a gate cannot be made green even after reverting; or
   - a step needs a secret, a push, or deleting anything outside the repo.

---

## 1. Definition of DONE (Round 18's rule plus a real-speed rule)

An item is DONE only when **all** of these hold:
- A `BotSession`-level test drives it from its real trigger to a real mineflayer call.
- **NEW: that test uses a real-speed fake.**
  - Every async action takes time (`dig` ≥ 1 s, `toss`, `openContainer` and `placeBlock` ≥ 300 ms).
  - A second `dig` aborts the first.
  - `setGoal` restarts the walk, and arrival happens only if the goal is left alone.
  - `findBlocks` returns **Vec3 coordinates**.
  - `openContainer` rejects anything that is not a Block.

  Put this fake in ONE shared helper (`tests/helpers/realSpeedBot.ts`) and use it for every skill test. Instant fakes may stay for pure logic tests only.
- Every export has a production caller (the wiring audit stays green).
- The fresh-clone gate is green.

---

## 2. Hard rules (these apply to every item)

- **Read-only files:** `tests/unit/round13Probes.test.ts`, `round14Probes.test.ts`, `round15Probes.test.ts`, `round16Probes.test.ts`, `round18Probes.test.ts` and `round19Probes.test.ts`. Never edit their assertions, delays or timeouts. They must all stay green after every WP.
- **Never weaken an existing test to make it pass.** You may change a test you wrote yourself **only** when it encodes a bug this backlog is fixing. Each such change must be listed under "Deviations" with a one-line reason.
- **Mineflayer-shaped data.** In tests, a player is `{ username, entity?: { position: Vec3, isValid, ... } }`, and positions are real `Vec3` objects from the `vec3` package. Mobs are mineflayer `Entity`-shaped (`name`, `type`, `position: Vec3`, `isValid`, `health` where relevant). No `as` casts on mineflayer objects; use runtime guards.
- **NEW: real-library contract rule.** Anything handed to a third-party library (pathfinder goals, `Movements`, `bot.equip` / `bot.dig` / `bot.craft` / `bot.toss` arguments, `minecraft-data` lookups) must be checked against the **real** library in at least one test. A fake must never accept something the real library would reject. Round 15 shipped 22 green tests while every goal it built crashed the real pathfinder on the first tick.
- **Every line Elix sends goes through the existing gates:**
  - a reply to a player's line uses the sender gate (`gateReply` / `awaitSenderAudits`);
  - **Elix's own words** (acknowledgements, initiative lines, skill progress lines) use `gateOwnLine(player)` — **never** `gateScriptedReply`, which classifies its input as the player's words;
  - a line the wellbeing floor matches **never** triggers any action;
  - a dropped reply drops its actions too.
- **`stop` wins over everything, within one tick.** Every new action, skill and reflex must be cancellable by `elix stop` within 50 ms, and must leave nothing half-running.
- **Good-friend rules, enforced in code:**
  - never attack a player, a pet, a villager, an iron golem or a passive mob;
  - never take items out of a chest;
  - never place lava, fire or TNT;
  - never dig a block that is not on the natural-block allow-list (WP5);
  - never dig within `protectedRadius` (default 24) of a remembered place (WP6);
  - only owners can command;
  - commands must be addressed to Elix.
- **New code goes in new modules.** `bot.ts` is now 3,006 lines and `bridge.ts` is 1,640. R19-C splits them; after that, no file may grow past 800 lines.
- **No new runtime dependencies** unless written down in `DECISIONS.md` with a reason. Prefer small in-house code over adding `mineflayer-pvp` and similar packages. `mineflayer-pathfinder`, `vec3` and the vendored `minecraft-data` are already available.
- **Never** push, touch `.env`, print, log or commit a key, or commit the server IP anywhere new.
- **Honesty in `PROGRESS.md`.** If something was not run, it says ❌. A test that only exercises a fake does not count as "live".

---

## 3. The backlog (in this order)

### R19-A — Skills at real speed (probes Z1–Z5)

Build ONE shared base for every skill runtime (`src/skills/runtime.ts`) and move gather, give, deposit and craft onto it:
- **An in-flight guard.** A tick never starts a step while the previous step's promise is still pending. The tick only checks "busy? then skip".
- **Arrival before action.** After `setGoal`, wait until within reach: distance ≤ 4 for dig/place/open, ≤ `GIVE_RANGE` for toss. Use the distance check on the tick (or `goal_reached`) before digging, tossing, opening or placing.
- **`setGoal` only when the goal changes.** Same target, same goal: do nothing. A moving target (the asker) gets a new goal only when it has moved more than 2 blocks since the last one.
- **Craft advances one step only after the previous step has resolved.**
- **Chests:** use `bot.blockAt(position)` to turn each `findBlocks` coordinate into a Block before reading `.name` or calling `openContainer`. Fix `chestViewOf` the same way.
- **Stop:** clears the in-flight step, calls `bot.stopDigging()` and `pathfinder.stop()`, and the next tick does nothing.
- **Tests:** `round19Probes` 6/6, plus your own real-speed `BotSession` tests per skill:
  - stop mid-walk and mid-dig;
  - the asker moves while Elix walks;
  - a chest that is a coordinate (`findBlocks`) resolves to a Block;
  - a craft that needs two steps.

### R19-B — The mineflayer contract file

Create `docs/MINEFLAYER_CONTRACTS.md`: one line per API Elix uses, with the source line or docs section. It must cover at least:
- `findBlocks` returns coordinates;
- `findBlock` returns a Block;
- `openContainer` needs a Block or Entity;
- `placeBlock(reference, face)` places the **held** item;
- `dig` aborts a running dig;
- `stopDigging`;
- `setGoal` resets the path and the control states;
- `GoalNear` / `GoalGetToBlock` take numbers;
- `toss(type, metadata, count)`;
- `recipesFor` is synchronous;
- `craft` needs the table Block for 3×3 recipes;
- `oxygenLevel`, `food` and `health` are 0–20;
- `whisper(username, text)`.

Then add `tests/unit/mineflayerContracts.test.ts`, where every line is checked against the real installed library (source or behaviour), and make `realSpeedBot.ts` obey every line.

Then **audit every existing test fake** for these mistakes, especially `findBlocks` returning blocks. Fix the fakes, and list each one fixed under Deviations.

### R19-C — Split `bot.ts` and `bridge.ts` (no behaviour change)

`bot.ts` grew from 2,411 to 3,006 lines this round. Split it now, before more features land:
- out of `bot.ts`, into `src/connection/`: chat dispatch, skill dispatch, the tick loop, presence, initiative wiring and crash guards;
- out of `bridge.ts`, into `src/brain/`: audit store and gate, chat reply, wellbeing reply and tool-call execution.

Target: no file over 800 lines, and add a test that enforces that for `src/`. Test changes are allowed only in import paths. Every probe and the wiring audit must stay green. If a step would change behaviour, stop that step, keep the ones done, and mark the item PARTIAL with the remaining steps listed.

### R19-D — First-run wizard (was R18-J)

- `pnpm elix setup` (and `elix.cmd setup`):
  - asks for the owner's Minecraft name and writes `owners` in `config/elix.yaml`, keeping comments;
  - checks which keys exist in `.env` **by name only**, never printing values;
  - runs `elix doctor`, which now also checks Ollama reachability;
  - prints the next three steps in plain words.
- Tests with a temp project dir.

### R19-E — Sleep when the owner sleeps (was R18-K)

As specified in Round 18, built on the R19-A runtime base, with a real-speed `BotSession` test (`bot.sleep(bedBlock)`, `wake`).

### R19-F — First real Minecraft progression step: smelting and iron tools

- "elix make an iron pickaxe" plans and runs the whole chain, each step on the R19-A base:
  1. gather iron ore (allow-list);
  2. find or craft and place a furnace;
  3. smelt with `bot.openFurnace(furnaceBlock)`, `putFuel`, `putInput` and `takeOutput`;
  4. craft sticks if needed, then craft the pickaxe on a table.
- Missing materials get one honest line naming what is missing.
- Real-speed `BotSession` tests; contract lines for the furnace API.

### R19-G — e2e rows for the owner

Update `scripts/e2e-chat.ts` so the owner can run one command that walks through: get dirt, give, chest deposit, craft a wooden pickaxe, remember and where-is. Write the exact command into the report. Do not run it if you cannot reach the server.

### R19-H — (stretch) Voice, step 1 (was R18-M)

Offline-testable packet encoding and decoding and the Opus frame pipeline from `docs/VOICE_PLAN.md`, **disabled by default**.

---

## 4. The final report (only once, at the very end)

1. Fresh-clone and working-tree gates on the final commit.
2. An item table: status by the §1 definition, commit, tests added, minutes.
3. Probe files: round13 / 14 / 15 / 16 / 18 / 19 results.
4. The contract file, and the list of test fakes it forced you to fix.
5. The line counts of `bot.ts`, `bridge.ts` and the largest file in `src/`.
6. Deviations, and questions for the owner.
7. **Live-test steps for the owner, only for DONE items**, with the expected results.
8. The vision checklist with Code / Real-speed test / Live columns.
9. Secret scan, run immediately before the final commit. Do not push.

---

## Appendix — the probe file

`tests/unit/round19Probes.test.ts` was added verbatim from the reviewer's message and is READ-ONLY. Its header, in full:

> Round 19 — reviewer probes against 8807eb8: the skills at REAL SPEED.
>
> Every test asserts the WORKING behaviour. On 8807eb8 every test except the fixture check FAILS. Do not edit an assertion, delay or timeout. Fix the code.
>
> The Round 18 fakes resolve dig / toss / openContainer / placeBlock / craft in the same microtask, and the fake pathfinder never moves. The real ones take hundreds of ms to seconds, and the real mineflayer-pathfinder CLEARS the path and the control states on every setGoal (index.js resetPath('goal_updated'), clearStates = true). This fake bot keeps those two properties:
>
> - every action takes real (fake-timer) time;
> - dig() while a dig is running ABORTS the first one with "Digging aborted", exactly like mineflayer lib/plugins/digging.js line 127;
> - setGoal() restarts the walk; Elix only arrives if the goal is left alone for 1 s.
>
> What fails on 8807eb8, and why:
>
> - **Z1** gather: step() runs every 50 ms with no in-flight guard and no arrival check. It digs 50 ms after setting the walk goal - out of reach - and the next tick's dig aborts the first, which ends the gather. Nothing is ever gathered.
> - **Z2** give (asker 12 blocks away): walkToAsker() calls setGoal on every 50 ms tick, so the real pathfinder never gets to move. Elix never arrives; nothing is given.
> - **Z3** give (asker close): toss() is re-entered while the first toss is awaited, so the owner gets the item several times.
> - **Z4** deposit: never starts. bot.findBlocks returns COORDINATES (mineflayer docs/api.md: "the found block coordinates (not the blocks)"), but chestViewOf() reads found[0].position - always undefined - so every chest is "too far". Behind that, GiveRunner.chestNear() hands that Vec3 to openContainer(), which needs a Block, and openContainer() is re-entered on every 50 ms tick while the first open is awaited.
> - **Z5** craft: run() advances the plan synchronously each tick, so "crafting" starts while "place-table" is still awaiting placeBlock, finds no table, and refuses.

The full source is at `tests/unit/round19Probes.test.ts`, byte-for-byte as the reviewer wrote it.
