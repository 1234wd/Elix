# ROUND 20 — LONG RUN (built to go faster)

You are continuing Elix at 9e14c28. The reviewer re-ran Round 19 on a fresh clone: typecheck 0, lint 0, 2103 passed / 2 skipped, every probe file green and unchanged. Gather, give, deposit and craft now pass the real-speed probes. The shared `realSpeedBot` helper and the contract file are exactly the right tools; keep using them.

This round runs inside an **automatic loop**. The owner starts `run-elix-agent.cmd`, which runs `opencode run --auto` again and again. Each session starts fresh and continues from `PROGRESS.md`. **You do not need to finish everything in one session.** Do one item properly, commit, update `PROGRESS.md`, and carry on until the session ends. The next session picks up where you stopped.

The reviewer found one new problem, in sleep. `tests/unit/round20Probes.test.ts` fails 3 of 5 on 9e14c28:
- **W1.** "Owner in bed" is approximated as "an owner within 16 blocks of ANY bed". So at night near home, Elix gets into bed while the owner is awake. On a server, one sleeper does not skip the night, so he lies there until morning: no follow, no defend. mineflayer reports a real sleeper with the **`entitySleep`** event, and `entityWake` when they get up.
- **W3.** Nothing ever calls **`bot.wake()`**. When a zombie comes close, the sleep runtime only clears its own flag. In the game Elix is still in the bed and cannot move.
- **W4.** The same for "elix follow me" while asleep: he must get out of bed before walking.
- W2 is the positive control and already passes.

---

## 0. How to work (faster than last round)

**Step 0, once:** if `docs/LONG_RUN_BRIEF.md` does not already start with "# ROUND 20", overwrite it with this whole message, unchanged, and commit it as `docs: round 20 brief`. Every session starts by reading `docs/LONG_RUN_BRIEF.md` and `PROGRESS.md`.

1. **Permissions are pre-approved, and questions are disabled.** Never wait and never ask. Write questions into `PROGRESS.md`, take the safest default, and keep going.
2. **Faster gate cadence:**
   - **While working on an item:** run only the test files you touched or that cover the code you changed (`pnpm exec vitest run <files>`), plus `pnpm typecheck`.
   - **Before every commit:** the full working-tree gate (`pnpm typecheck`, `pnpm lint`, `pnpm test`) and `secrets.test.ts`.
   - **Fresh-clone gate (`.fresh/elix`):** after R20-A, after every **third** item after that, and before the final report. Not after every item.
3. **Keep context small.** Never read a whole file over 400 lines. Use `grep -n` and read only the ranges you need. R20-A comes first because it makes every later item cheaper.
4. **Keep `PROGRESS.md` short.** Use one line per item: status, commit, test count. Add a "RESUME HERE" line naming the exact next step. Do not paste reports into it.
5. **One item at a time:**
   1. Write the acceptance tests first and watch them fail.
   2. Implement.
   3. Run the gates.
   4. Commit as `R20-<letter>: <title>`.
   5. Update `PROGRESS.md`.
   6. Go to the next item.
6. **90-minute time box** per item. After that, reset to the last commit, mark the item BLOCKED with the reason, and move on. Never commit red.
7. **When every item is DONE, PARTIAL or BLOCKED:**
   1. run the final fresh-clone gate;
   2. write the final report (§4) to `docs/ROUND20_REPORT.md`;
   3. commit;
   4. add the line `ROUND 20 COMPLETE` as the last line of `PROGRESS.md`.

   That line stops the loop.

---

## 1. Definition of DONE (unchanged from Round 19)

- A real-speed `BotSession` test, using `tests/helpers/realSpeedBot.ts`, drives the feature from its real trigger to a real mineflayer call.
- Every export has a production caller (the wiring audit stays green).
- The gates are green at the cadence in §0.2.

Add to `realSpeedBot.ts` whatever new mineflayer behaviour an item needs (sleep and wake, `entitySleep`, the furnace API), and add a line to `docs/MINEFLAYER_CONTRACTS.md` with its test.

---

## 2. Hard rules (these apply to every item)

- **Read-only files:** `tests/unit/round13Probes.test.ts`, `round14Probes.test.ts`, `round15Probes.test.ts`, `round16Probes.test.ts`, `round18Probes.test.ts`, `round19Probes.test.ts` and `round20Probes.test.ts`. Never edit their assertions, delays or timeouts. They must all stay green after every WP.
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
- **No file in `src/` may be over 800 lines** once R20-A is done, and a test enforces it.
- **No new runtime dependencies** unless written down in `DECISIONS.md` with a reason. Prefer small in-house code over adding `mineflayer-pvp` and similar packages. `mineflayer-pathfinder`, `vec3` and the vendored `minecraft-data` are already available.
- **Never** push, touch `.env`, print, log or commit a key, or commit the server IP anywhere new.
- **Honesty in `PROGRESS.md`.** If something was not run, it says ❌. A test that only exercises a fake does not count as "live".

---

## 3. The backlog (in this order)

### R20-A — Split `bot.ts` and `bridge.ts` FIRST (no behaviour change)

`bot.ts` is 3,143 lines and `bridge.ts` 1,640. Every later item reads and edits these files, so splitting them first makes the rest of the round faster and cheaper.
- Use the four-step plan already in `PROGRESS.md` under "R19-C". Commit after **each step** (`R20-A1` … `R20-A4`), each with a full green gate, so a partial split is still progress.
- Target: no file in `src/` over 800 lines. Add `tests/unit/fileSize.test.ts` that enforces this for all of `src/`. Add it only once every file passes; until then, list the remaining files in `PROGRESS.md`.
- Test changes are allowed only in import paths. Every probe file and the wiring audit stay green.

### R20-B — Sleep like a friend (probes W1–W4)

- Track which players are really asleep from `entitySleep` / `entityWake`, and clear the list on respawn and disconnect. "Owner in bed" means an owner in that set.
- `bot.wake()` is called, and awaited, before anything that needs Elix to move:
  - a hostile within 8 blocks;
  - any command (follow, come, gather, give, craft and the rest);
  - a tool call;
  - `elix stop`;
  - the owner waking up (`entityWake`).

  Never call `setGoal` while `bot.isSleeping` is true.
- If `bot.sleep` throws (monsters nearby, not night), wait 30 s before trying again. Never retry on every tick.
- Real-speed `BotSession` tests for each case, plus `round20Probes` 5/5.

### R20-C — Move the last instant-fake tests onto `realSpeedBot`

Place memory ("take me to", "where is", "where did I die") and the model tool-call tests still use instant fakes (your own Round 19 note). Move them onto the real-speed helper, and fix anything that breaks. Tool-call actions must go through the same runtime base as typed commands, including the in-flight guard.

### R20-D — Smelting and an iron pickaxe (was R19-F)

- "elix make an iron pickaxe" plans and runs the whole chain, each step on the runtime base:
  1. gather iron ore;
  2. find, or craft and place, a furnace;
  3. smelt with `bot.openFurnace(furnaceBlock)`, `putFuel`, `putInput`, waiting for the output, then `takeOutput`;
  4. sticks if needed;
  5. the pickaxe on a table.
- Missing materials get one honest line naming what is missing. Add contract lines for the furnace API, and real-speed tests.

### R20-E — More useful crafting chains

- "elix make torches" (coal or charcoal plus sticks).
- "elix make stone tools" (pickaxe, axe and sword from cobblestone).
- "elix make a chest".
- "elix make a furnace".

Each one reuses the R20-D planner, missing materials get one honest line, and each has a real-speed test.

### R20-F — Voice, step 1 (no longer a stretch: voice is a big part of the owner's vision)

Do the offline-testable half of `docs/VOICE_PLAN.md`:
- Simple Voice Chat packet encoding and decoding, built from the plugin's source for the pinned 26.2 build. Write the source references into the contract file.
- AES encrypt and decrypt round trips.
- The Opus 48 kHz / 20 ms frame pipeline, tested with constructed audio.

Everything stays behind `voice.enabled` (default false). No voice code runs when it is false, and a test proves that. Live voice comes in a later round.

---

## 4. The final report (written to `docs/ROUND20_REPORT.md`)

1. Fresh-clone and working-tree gates on the final commit.
2. An item table: status, commits, tests added, minutes.
3. Probe files: round13 / 14 / 15 / 16 / 18 / 19 / 20 results.
4. Line counts: the largest five files in `src/`.
5. Deviations, and questions for the owner.
6. **Live-test steps for the owner, only for DONE items**, with the expected results.
7. The vision checklist with Code / Real-speed test / Live columns.
8. Secret scan, run immediately before the final commit. Do not push.

---

## Appendix — the probe file

`tests/unit/round20Probes.test.ts` was added verbatim from the reviewer's message and is READ-ONLY. Baseline on `9e14c28`: **3 failed / 2 passed** (W1, W3 and W4 fail; the fixtures check and W2 pass). Its header, in full:

> Round 20 — reviewer probes against 9e14c28: sleeping like a friend, not like a rock.
>
> Every test asserts the WORKING behaviour. On 9e14c28, W1, W3 and W4 FAIL; W2 is the positive control. Do not edit an assertion, delay or timeout. Fix the code.
>
> - **W1** "owner in bed" is approximated as "an owner within 16 blocks of ANY bed", so at night near home Elix climbs into bed while the owner is awake and playing. A lone sleeper does not skip the night on a server, so he lies there until morning: no follow, no defend. mineflayer reports a real sleeper with the "entitySleep" event (docs/api.md), and "entityWake" when they get up.
> - **W2** positive control: after the owner really sleeps ("entitySleep"), Elix walks to a free bed and calls bot.sleep(bedBlock).
> - **W3** nothing ever calls bot.wake(). When a zombie comes close, the sleep runtime only clears its own flag - in the game Elix is still lying in the bed and cannot move.
> - **W4** same for "elix follow me" while he is asleep: he must get up (bot.wake()) first.

The full source is at `tests/unit/round20Probes.test.ts`, byte-for-byte as the reviewer wrote it.
