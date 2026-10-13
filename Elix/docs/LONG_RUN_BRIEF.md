# ROUND 20 — ONE RUN: DO AS MUCH AS YOU CAN

You are continuing Elix at `8c02e5b`. The owner pastes this message **once** and walks away. There is **no loop script**, and nobody will type "continue". This one run is the whole round. Work through the backlog in §3 in order, as far as you can get, **without stopping**.

Paths are relative to the Elix project folder (the one with `package.json`), except paths that start with `Elix/`, which are relative to the git root.

---

## Reviewer's test report on 8c02e5b (fresh clone)

| Check | Result |
|---|---|
| `pnpm install --frozen-lockfile` (pnpm 12.8.1) | OK |
| `pnpm typecheck` | 0 errors |
| `pnpm lint` | 0 problems |
| `pnpm test` | **2105 passed, 3 failed, 2 skipped** (81 files) |
| Failing tests | Only W1, W3 and W4 in `round20Probes.test.ts`. Expected: these are this round's sleep bugs. |
| Probe files 13 / 14 / 15 / 16 / 18 / 19 | All green |

What the reviewer found:
1. **No source code changed since `9e14c28`.** R20-A1 never landed. `scripts/ra1.cjs` was committed but never run, and `bot.ts` is still 3,143 lines. The script's unused `footer` exports a name that does not exist.
2. **`Elix/run-elix-agent.cmd` was committed.** The owner has decided **not** to use the loop. Remove it from the repo.
3. **`PROGRESS.md` is 471 lines,** and every resume re-reads it. Trim it (Step 0).
4. **`docs/VOICE_PLAN.md` §1 and §6 are wrong about discovery.** Simple Voice Chat has **no master server and no token lookup**. Checked against the SVC source (`henkelmax/simple-voice-chat`, `common/src/main/java/de/maxhenkel/voicechat/`):
   - **The secret comes over Minecraft custom-payload (plugin) channels:**
     - client → server: `voicechat:request_secret`, an `int compatibilityVersion`;
     - server → client: `voicechat:secret`, containing the secret (16 bytes), `int serverPort`, the player UUID, a `byte` codec, `int mtuSize`, `double voiceChatDistance`, `int keepAlive`, a `boolean` groupsEnabled, a `String` voiceHost and a `boolean` allowRecording.

     Files: `net/RequestSecretPacket.java`, `net/SecretPacket.java`.
   - **UDP encryption is `AES/GCM/NoPadding`:** a 16-byte key, a random 12-byte IV prepended to the ciphertext, and a 128-bit tag (`voice/common/Secret.java`).
   - **UDP framing, client → server:** the magic byte `0xFF`, then the player UUID, then a length-prefixed encrypted payload (`voice/common/NetworkMessage.java`).
   - **Packet ids:**

     | Id | Packet |
     |---|---|
     | `0x1` | Mic |
     | `0x2` | PlayerSound |
     | `0x3` | GroupSound |
     | `0x4` | LocationSound |
     | `0x5` | Authenticate |
     | `0x6` | AuthenticateAck |
     | `0x7` | Ping |
     | `0x8` | KeepAlive |
     | `0x9` | ConnectionCheck |
     | `0xA` | ConnectionCheckAck |

5. **These `src/` files are over 800 lines:**

   | File | Lines |
   |---|---|
   | `connection/bot.ts` | 3,143 |
   | `brain/bridge.ts` | 1,640 |
   | `memory/store.ts` | 1,087 |
   | `brain/router.ts` | 1,044 |
   | `social/wellbeing.ts` | 980 |
   | `social/emotion.ts` | 812 |

---

## 0. The one-run rules (read this section twice)

### When your turn may end

Your turn ends at **exactly one point**: every item in §3, including the stretch items, is DONE, PARTIAL or BLOCKED, and the final report is committed. **Nothing else ends it:**
- **Finished an item or made a commit?** Start the next item in the same turn.
- **Want to give a progress summary?** Progress goes into `PROGRESS.md` as one line, never into the chat. **Writing a summary to the chat ends the run, and the owner loses the rest of the round.**
- **Have a question?** Write it under "Questions" in `PROGRESS.md`, take the safest default, and continue. Permissions are pre-approved and questions are disabled, so never wait.
- **Item blocked?** Reset to the last commit, mark the item BLOCKED with the reason, and start the next item.
- **A tool fails, a test is flaky, or an install is slow?** Retry once. Then work around it, or mark the item BLOCKED and move on.

There is deliberately more work here than one run can finish. Running out of work is not the risk. **Stopping early is.**

**If your context was compacted, or you lose track:**
1. Re-read `docs/LONG_RUN_BRIEF.md`.
2. Re-read the `RESUME HERE` line of `PROGRESS.md`.
3. Continue from there. Never redo a finished item.

### Step 0 (about 10 minutes, one commit)

1. Overwrite `docs/LONG_RUN_BRIEF.md` with this whole message, unchanged.
2. Remove `run-elix-agent.cmd` from the repo with `git rm`. It sits next to `package.json`. This is the owner's decision.
3. `scripts/ra1.cjs`: either fix it and use it as the R20-A1 tool, or delete it. It must be gone from the repo by the end of R20-A1.
4. Trim `PROGRESS.md`. Move everything above "## Round 20 items" **verbatim** into `docs/HISTORY.md`, with no rewriting, **except** the "### R19-C" split plan, which stays. Keep `PROGRESS.md` under 60 lines:
   - the `RESUME HERE` line;
   - the Round 20 item table;
   - the R19-C split plan;
   - "Questions";
   - "Deviations".
5. Commit as `docs: round 20 one-run brief`.

### Working fast

- **Read narrowly.** Never read a whole file over 400 lines. Use `grep -n`, then read only the range you need.
- **Test narrowly while working.** Run `pnpm exec vitest run <the files you touched>` plus `pnpm typecheck`. When one test fails, re-run only that file. **Never run the full suite to debug.**
- **Full gate only before a commit:** `pnpm typecheck`, `pnpm lint`, `pnpm test`.
- **Fresh-clone gate (`.fresh/elix`):** after R20-A, and once before the final report. Nowhere else.
- **Commit after every item and every split step,** so a run that is cut off loses nothing. Never commit red.
- **Make big, complete edits.** One edit that writes the whole test, and one that writes the whole change, beat ten one-line edits.
- **Time box:** 60 minutes per item (90 for R20-A and R20-F). Past that, reset to the last commit, mark the item BLOCKED with the reason, and start the next one.
- **Keep the `RESUME HERE` line exact,** for example "R20-D step 3: furnace smelt test written, implementation next". Update it at every commit.

---

## 1. Definition of DONE (unchanged)

- A real-speed `BotSession` test, using `tests/helpers/realSpeedBot.ts`, drives the feature from its real trigger (a chat line, an event, a tick) to a real mineflayer call.
- Every export has a production caller, so the wiring audit stays green.
- The full gate is green on the commit.

Add to `realSpeedBot.ts` whatever new mineflayer behaviour an item needs (sleep and wake, `entitySleep` / `entityWake`, the furnace window, custom channels). Add a line for each to `docs/MINEFLAYER_CONTRACTS.md`, naming its test.

---

## 2. Hard rules (these apply to every item)

- **Read-only files:** `tests/unit/round13Probes.test.ts`, `round14Probes.test.ts`, `round15Probes.test.ts`, `round16Probes.test.ts`, `round18Probes.test.ts`, `round19Probes.test.ts` and `round20Probes.test.ts`. Never edit their assertions, delays or timeouts. After R20-B, all of them are green on every commit.
- **Never weaken an existing test to make it pass.** You may change a test you wrote yourself **only** when it encodes a bug this backlog fixes. List each such change under "Deviations" with a one-line reason.
- **Mineflayer-shaped data.** Use real `Vec3` positions. A player's position is on `player.entity`. Mobs are `Entity`-shaped. No `as` casts on mineflayer objects; use runtime guards.
- **Real-library contract rule.** Anything handed to a third-party library must be checked against the **real** library in at least one test. A fake must never accept something the real library would reject.
- **Every line Elix sends goes through the existing gates:**
  - replies to a player use the sender gate;
  - **Elix's own words** use `gateOwnLine(player)`, never `gateScriptedReply`;
  - a line the wellbeing floor matches never triggers an action;
  - a dropped reply drops its actions.
- **`stop` wins over everything, within one tick (50 ms).** Every new action, skill and reflex must be cancellable, and must leave nothing half-running.
- **Good-friend rules, enforced in code:**
  - never attack a player, a pet, a villager, an iron golem or a passive mob;
  - never take items out of a chest;
  - never place lava, fire or TNT;
  - never dig a block that is not on the allow-list;
  - never dig within `protectedRadius` of a remembered place;
  - only owners can command;
  - commands must be addressed to Elix.
- **The pathfinder keeps `canDig = false` and no scaffolding.** Elix reaches only blocks he can walk to. He never tunnels or digs straight down.
- **No new runtime dependency** unless it is written down in `DECISIONS.md` with a reason. It must install on Windows **without** build tools, so use prebuilt binaries or a JS/WASM build.
- **Never write protocol or game facts from memory.** Read them from the vendored `minecraft-data`, the installed library source, or the cloned upstream source, and cite the file in the contract file.
- **Never** push, touch `.env`, print, log or commit a key, or commit the server IP anywhere new.
- **Honesty in `PROGRESS.md`.** Anything that was not run is marked ❌. A fake is not "live".

---

## 3. The backlog (in this order; do not stop at the end of the core list)

### Core

**R20-A — Split `bot.ts` and `bridge.ts` (no behaviour change).**
- Follow the R19-C plan, extracting in this order. Each step gets its own commit and a full green gate:
  1. **A1** `skillDispatch.ts`
  2. **A2** `chatDispatch.ts`
  3. **A3** `tick.ts`
  4. **A4** `brain/audit.ts` plus the wellbeing reply
- Use a new name for the wellbeing reply file, such as `brain/wellbeingReply.ts`. `src/social/wellbeing.ts` already exists.
- If `bot.ts` or `bridge.ts` is still over 800 lines after A4, keep extracting cohesive blocks (A5, A6 and so on) until both are at most 800.
- Test edits are allowed only in import paths.
- Add `tests/unit/fileSize.test.ts` now, as a **ratchet**:
  - every `src/` file must be at most 800 lines, except the files in a `CEILINGS` map;
  - each `CEILINGS` entry holds that file's exact current line count, and the test fails if it grows;
  - each split lowers or removes its entry.
- Run the fresh-clone gate when R20-A is done.

**R20-B — Sleep like a friend (probes W1, W3, W4).**
- Keep a set of players who are really asleep, from `entitySleep` / `entityWake`. Clear it on death, respawn and disconnect.
- "Owner in bed" means **an owner in that set**. Drop the "owner near any bed" approximation.
- Call `bot.wake()`, and await it, **before** anything that needs Elix to move:
  - a hostile within 8 blocks;
  - any command;
  - a tool call;
  - `elix stop`;
  - the owner's `entityWake`;
  - daylight.
- Never call `setGoal` while `bot.isSleeping` is true. Put the guard in the one goal-setting path, not in each caller.
- If `bot.sleep` throws (monsters nearby, not night, bed occupied), wait 30 s before trying again.
- Write real-speed tests for each case. `round20Probes` must pass 5 of 5.

**R20-C — Move the last instant-fake tests onto `realSpeedBot`.**
- Move place memory ("take me to", "where is", "where did I die") and the model tool-call tests onto `realSpeedBot`. Fix whatever breaks.
- Tool calls go through the same runtime base as typed commands, including the in-flight guard.

**R20-D — Iron pickaxe, end to end.**
- **Trigger:** "elix make an iron pickaxe". Plan the whole chain, and run each step on the runtime base:
  1. a stone pickaxe if he has none;
  2. reachable `iron_ore` / `deepslate_iron_ore` within 32 blocks (walkable, so caves and the surface);
  3. find, or craft and place, a furnace;
  4. `bot.openFurnace(block)`, then `putFuel`, then `putInput`, wait for the output with a timeout, then `takeOutput`, then close the window;
  5. sticks;
  6. the pickaxe at a table.
- **No reachable iron:** one honest line that offers to go caving together. Never tunnel.
- **Missing materials:** one honest line naming exactly what is missing.
- Add `furnace` and `iron_pickaxe` to `CRAFTABLE`, checked against the vendored recipes.
- Write a contract line for each furnace call, and real-speed tests for every step, `stop` mid-smelt included.

**R20-E — More crafting chains, reusing the R20-D planner.**
- Commands:
  - "elix make torches"
  - "elix make stone tools" (pickaxe, axe and sword; gather cobblestone first if needed)
  - "elix make a chest"
  - "elix make a furnace"
- Each one gathers what is missing and is allowed, crafts the rest, or sends one honest line about what it cannot get.
- Each command has a real-speed test.

**R20-F — Voice, step 1 (offline, behind `voice.enabled`, default false).**
1. **Get the source.** Clone `https://github.com/henkelmax/simple-voice-chat` into `.fresh/svc` (inside the workspace; `.fresh/` is gitignored). Find the version that matches the server's SVC plugin; if you cannot tell, use the latest release tag and say so. **If you cannot clone it, mark F BLOCKED. Never write protocol code from memory.**
2. **Fix `docs/VOICE_PLAN.md`.** Correct §1 and §6 from the source, using the facts in the test report above. Cite each fact by file and line in `docs/VOICE_CONTRACTS.md`.
3. **Build and test, under `src/voice/`:**
   - an encoder and decoder for the `voicechat:secret` and `voicechat:request_secret` payloads;
   - AES-GCM encrypt and decrypt matching `Secret.java` exactly: IV first, a 128-bit tag, round trips, and wrong-key rejection;
   - UDP framing for client → server and server → client;
   - encoding and decoding for the Authenticate, AuthenticateAck, Ping, KeepAlive and Mic packets;
   - Opus framing at 48 kHz and 20 ms (960 samples per frame), tested with constructed audio.
4. **A test proves that no voice module is loaded or run while `voice.enabled` is false.**

### Stretch (keep going, in this order)

**R20-G — The brain knows exactly what Elix can do.**
- Generate one capability table from the command parser's own table, and feed both the tool-call zod list and the system prompt's "what I can do" text from it.
- A test asserts:
  - every command is in the tool list and in the text;
  - nothing in the text lacks a command, so Elix never promises a skill he does not have.
- Add e2e rows for every new command, marked ❌ not run.

**R20-H — Doing things on his own, step 1 (opt-in: `initiative.autonomousTasks`, default false; `elix setup` asks one yes/no question).**
- **Only when all of these hold:**
  - an owner is online within 24 blocks;
  - Elix has been idle for at least 3 minutes (no follow, skill or sleep);
  - it is daytime;
  - his health is at least 14;
  - there is no hostile within 16 blocks.
- **He picks one task:**
  - gather up to 8 logs within 24 blocks of the owner (allow-list, leaves rule, protected radius);
  - make torches if he has the materials and holds fewer than 16 torches;
  - deposit spare cobblestone and dirt into a remembered chest (deposit only).
- **Limits:**
  - he says one line in his own words (`gateOwnLine`) before he starts;
  - at most one task per 10 minutes;
  - he never goes more than 32 blocks from the owner.
- **Abort within one tick on any of these:**
  - a line addressed to him;
  - any command;
  - `stop`;
  - a hostile;
  - the owner moving away.
- Write a real-speed test for every rule above.

**R20-I — Voice, step 2 (offline).**
- **Plugin channels.** Register both channels through mineflayer's real plugin-channel API (`bot._client.registerChannel` / `writeChannel`, checked against the installed `minecraft-protocol` source). Send `request_secret` after spawn, and parse `secret`.
- **UDP loopback.** Run a `dgram` round trip on `127.0.0.1` against a small fake SVC server written in the test: Authenticate, then AuthenticateAck, then KeepAlive, then Ping.
- Keep everything behind `voice.enabled`.

**R20-J — Split the remaining files over 800 lines,** with no behaviour change: `memory/store.ts`, `brain/router.ts`, `social/wellbeing.ts` and `social/emotion.ts`. Remove their `CEILINGS` entries. This item is done when `CEILINGS` is empty.

**When J is done,** go back to any PARTIAL item. Only when nothing is left, write the final report.

---

## 4. The final report (`docs/ROUND20_REPORT.md`, committed, then the run ends)

1. Fresh-clone and working-tree gates on the final commit.
2. An item table: status, commits, tests added and minutes for each item, and **where the run stopped and why**.
3. Probe-file results: rounds 13, 14, 15, 16, 18, 19 and 20.
4. The `src/` line counts: the largest five files, and what is left in `CEILINGS`.
5. Deviations, and questions for the owner.
6. **Live-test steps for the owner, for DONE items only,** each with its exact chat line and the expected result.
7. The vision checklist, with Code / Real-speed test / Live columns.
8. A secret scan, run immediately before the final commit. **Do not push.**
