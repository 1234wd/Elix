# ROUND 17 — LONG RUN, continued (plan for 5+ hours of continuous work)

You are continuing the Elix project at commit e380f01. WP1 is DONE (7f18574) and the reviewer re-ran everything on a fresh clone: typecheck 0, lint 0, 1554 passed / 2 skipped, all four probe files green. Good work on WP1, and especially on the three bugs you found behind U1.

**The last session stopped after 33 minutes to ask questions. That must not happen again.** Your four questions are answered in §1 below, and from now on a question is never a reason to stop.

---

## 0. How to work for a long time without stopping

**Step 0, before anything else:** save this whole message, unchanged, as `docs/LONG_RUN_BRIEF.md` inside the Elix project folder (next to `docs/VISION.md`), and commit it as `docs: long-run brief`. From now on, `docs/LONG_RUN_BRIEF.md` plus `PROGRESS.md` are everything a fresh session needs. **If your context is reset, compacted or restarted, read those two files first and continue from the first unfinished WP.**

1. **Permissions are pre-approved.** The owner configured OpenCode to allow edits and shell commands without approval. There is nothing to wait for. Asking questions is disabled for this run: do not try to ask the owner anything.
2. **A question is never a stop condition.** Write it under "Questions for the owner" in `PROGRESS.md`, pick the safest reasonable default, record it under "Deviations", and keep working.
3. **Partial progress beats a blocked WP.** If one part of a WP is blocked, finish every other part, commit, mark the WP **PARTIAL** with the reason, and move on.
4. **Low context is not a stop condition either.** Update `PROGRESS.md` (exact next step, open files, failing test if any), then carry on. If the tool restarts the session, Step 0 still applies.
5. **One WP at a time, no reports in between.** For each WP:
   1. Read only the code you need.
   2. Write the acceptance tests first and watch them fail.
   3. Implement.
   4. Run `pnpm typecheck`, `pnpm lint` and `pnpm test`, then `tests/unit/secrets.test.ts`.
   5. Commit as `WPn: <title>`.
   6. Update `PROGRESS.md`.
   7. **Go straight to the next WP.**
6. **Time box: 90 minutes per WP.** If gates are not green after 90 minutes, `git reset --hard` to the last WP commit (local only), mark the WP BLOCKED with the failing test name and one paragraph on why, and move on. Never commit red.
7. **Stop only when:**
   - every WP is DONE, PARTIAL or BLOCKED;
   - a gate cannot be made green even after reverting; or
   - a step would need a secret, a push, or deleting data outside the repo.

---

## 1. The owner's answers to your four questions

**Q1. Armour points and attack damage: neither of your two options as written.** Your `MATERIAL_TIER` default is **wrong**, so do not use it. It ranks gold above iron and chainmail. In the game, gold armour is weaker than both chainmail and iron, and a golden sword or axe hits less hard than an iron one.

Do this instead:
- Build two explicit tables, `ARMOR_POINTS` (per armour item) and `MELEE_DAMAGE` (per weapon or tool item).
- Take the values from the Minecraft Wiki pages (Armor, Sword, Axe, Spear, Mace, Trident) using your web tool. Put the URL and the access date in a comment above each table.
- They must cover **every** armour and melee item in the vendored 26.2 `items.json`. That is 29 armour pieces, including the copper set and the turtle helmet, plus swords, axes, spears, the mace and the trident.
- Add a **completeness test** that iterates the vendored 26.2 items and fails if one is missing, so a future item fails loudly.
- If you cannot verify a value from the wiki (new copper or spear items, for example), **leave that item out of auto-equip**, list it in `PROGRESS.md`, and never guess a number.
- Food ranking uses the vendored `foods.json` `effectiveQuality`, as you found.

**Q2. Yes.** Everything version-sensitive reads the vendored 26.2 data, through **one** accessor module (or `bot.registry` for the connected version at runtime). Add a test that fails if any `src/` module loads a hard-coded older `minecraft-data` version, or joins `foods` to `items` through the installed 1.21.x package.

**Q3. Global `owners`: agreed.**

**Q4. e2e command rows opt-in via `--owners`: agreed.**

---

## 2. Hard rules (these apply to every WP)

- **Read-only files:** `tests/unit/round13Probes.test.ts`, `round14Probes.test.ts`, `round15Probes.test.ts` and `round16Probes.test.ts`. Never edit their assertions, delays or timeouts. They must all stay green after every WP.
- **Never weaken an existing test to make it pass.** You may change a test you wrote yourself **only** when it encodes a bug this backlog is fixing. Each such change must be listed under "Deviations" with a one-line reason. (WP1 used this for three of your own tests, which is fine.)
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
- **New code goes in new modules:** `src/reflexes/`, `src/skills/`, `src/world/`, `src/brain/providers/`. `bot.ts` (1,932+ lines) and `bridge.ts` (1,505+ lines) only get wiring lines until WP11.
- **No new runtime dependencies** unless written down in `DECISIONS.md` with a reason. Prefer small in-house code over adding `mineflayer-pvp` and similar packages. `mineflayer-pathfinder`, `vec3` and the vendored `minecraft-data` are already available.
- **Never** push, touch `.env`, print, log or commit a key, or commit the server IP anywhere new.
- **Honesty in `PROGRESS.md`.** If something was not run, it says ❌. A test that only exercises a fake does not count as "live".

---

## 3. The backlog (continue in this order; WP1 is done)

### WP1 — Part C against the real pathfinder: **DONE** (7f18574)

Keep `round16Probes` and `pathfinderContract` green after every WP.

### WP2 — Survival reflexes (no LLM, runs on the tick): resume here

New `src/reflexes/`. Each reflex is a pure decision function plus thin wiring. They run in this priority order, and a higher one interrupts a lower one and any follow or skill. Follow resumes after, if it was active.

1. **Breathe:** oxygen low in water → swim up.
2. **Creeper:** a creeper within 4 blocks → back away to 7 or more blocks. Never melee a creeper.
3. **Hazards:** keep the existing lava and fall checks.
4. **Eat:** food ≤ 14 and no hostile within 6 blocks → eat the best food in the inventory, ranked by vendored `foods.json` `effectiveQuality`. Never eat rotten flesh, spider eye, poisonous potato, pufferfish, raw chicken or suspicious stew unless food ≤ 4 and nothing else exists.
5. **Armor:** equip the best armour and weapon after picking items up, using the `ARMOR_POINTS` and `MELEE_DAMAGE` tables from §1 Q1. Never unequip something better. Unverified items are never auto-equipped.

**Acceptance:**
- one named test per reflex, using a mineflayer-shaped bot (`food`, `oxygenLevel`, `inventory.items()` returning real item names from vendored 26.2);
- a priority test (a creeper interrupts eating);
- a stop test (`elix stop` cancels an in-progress eat or flee within one tick);
- the table completeness test;
- a test that golden armour never replaces iron or chainmail;
- real-library contract tests for `bot.equip` and `bot.consume` argument shapes.

### WP3 — Protect the owner (combat, humanized)

New `src/reflexes/defend.ts`. When an owner is within 16 blocks, attack **hostile** mobs (from `minecraft-data` entity categories, not a hand-written name list) that are within 8 blocks of the owner or of Elix.

- Never creepers (WP2 handles them), players, pets, villagers, golems or passive mobs.
- Humanized: reaction delay 180–320 ms, `skillCap` changes it (casual slower, tryhard faster), respect the 1.9+ attack cooldown, face the target smoothly (WP4's look helper, or a simple eased look if WP4 is not done yet).
- Retreat toward the owner at health ≤ 6. Stop when the target dies or leaves range. `elix stop` cancels it.
- If a **player** hits Elix, he does not fight back. He steps away and may say one short line through `gateOwnLine`.

**Acceptance:** tests for target selection (hostile yes; villager, wolf and player no), reaction-delay bounds per `skillCap`, cooldown respected, retreat at low health, stop cancels, and never hitting a player even after being hit by one.

### WP4 — Human-like gaze and body language

New `src/humanizer/look.ts`:

- **Eased head rotation:** move towards a target yaw and pitch over 150–400 ms, with no single-tick turn larger than 40°.
- **Look at the speaker** when someone addresses Elix and is within 16 blocks.
- **Crouch-greet:** toggle sneak 2–3 times when an owner joins or says hi.
- **Idle glances** at a nearby player or mob every 8–20 s, only while idle.
- All of it is paused during combat, follow, and while a wellbeing reply is being sent. No crouch-greets during gentle mode.

**Acceptance:** tests on the yaw sequence (never above 40° per tick, finishes within 400 ms), speaker look, crouch-greet count, and suppression rules.

### WP5 — Skills: gather, craft, give (owner commands, deterministic)

New `src/skills/`, three sub-packages. Commit each one separately as WP5a, WP5b and WP5c.

- **WP5a, gather:** "elix get wood" / "elix get me 10 cobblestone" / "elix get 5 dirt". Only from a **natural-block allow-list**:
  - logs, but only when leaves are within 2 blocks (a tree, not a house);
  - stone, cobblestone, deepslate, dirt, grass_block, sand, gravel;
  - coal, iron and copper ores, including the deepslate variants.

  Use the best tool (`minecraft-data` `harvestTools`). Never dig within `protectedRadius` of a remembered place (WP6; until WP6 exists, of the owner's position). Cap at 64 items or 5 minutes. Progress lines are rare (at most one every 60 s) and go through `gateOwnLine`.
- **WP5b, craft:** planks, sticks, crafting table, and wooden and stone pickaxe, axe and sword, via `bot.recipesFor` / `bot.craft` with the real recipe data. Place a crafting table only on a valid solid block next to Elix, and pick it back up after.
- **WP5c, give / deposit:** "elix give me <item>" → walk to the owner and toss it, only to the owner who asked. "elix put your stuff in the chest" → deposit into the nearest chest within 16 blocks. Never withdraw.

All three: owner-only, addressed, whole-intent (the WP1 parser rules), cancellable by stop, and never run on a wellbeing-floor line.

**Acceptance:** per sub-package, tests with real `minecraft-data` 26.2 recipes, block and tool data; the allow-list refuses planks, glass, wool and any block near a protected place; contract tests for `bot.dig`, `bot.craft` and `bot.toss` argument shapes; stop cancels mid-dig.

### WP6 — World memory: places and deaths

New `src/world/`, stored in the existing SQLite store through a migration that is tested on a copy of an old schema.

- "elix remember this place as home|base|farm|<word>" stores the coordinates, dimension and timestamp.
- "elix take me home" / "elix go to farm" → GoalNear to that place.
- Record Elix's and each player's **death position** when the server reports a death. "elix where did i die" answers from memory.
- Coordinates are told **only to owners, by whisper** (`/msg`), never in public chat.
- `elix memory places` in the CLI lists them.
- WP5's `protectedRadius` now uses these places.

**Acceptance:** migration test, command tests, whisper-only test (a public reply never contains three integers in coordinate form), and a gather test that refuses inside a protected radius.

### WP7 — The missing brain tiers: NVIDIA and local Ollama

The vision's order is **Groq → NVIDIA → Hugging Face → local**, but only Groq and HF exist.

- Add an NVIDIA provider (`https://integrate.api.nvidia.com/v1`, OpenAI-compatible, `NVIDIA_API_KEY`). Treat 402 as "credits exhausted": breaker open 24 h.
- Add an Ollama provider (`http://127.0.0.1:11434/v1`, no key). It is enabled only if reachable at startup; otherwise it is silently absent.
- Put both in `models.yaml` per role. Choose models from `GET /v1/models` at startup, never hard-coded IDs.
- `elix doctor` reports both.
- `.env.example` gains `NVIDIA_API_KEY=`, with the same "never commit" comment.

**Acceptance:** fake-fetch tests for the full fall-through order (Groq 429 → NVIDIA → NVIDIA 402 → HF → HF out of credit → Ollama → Ollama down → builtin); the 402 breaker duration; Ollama absent when unreachable; the guard role never falls through to a model that cannot return the JSON verdict.

### WP8 — Let the brain ask for actions (constrained tool calls)

The LLM can request actions, but only from a fixed, zod-validated list: `follow`, `come`, `stop`, `gather`, `craft`, `give`, `goTo(place)`, `rememberPlace`. The request is a JSON block that is parsed and validated, never executed as code.

- Owner-only.
- A dropped reply (any gate) drops its tool calls.
- Gentle mode allows only `stop` and `follow`.
- At most 1 tool call per reply and 6 per minute.
- Every tool call is logged, without message text.
- Unknown tools or bad arguments are ignored, with one log line.

**Acceptance:** tests for each rule above, plus: "elix can you grab some wood for us" from an owner leads to gather(wood) through the same code path as the WP5 command; the same line from a non-owner leads to nothing.

### WP9 — Status and first-run safety

- `elix status` (CLI) and an owner-only whispered `elix status` in game. They show: provider health and breaker state, today's call counts per provider, the current action, mood label, number of pending audits, and **no chat text and no keys**.
- README "First run" checklist:
  - add your name to `owners`;
  - firewall the server to your IP;
  - rotate keys if they were ever shared;
  - run `pnpm e2e`.
- `elix doctor` warns when `owners` is empty, and when `online-mode=false` is detected while the configured host is not localhost or a LAN address.

**Acceptance:** tests on status redaction (no key-shaped string, no player message text) and on the doctor warnings.

### WP10 — e2e rows for the owner to run

Extend `scripts/e2e-chat.ts` (ElixTester stands still and only chats):

- come/stop: Elix ends within 3 blocks of the tester within 20 s, then stops;
- "elix give me <item>" when Elix has one;
- "elix remember this place as testspot", then "elix where is testspot" (whispered);
- a non-owner command gets the refusal once.

Owners for the run come from `--owners ElixTester` only. Do **not** run it if you cannot reach the server. Write the exact commands into the final report.

### WP11 — Make `bot.ts` and `bridge.ts` maintainable (no behaviour change)

Purely mechanical. Move code out of `bot.ts` into `src/connection/` modules: chat dispatch, initiative wiring, presence, crash guards, command routing. Move code out of `bridge.ts` into `src/brain/` modules: audit store and gate, chat reply, wellbeing reply. Target: no file over 800 lines.

- Test changes are allowed **only** in import paths.
- The full suite and every probe file must stay green.
- If any behaviour change is needed, stop the WP and mark it PARTIAL.

### WP12 — (stretch, only if time remains) Voice plan

Write `docs/VOICE_PLAN.md`: how Elix would join Simple Voice Chat (the 26.2 build), with the handshake, the UDP port, Opus 48 kHz 20 ms frames, encryption, the STT/TTS choices (Groq Whisper with a local fallback; local Kokoro/Piper), the risks, and a test plan. Include a minimal, **disabled-by-default** spike behind `voice.enabled`, if and only if it can be tested without a live server. No partial voice code may run when `voice.enabled` is false.

---

## 4. The final report (only once, at the very end)

1. Fresh-clone gates on your final commit: typecheck, lint, test counts.
2. A WP table: status, commit hash, tests added (file and count), minutes spent.
3. Probe files: round13 / 14 / 15 / 16 results.
4. Deviations (every changed test of your own, with a reason).
5. Questions for the owner.
6. **What the owner must test live, as exact steps:** server commands, `pnpm start`, `pnpm e2e --owners ElixTester`, and the in-game lines to type, with expected results.
7. The vision checklist with Code / Test / Live columns. "Live" is ❌ unless it ran against the real server.
8. Secret scan result, run immediately before the final commit. Do not push.