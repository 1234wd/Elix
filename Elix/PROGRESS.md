# Round 16 — long run progress

Backlog WP1–WP12. One commit per WP: `WPn: <title>`. Never leave the tree red.

Read-only: `tests/unit/round13Probes.test.ts`, `round14Probes.test.ts`,
`round15Probes.test.ts`, `round16Probes.test.ts`. They must stay green after every WP.

| WP | Status | Commit | Tests added | Notes |
| --- | --- | --- | --- | --- |
| WP1 Part C against the real pathfinder | TODO | | | U1 real goals, U2 addressed-only, U3 whole-intent, U4 come→speaker, U5 gateOwnLine |
| WP2 Survival reflexes | IN PROGRESS | | | breathe, creeper, hazards, eat, armor |
| WP3 Protect the owner | TODO | | | hostile-only combat, humanized |
| WP4 Human-like gaze | TODO | | | eased look, crouch-greet, idle glances |
| WP5a gather | TODO | | | natural-block allow-list |
| WP5b craft | TODO | | | real recipes |
| WP5c give / deposit | TODO | | | toss to owner, deposit, never withdraw |
| WP6 World memory | TODO | | | places, deaths, whisper-only coords |
| WP7 NVIDIA + Ollama tiers | TODO | | | 402 breaker, models from /v1/models |
| WP8 Constrained tool calls | TODO | | | zod-validated JSON block |
| WP9 Status + first-run safety | TODO | | | redaction, doctor warnings, README |
| WP10 e2e rows | TODO | | | rows for the owner to run |
| WP11 Split bot.ts / bridge.ts | TODO | | | mechanical, no behaviour change |
| WP12 Voice plan | TODO | | | docs only, disabled by default |

## Deviations

Changes to tests I wrote myself, with the reason.

- `tests/unit/actions.test.ts` — "the acknowledgement goes through the same sender gate as
  any reply" asserted the Round 15 BUG: the ack went through `gateScriptedReply`, which
  classifies its argument as the sender's words. WP1/U5 changed it to expect
  `gateOwnLine` and to assert that nothing Elix said was ever classified as the owner's.
- `tests/unit/actions.test.ts` — the controller tests asserted a goal shaped like our intent
  object (`{ kind: "follow", distance }`). WP1/U1 replaced them with the library's own
  GoalFollow and `rangeSq`.
- `tests/unit/actions.test.ts` — entity stubs were `{ id: 1 }`, which the real
  `GoalFollow` constructor throws on (it reads `entity.position`). Replaced with
  mineflayer-shaped entities.

## Questions for the owner

- Does `owners` need to be per-profile rather than global? Chose global: one server, one
  owner set, and a per-profile list would let a test profile grant itself.
- Should the e2e command rows (WP10) be part of the default run or opt-in? Chose opt-in
  via `--owners`, since the default run must never grant command rights.

## Gates at last commit

_(updated at the end of each WP)_