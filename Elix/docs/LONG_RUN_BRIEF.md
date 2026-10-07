# ROUND 18 — LONG RUN (plan for 5+ hours of continuous work)

You are continuing the Elix project at ba2c275. The reviewer re-ran everything on a **fresh clone** and read the wiring. Round 17 wrote a lot of good, well-tested logic: the reflexes, defend, gaze, the armour and damage tables, and the twelve bugs you found and fixed. But **much of it is not connected to the running bot**, and that changes what "done" means from now on.

What the reviewer measured on ba2c275:
- **Fresh clone fails: 3 tests.** `craft.test.ts`, `gather.test.ts` and `give.test.ts` read mineflayer from a hard-coded, machine-specific pnpm path (`node_modules/.pnpm/mineflayer@4.39.0_patch_has_35aecf.../...`). That path only exists on your Windows machine.
- **Not wired (no production caller):**
  - gather, craft and give: there is no `bot.dig`, `bot.craft` or `bot.toss` anywhere in `src/`;
  - places, where-is and where-did-I-die: `parseRemember`, `parseWhereIs` and `parseWhereDied` are never called, and `bot.whisper` is never called;
  - tool calls: `parseToolCalls` is only used inside `toolCalls.ts`;
  - NVIDIA and Ollama: `buildBrain()` only constructs `groq` and `hf`.

  None of the 370 new tests drive a `BotSession`. Your live-test table told the owner to type `elix get 10 cobblestone`, `elix give me <item>` and `elix remember this place as testspot`. All three go to the chat model, and nothing happens.
- **Breathe reflex uses the wrong scale.** It assumes oxygen runs 0–300 (`LOW_OXYGEN = 120`). mineflayer's `bot.oxygenLevel` is 0–20 (`lib/plugins/breath.js`: `Math.round(air / 15)`). So in any water, at full air, "breathe" fires on every tick and outranks follow and defend. When it fires, `swim-up` only looks up and never presses jump.
- **Wired and plausible:** the reflex runner (eat, armour, creeper), defend (`bot.attack`), gaze and crouch, and follow / come / stop.

The reviewer added `tests/unit/round18Probes.test.ts`. On ba2c275, **8 fail and 1 passes** (X0–X7, listed in the probe file's header). Make all 9 pass by fixing the CODE.

---

## 0. How to work for a long time without stopping

**Step 0, before anything else:** overwrite `docs/LONG_RUN_BRIEF.md` with this whole message, unchanged, and commit it as `docs: round 18 brief`. If your context is reset, compacted or restarted, read `docs/LONG_RUN_BRIEF.md` and `PROGRESS.md` first, and continue from the first unfinished item.

1. **Permissions are pre-approved, and questions are disabled.** Never wait for approval. Never ask. Write questions into `PROGRESS.md`, take the safest default, record it under "Deviations", and keep going.
2. **The fresh-clone gate runs INSIDE the workspace.** Last session you lost it because the temp directory is outside the allowed folders.
   - Add `.fresh/` to the root `.gitignore`.
   - Clone with `git clone . .fresh/elix` from the git root, then run `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint` and `pnpm test` inside `.fresh/elix/Elix`.
   - Run this gate at the end of **every** item, not only at the end of the round. Delete `.fresh/` and re-clone each time.
3. **One item at a time, no reports in between.** For each item:
   1. Write the acceptance tests first and watch them fail.
   2. Implement.
   3. Run the working-tree gates, then the fresh-clone gate, then `secrets.test.ts`.
   4. Commit as `R18-<letter>: <title>`.
   5. Update `PROGRESS.md`.
   6. **Go straight to the next item.**
4. **Partial beats blocked.** If part of an item is blocked, finish the rest, commit, mark it PARTIAL with the reason, and move on.
5. **Time box: 90 minutes per item.** If gates are not green after 90 minutes, `git reset --hard` to the last item commit (local only), mark the item BLOCKED with the failing test and why, and move on. Never commit red.
6. **Stop only when:**
   - every item is DONE, PARTIAL or BLOCKED;
   - a gate cannot be made green even after reverting; or
   - a step would need a secret, a push, or deleting anything outside the repo.

   A question, low context, or "this is hard" is never a stop.

---

## 1. The new definition of DONE (this round's most important rule)

An item is **DONE** only when **all** of these hold:
- A **`BotSession`-level test** drives the feature from its real trigger (a chat line, a tick, or a server event) through to a **real mineflayer API call** on a mineflayer-shaped fake bot. For example: `bot.dig(block)`, `bot.toss(type, metadata, count)`, `bot.whisper(name, text)`, `bot.pathfinder.setGoal(realGoal)`, `bot.setControlState("jump", true)`.
- Every exported function in the new modules has a **production caller**, or an entry in the wiring allow-list (R18-I) with a one-line reason.
- The **fresh-clone gate** is green.

A feature that only has module-level tests is **PARTIAL**, never DONE. In the final report, the owner's live-test list may only contain features that are DONE by this definition.

---

## 2. Hard rules (these apply to every item)

- **Read-only files:** `tests/unit/round13Probes.test.ts`, `round14Probes.test.ts`, `round15Probes.test.ts`, `round16Probes.test.ts` and `round18Probes.test.ts`. Never edit their assertions, delays or timeouts. They must all stay green after every WP.
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
- **New code goes in new modules.** `bot.ts` (2,411 lines) and `bridge.ts` (1,532 lines) only get wiring lines until R18-L splits them.
- **No new runtime dependencies** unless written down in `DECISIONS.md` with a reason. Prefer small in-house code over adding `mineflayer-pvp` and similar packages. `mineflayer-pathfinder`, `vec3` and the vendored `minecraft-data` are already available.
- **Never** push, touch `.env`, print, log or commit a key, or commit the server IP anywhere new.
- **Honesty in `PROGRESS.md`.** If something was not run, it says ❌. A test that only exercises a fake does not count as "live".

---

## 3. The backlog (in this order)

### R18-A — Portability (probe X0)
- Replace the hard-coded `node_modules/.pnpm/...` paths in `craft.test.ts`, `gather.test.ts` and `give.test.ts` with `createRequire(import.meta.url).resolve("mineflayer/lib/plugins/<file>.js")`. If the package's `exports` blocks deep paths, resolve `mineflayer/package.json` and join from its directory.
- Prefer calling the real function over reading its source text, where possible.
- Set up the in-workspace fresh-clone gate (§0.2) and run it.

### R18-B — Reflex units against mineflayer (probes X1, X2)
- `bot.oxygenLevel` is 0–20. Re-base the breathe threshold on that scale (e.g. low at ≤ 6), and remove the 300 fallback.
- `swim-up` must press `jump` (`bot.setControlState("jump", true)`) while active and release it when done. It must never leave jump held after a stop.
- **Audit every number the reflexes and defend read** against `node_modules/mineflayer/docs/api.md`: `health` 0–20, `food` 0–20, `foodSaturation`, `oxygenLevel` 0–20, `entity.isInWater`, entity `health` when present. Add one test per field that names its documented range.

### R18-C — Wire gather (probe X3)
- Chat: owner-only, addressed, whole-intent, using the same parser rules as follow/come/stop. "elix get 5 dirt", "elix get wood", "elix mine 10 stone" run the skill. Nothing reaches the chat model.
- **Protection rule update:** now that places exist, protect remembered places (`protectedRadius`, default 24). **Do not** protect the owner's surroundings. Gathering next to the owner must work. Never dig the block another player stands on, or any block within 2 blocks of another player (Elix himself does not count).
- Runtime: find a candidate with `bot.findBlocks`, walk there with a **real** `GoalGetToBlock` or `GoalNear`, equip the best tool from `harvestTools` (`bot.equip`), call `bot.dig(block)`, and collect the drops by walking over them. Cap at 64 items or 5 minutes. Progress lines go through `gateOwnLine`, at most one every 60 s. `elix stop` cancels it within one tick, including mid-dig (`bot.stopDigging()`).
- **BotSession tests:** owner's line → `setGoal` and then `dig` on an allow-listed block; a non-owner gets nothing; the wellbeing floor beats it; stop cancels a dig in progress; a block inside a remembered place's radius is refused.

### R18-D — Wire craft
- "elix make a crafting table", "elix craft 4 sticks", "elix make a wooden pickaxe" use the real `bot.recipesFor(itemId, null, 1, table)` and `bot.craft(recipe, count, table)` with vendored 26.2 data.
- Place a crafting table only on a valid solid block next to Elix (`bot.placeBlock`), and pick it back up after.
- **BotSession tests:** a recipe is found and `craft` is called with the real argument order; missing materials get one honest line and no craft; stop cancels.

### R18-E — Wire give and deposit (probe X4)
- "elix give me <item> [count]" → walk to the asker (real `GoalNear`), then, on arrival (`goal_reached`, or the distance check on the tick), `bot.toss(type, null, count)`. Only to the asker.
- "elix put your stuff in the chest" → `bot.openContainer(chestBlock)`, then `container.deposit(...)` for each stack, then `container.close()`. **Never withdraw.**
- **BotSession tests** for both, including "never withdraw" and stop.

### R18-F — Wire world memory (probe X5)
- "elix remember this place as <name>", "elix where is <name>", "elix take me to <name>" / "go to <name>", and "elix where did i die" use the memory store's `places` table and the death events (`bot.on("death")`, plus `entityDead` for players).
- Coordinates go **only** to owners, **only** by `bot.whisper`. Public chat gets a short line with no numbers.
- **BotSession tests** for each line, plus: no public line ever matches a three-integer coordinate pattern; and a non-owner asking "where is home" gets nothing useful.

### R18-G — Wire model tool calls (probe X6)
- The bridge parses the fenced `tool_calls` block from the model's reply, **strips it from the text before anything is said**, and hands valid calls to the **same executor** the chat commands use. One code path, so the allow-list, owner-only rule, protection rules and stop all apply identically.
- The owner's system prompt documents the tool format briefly. A non-owner's prompt does not mention tools at all.
- A dropped reply (any gate) drops its calls. Gentle mode allows only `stop` and `follow`. Rate limits as before.
- **BotSession tests** with a real `ChatBridge` and a fake fetch, like the probe: owner → executed; non-owner → ignored; the block never appears in chat; a dropped reply executes nothing.

### R18-H — Wire NVIDIA and Ollama (probe X7)
- `buildBrain()` constructs `nvidia` when `NVIDIA_API_KEY` is set.
- `ollama` is added only after an async reachability probe at startup (`GET http://127.0.0.1:11434/v1/models`, 1 s timeout). It is silently absent otherwise.
- `elix doctor` reports both.
- Tests: the providers map with each env combination; the full fall-through order through `buildBrain` (not just through the router with hand-built providers).

### R18-I — Wiring audit (stops this class of bug for good)
- Add a test that lists every exported function in `src/skills/`, `src/world/`, `src/reflexes/`, `src/brain/toolCalls.ts`, `src/brain/providers/` and `src/humanizer/`, and fails if one is imported by nothing outside its own module and tests.
- The allow-list (`tests/unit/wiring-allowlist.ts`) holds each intentional exception with a one-line reason. Pure helpers used inside their own module should not be exported at all.

### R18-J — First-run wizard for a non-technical owner
- `pnpm elix setup` (and `elix.cmd setup`) does the following:
  - asks for the owner's Minecraft name and writes `owners` in `config/elix.yaml`, keeping comments;
  - checks which keys are present in `.env` **by name only**, never printing values;
  - runs `elix doctor`;
  - prints the next three steps in plain words.
- Tests with a temp project dir; no real `.env` is read in tests.

### R18-K — Sleep when the owner sleeps
- At night, if an owner is in a bed within 16 blocks and a free bed is within 16 blocks of Elix, walk to it and `bot.sleep(bedBlock)`. Wake on `bot.on("wake")` or at day.
- Never sleep while a hostile is within 8 blocks, while following, or mid-skill. Stop cancels.
- **BotSession test** with a mineflayer-shaped bed block.

### R18-L — Finish splitting `bot.ts` and `bridge.ts` (no behaviour change)
- Carry on from the five extraction steps in `PROGRESS.md`. Target: no file over 800 lines.
- Only import paths may change in tests. If behaviour would change, stop the item and mark it PARTIAL.

### R18-M — (stretch) Voice, step 1
Only if everything above is DONE or PARTIAL. Implement the offline-testable half of `docs/VOICE_PLAN.md`: packet encoding and decoding, and the Opus frame pipeline, against recorded or constructed packets. Keep it **disabled by default** behind `voice.enabled`, and run no voice code when it is false.

---

## 4. The final report (only once, at the very end)

1. **Fresh-clone** gates on the final commit (from `.fresh/`): typecheck, lint, test counts. Also the working-tree gates.
2. An item table: status by the §1 definition, commit, tests added, minutes.
3. Probe files: round13 / 14 / 15 / 16 / 18 results.
4. The wiring audit output (R18-I): the allow-list entries, with reasons.
5. Deviations, and questions for the owner.
6. **Live-test steps for the owner, only for DONE items:** exact server commands, `pnpm start`, `pnpm exec tsx scripts/e2e-chat.ts --owners ElixTester`, the in-game lines to type, and the expected results.
7. The vision checklist with Code / BotSession test / Live columns. Live is ❌ unless it ran on the real server.
8. Secret scan, run immediately before the final commit. Do not push.