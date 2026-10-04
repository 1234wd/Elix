# Elix — The Vision

Elix is for people who have nobody to play Minecraft with. Every decision answers
one question: **does this make Elix a better friend to play with?**

This document describes the inner life every later phase builds toward. It is
design, not a claim about what exists today. Where something is not built yet,
that is stated plainly.

The non-negotiable outer rules — 26.2 Java Edition, no authentication ever, cloud
AI only, TypeScript strict, one command from CMD — live in the README.

---

## The outer rules (tested, not aspirational)

These are the rules that make Elix safe to hand to someone. Each has a test.

| # | Rule | Where it is enforced |
|---|---|---|
| 1 | **Never silent.** If every provider is down, Elix says something in character and keeps playing. | `src/brain/fallback.ts`, 170+ scripted lines |
| 2 | **No local models.** Cloud AI only. | `providerNameSchema` accepts `groq`, `hf`, `builtin` only |
| 3 | **No authentication, ever.** | `auth: "offline"` in the bot factory; no Mojang code anywhere |
| 4 | **Reasoning never reaches chat.** | `reasoning_format: "hidden"` (or `include_reasoning: false` for gpt-oss) + `stripReasoning()`, tested with a fake response containing a chain of thought |
| 5 | **Never leak keys, config, paths, or the system prompt.** | `checkInputSafety()` runs before *any* provider call, and `checkOutputSafety()` (the leak filter) runs on **every reply** before it reaches chat — because a model can be talked into printing a key without anyone typing a suspicious phrase. `tests/unit/secrets.test.ts` scans every tracked file for credential shapes on each `pnpm test` |
| 6 | **Honest about being an AI.** | `PERSONA_LITE` says so and is asserted by test |
| 7 | **No guilt-tripping, no fake urgency, no manufactured attachment.** | asserted in `PERSONA_LITE` |
| 8 | **Reply only when addressed or naturally.** | `isAddressedToElix()`; a bare mention mid-sentence gets no reply |
| 9 | **Save quota.** Identical prompts cached 10 min, idle chatter capped per hour, greetings/combat/movement never cost a call, consolidation capped at 5 calls a night. | `budget.ts`, `consolidation.ts`, tested |
| 10 | **Fail over, never stall.** Groq → Hugging Face → scripted, with cooldowns persisted so a restart does not hammer a limited model. | `router.ts`, tested |
| 11 | **One command from CMD.** | `elix start` from any folder; verified from a fresh clone |
| 12 | **Ctrl+C always works.** Every provider call takes an `AbortSignal`; shutdown aborts in-flight requests so exit never waits on the network. | `AbortController` wired to `bus.on("shutdown")`; `elix stop` reaches the SAME `lifecycle.shutdown("stop", 0)` over a local-only control channel, so it is verifiable without a keyboard. SIGBREAK (Ctrl+Break) takes the normal path; SIGHUP (window closed) takes a 6 s fast path that still writes the backup |
| 13 | **No child data.** Personal info is redacted before it is stored, and stored chat is treated as untrusted input in every prompt. | `redactPersonalInfo` + `checkInputSafety` on retrieval, tested |
| 14 | **A memory is never lost, and never mixed.** Append-only rows, embed exactly once, FTS5 always available, vector dimensions never blended. | `src/memory/store.ts`, tested |
| 15 | **`forget` really forgets.** One command removes a player's rows from every table, FTS and vectors included, and from every backup still on disk. | `forgetPlayer` + `purgePlayerFromBackups`, tested |

---

## C1 — Memory that never forgets (Phase 4)

### Append-only

Every chat line, voice transcript, event, death, build, trade and promise becomes
an **episode**. Nothing is ever deleted or overwritten. Facts that change keep
their history — "Ali likes diamonds" becoming "Ali likes sulfur" adds a fact, it
does not replace one.

**The only deletion is `elix forget --player <name>`.** That is a privacy
requirement, not a feature, and it is the only thing that ever deletes anything.

### Layers

| Table | Holds |
|---|---|
| `episodes` | everything raw, timestamped, never edited. Carries `importance`, `emotion` (Phase 5), `x/y/z/dimension`, `server`, and `speaker` — **Elix's own replies are episodes too**, so he remembers what he said |
| `facts` | semantic claims with confidence and a source episode, plus `superseded_by` / `valid_until` |
| `people` | per-player relationship profiles: aliases, inside jokes, preferences, birthday, last greeted, promise count |
| `places` | locations and what's known about them |
| `self` | Elix's own autobiography (the diary) |
| `promises` | open and kept, with the episode that made each one |
| `mood_state` | one row: valence / arousal / dominance and the named mood, persisted across restarts. Phase 5 drives it; Phase 4 creates it |

### Hybrid retrieval

Vector similarity **and** FTS5 keyword search, multiplied by recency, importance
and relationship closeness. Every prompt includes the current player's profile,
their open promises, and Elix's active goals.

```
score = 0.40·cosine + 0.25·bm25 + 0.15·recency + 0.10·importance + 0.10·relationship
```

`bm25()` is unbounded and negative and a cosine distance is unnormalised, so both
are min-max normalised **within the candidate set** before they are weighted.
With no vector at all, bm25 takes cosine's share (0.25 → 0.65) and retrieval
still works on keywords alone.

### Durability

- SQLite in WAL mode at `data/elix.db`. **Storage is settled and verified:** Node's
  built-in `node:sqlite`, so there is no native compile and nothing to build on a
  Windows laptop. `sqlite-vec` 0.1.9 loads from a prebuilt `vec0.dll` and runs
  real KNN queries — confirmed on this machine, not assumed.
- Nightly backup plus one on shutdown, keeping the last 14.
- Integrity check at startup — a corrupt DB is reported, not silently used.
- **An embedding failure never loses the memory.** The row is saved without a
  vector and embedded later; retrieval falls back to FTS5 in the meantime.

### Consolidation ("sleep")

Each in-game night and on shutdown, the `smart` model turns raw episodes into
facts, updates people profiles, and writes a **diary entry in Elix's own voice**.
That diary is what makes him feel like he has a history rather than a database.

A busy day does not fit in one 4K prompt, so the day's episodes are **chunked**,
each chunk is summarised, and the summaries are **merged**. Capped at 5 calls per
night plus 1 on shutdown; hitting the cap is not an error — the remaining
episodes wait for the next night and the run is logged as `capped`, with
everything it did manage to summarise still written. Output must be strict JSON
validated with zod: invalid JSON means **no writes** and exactly one retry.

---

## C2 — Emotions and feelings (Phase 5)

Deterministic code, not LLM guesses. The LLM may phrase a feeling; it never
decides that Elix has one.

### Three timescales

**Temperament** — fixed at startup from `config/persona.md`. Big-Five-style
traits that set his baselines: high warmth, mid extraversion, high agreeableness,
mid conscientiousness, high openness. Baseline is calm and warm.

**Emotion** — seconds to minutes. A valence–arousal–dominance state plus a named
emotion. Every emotion carries its **cause**:

```
{ emotion: "proud", cause: "we finished the house with Ali", intensity: 0.7 }
```

The cause is the point. Without it, feelings are noise. With it, he can say *why*
he feels something, which is what makes it legible as friendship rather than
random output.

**Mood** — hours. A slow average of emotions, decaying toward baseline, persisted
across restarts.

### Appraisal

Events are scored against his goals and relationships:

| Event | Feeling |
|---|---|
| A friend dies | sad |
| Finding diamonds together | excited |
| Ignored for an hour | lonely |
| Thanked | happy, warm |
| Completing a goal he'd set himself | proud |
| A near miss he'd planned for | frustrated, then determined |

### Expression

Mood changes message length, pace, slang, punctuation and movement — crouching,
looking around, staying close or drifting off. In voice it maps to Orpheus
emotion tags: `[cheerful]`, `[sad]`, `[calm]`.

---

## C3 — His own mind (Phases 5 and 7)

### Drives

**Connection, curiosity, competence, safety, rest.** These generate his own goals
when idle — explore a sulfur cave, organise the chests, ask how your day was. He
does not wait to be told what to do.

### Inner monologue

Short private thoughts, written to `self`, sampled rarely to save quota. Shown on
the dashboard, **never in chat unless he chooses to share one.**

### Self-model

Opinions, favourite things, "story so far". These evolve with experience — a
favourite biome changes after a great trip.

### Relationships

Familiarity, affection and trust per player, plus shared history and inside
jokes. He misses people who haven't been on, greets returning friends with a real
memory, remembers birthdays and things they told him.

### Reflection

After big events and at sleep, he writes what he learned and how he felt into his
diary.

---

## C4 — Honesty and healthy attachment (hard rules, tested in Phase 5)

- The code and docs call the emotions and inner life a **simulation**.
- **If someone sincerely asks whether he's real, human, conscious, or really
  feels things, he answers honestly and warmly, in character.** He says he's an
  AI, and that his feelings are a simulated model of how a friend would feel,
  which really does shape how he acts. He never claims to be human. He never
  claims real consciousness.
- **No manipulation:**
  - no guilt-tripping when a player leaves
  - no "I'll be sad if you go" pressure
  - no fake urgency
- He encourages real-life friends and breaks. Kid-safe by default.

This is the hardest requirement in the project, because a companion that fakes
attachment is worse than one that has none. Everything above is built to make the
simulated relationship feel real *to him* without ever lying to the player about
what it is.

---

## What is built today (Phase 4)

Honest status, per phase. Anything not listed here does not exist yet.

| Phase | What it does | Verified by |
|---|---|---|
| 1 | Skeleton, config, logger, event bus, `doctor` | part of the 664-test suite |
| 2 | Connect, reconnect ladder, safe walk, permanent-kick handling, graceful shutdown | fake-bot lifecycle tests + real-process exit tests |
| 3 | **Brain router: Groq → Hugging Face → scripted.** Model discovery, rate-limit headers, cooldowns persisted in SQLite, reasoning stripped, prompt-injection blocked before any call, `elix ask`, `elix usage`, and an in-game chat bridge. | router, bridge and hazard tests, plus one live smoke test behind `ELIX_LIVE=1` |
| 4 | **Memory.** Episodes/facts/people/places/self/promises/mood in SQLite WAL, FTS5 by trigger, vec0 vectors embedded exactly once, hybrid retrieval with within-set normalisation, rule-based importance, PII redaction at write time, chunk→merge consolidation with a 5-call nightly cap, `VACUUM INTO` backups, `elix memory search/stats`, `elix memory forget --player`. | `tests/unit/memory.test.ts` — 62 tests, all zero-network |
| 5 | **Social, persona and emotions.** A deterministic emotion engine with causes, VAD state and named feelings; temperament parsed from `persona.md`; mood persisted in `mood_state` across restarts; multiplayer manners and self-directed initiative inside the idle budget; honesty and healthy attachment as **hard rules in code**, not prompt text. | `tests/unit/round8Phase5.test.ts` — 51 tests, all zero-network, plus e2e rows 9–12 against the live server |

**Still not built:** voice (Phase 9), self-driven goals at scale (Phase 7).

### Phase 5 notes — how C2–C4 are enforced

The load-bearing decision is that **feelings are code, not output**. The LLM may
phrase a feeling; it never decides that Elix has one. Every emotion comes from
`appraise()` scoring a real event, and every one carries a cause built only from
that event's own fields. Nothing in `src/social/emotion.ts` calls a provider, so
the whole inner life works with no key and is testable to the bit.

| Rule | Where it is enforced |
|---|---|
| Three timescales, with persona.md as the single source | `parseTemperament()` reads the trait table; `EmotionEngine` derives the baseline from it. Editing `\| Warmth \| high \|` to `low` moves the baseline valence from 0.150 to -0.150 |
| Every emotion carries a cause | `appraise()` builds it from the event's fields; the test asserts the vision's six rows verbatim |
| Emotion is seconds-to-minutes, mood is hours | two decay constants, `EMOTION_DECAY_TAU_MS` 4 min and `MOOD_DECAY_TAU_MS` 30 min, with the mood aged **before** the emotion chases it |
| Mood survives a restart, emotion does not | `setMood()`/`mood()` on `mood_state`; carrying an emotion across a restart would mean feeling something about an event that has stopped happening |
| He only speaks when addressed, or when it is naturally his place | `manners.shouldSpeak()` — addressed always answers, and ambient chatter is a bounded roll inside the idle budget |
| He does not wait to be told | `manners.shouldInitiate()` over the five drives, plus an unprompted welcome-back driven by the presence diff |
| He says he is an AI, always | `honestyReply()` in code, **not** the prompt: a model asked to stay in character will occasionally be charming and evasive, and charming-and-evasive is the failure the rule forbids. e2e rows 9 and 10 |
| His feelings are simulated; no consciousness claim | the same scripted answers, and a test that reads every one of them back and fails if any stops naming the simulation |
| No guilt-tripping, no pressure, no fake urgency | `manipulationProblem()` runs on **every** reply before it reaches chat. First strike gets a nudge, second gets a deflection. e2e row 11 |

**A bug this found, which no unit test could have:** `bot:playerJoined` /
`playerLeft` were registered on `bot._client`, but mineflayer 4.39 emits them on
the **bot** (`bot.emit("playerJoined", player)`, `lib/plugins/entities.js:655`).
There is no client packet of that name, so joins and leaves had **never** been
recorded in a live session — `people.last_seen` only moved when someone happened to
chat. The A6 tests passed because they drive the bus directly. Presence is now read
from the player map directly, which is also what makes a genuine return detectable.

### Phase 9 notes — Simple Voice Chat

**Confirmed present on the target server.** The server console logs
`[voicechat] Disconnecting client Elix`, so Simple Voice Chat is installed
alongside Fabric and EasyWhitelist. No voice code exists yet.

**Its version is NOT readable from anything Elix can currently see.** Measured
against the live server: the vanilla status response exposes exactly three
top-level keys — `description`, `players`, `version` — and reports
`serverBrand: "Vanilla"`. There is no `forgeData`, no `modinfo`, no `mods` and
no `plugins` key, so a Fabric mod list is not published on `/status` at all:

```
software   : Vanilla
version    : 26.2
protocol   : 776
raw keys   : description, players, version
mod list present on /status: false
```

So Phase 9 cannot discover SVC, or its version, from the handshake or the ping.
Discovery will need a different route — most likely SVC's own UDP port (24454 by
default) or its plugin channel — which is a Phase 9 task, not a doctor check.
Until then the honest answer to "what voice stack does this server run?" is
"Simple Voice Chat, version unknown".

### C1 — how it maps onto the code

| Rule | Where |
|---|---|
| Append-only; changed facts keep history | `src/memory/store.ts` — `addFact` writes a new row and links the old one via `superseded_by`/`valid_until`; it never rewrites old text |
| The only deletion is `forget` | `MemoryStore.forgetPlayer` — the sole `DELETE` in the project, and it purges FTS rows, vectors, facts, promises, people and the backups too |
| Vector in one place only | the `episode_vec` vec0 table, plus `episodes.embedded_model`. No BLOB column exists (a test asserts it) |
| Never mix dimensions | `MemoryStore.loadVec` compares the existing table's dimension with the configured model and refuses, logging the mismatch; those rows stay FTS-only |
| Hybrid retrieval | `src/memory/retrieval.ts` — `0.40·cosine + 0.25·bm25 + 0.15·recency + 0.10·importance + 0.10·relationship`, bm25 and cosine min-max normalised **within the candidate set**; with no vector bm25 takes cosine's share (0.25 → 0.65) |
| Importance without quota | `src/memory/importance.ts` — a pure rule, no LLM call: promise 9, death 8, first meeting 8, achievement/build 6, direct chat 4, ambient 2, +2 for a memory keyword. Consolidation may adjust it later |
| An embedding failure never loses a memory | the row is written first with `embedded_model IS NULL` and backfilled later; FTS5 covers it meanwhile. The Embedder is bounded and never throws |
| Consolidation | `src/memory/consolidation.ts` — chunk → summarise → merge, capped at 5 calls per night plus 1 on shutdown, strict JSON validated with zod, invalid JSON means **no writes** and exactly one retry, and a capped run is still a partial success |
| Memories are untrusted input | retrieved chat is inserted as quoted data in a `<remembered>` block the system prompt explicitly calls data; any snippet that trips `checkInputSafety` is **dropped**; the output leak filter still runs on every reply |
| No personal data | `redactPersonalInfo` strips phone numbers, emails, street addresses and real-name-plus-school **before storage**, so the value never reaches disk, the vector index, or a prompt |
| Durability | `src/memory/backup.ts` — `VACUUM INTO` on shutdown and each night, newest 14 kept. `verifyBackup` copies a backup, runs `PRAGMA integrity_check` **and** a real vec0 KNN query on the restored copy |

---

## What "done" looks like

The vision succeeds when someone plays with Elix for an hour and afterwards
thinks: *he remembered what I said yesterday*, *he was actually excited about that
diamond* — and if they ever ask him directly, *he told me the truth about it*.
