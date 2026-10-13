# Elix — progress

**Full history of every earlier round: `docs/HISTORY.md`. This file is short on purpose: it is
read at the start of every session, so it holds only what the next session needs.**

## Round 20 items

| Item | Status | Commit | Tests |
|---|---|---|---|
|Item | Status | Commit | Tests ||
|R20-A split bot.ts / bridge.ts (4 steps) | NEXT | - | 0 ||
|R20-B sleep like a friend (W1-W4) | NEXT | - | 0 ||
|R20-C move instant-fake tests to realSpeedBot | TODO | - | 0 ||
|R20-D smelting and an iron pickaxe | TODO | - | 0 ||
|R20-E more crafting chains | TODO | - | 0 ||
|R20-F voice step 1 | TODO | - | 0 ||

## The R19-C / R20-A split plan

`bot.ts` was 3,006 lines at the start of Round 20 and `bridge.ts` 1,640. Four extractions, each
re-exported verbatim so no import path in `src/` or `tests/` changes:

### R19-C - NOT DONE, and here is exactly what remains

`bot.ts` is 3,007 lines and `bridge.ts` 1,640. No code changed for this item. The split is
four extractions, in this order, each re-exported verbatim from `bot.ts` so no import path in
`src/` or `tests/` changes:

1. `src/connection/skillDispatch.ts` - `dispatchGather`, `dispatchCraft`, `dispatchGive`,
   `dispatchMemory`, `runGather`, `runCraft`, `runGive`, `runToolCall`, `watchDeaths`,
   `chestViewOf`, `findPlacedTable`, `chestBlockIds`, `pathfinderGoals`, `namedBlock`,
   `foundPosition`, `TOOL_COMMAND` (bot.ts L560-L1350, ~790 lines). They read `this.deps`,
   `this.memory`, `this.say`, `this.ownLine` and the four runtime fields, so they need one
   narrow context object passed in rather than a class.
2. `src/connection/chatDispatch.ts` - `handleChat` and the shortcut tables.
3. `src/connection/tick.ts` - the 50 ms loop and its runners.
4. `src/brain/audit.ts` - the audit store, `gateReply`, `awaitSenderAudits`,
   `speakIfAuditFinds`; and `src/brain/wellbeing.ts` - the wellbeing reply.

Then add the `src/` line-limit test. **Until every file is under 800 that test must NOT be
added**: a limit test that only covers the files already split reads as "done" and is not.

## Questions

- Both API keys still need rotating.
- The three blank manual in-game results from earlier rounds are still unrecorded.
- Which SVC (Simple Voice Chat) version the owner's server runs is unknown; R20-F uses the latest
  release tag unless the owner tells us otherwise.

## Deviations

## Deviations — round 19 (extended) so far

- `tests/unit/gatherWiring.test.ts` REWRITTEN against `RealSpeedBot`. The assertions are the
  Round 18 ones; the fake is the one a game would give us. Reason: the old fake never moved
  Elix and still expected a dig to happen, which is the exact bug R19-A fixes. Listed test by
  test under the item table when R19-B finishes the fake audit.
