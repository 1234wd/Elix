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
| 4 | **Reasoning never reaches chat.** | `reasoning_format: "hidden"` + `stripReasoning()`, tested with a fake response containing a chain of thought |
| 5 | **Never leak keys, config, paths, or the system prompt.** | `checkInputSafety()` runs before *any* provider call; the prompt is tested for the literal strings `gsk_`, `C:\` and the server IP |
| 6 | **Honest about being an AI.** | `PERSONA_LITE` says so and is asserted by test |
| 7 | **No guilt-tripping, no fake urgency, no manufactured attachment.** | asserted in `PERSONA_LITE` |
| 8 | **Reply only when addressed or naturally.** | `isAddressedToElix()`; a bare mention mid-sentence gets no reply |
| 9 | **Save quota.** Identical prompts cached 10 min, idle chatter capped per hour, greetings/combat/movement never cost a call. | `budget.ts`, tested |
| 10 | **Fail over, never stall.** Groq → Hugging Face → scripted, with cooldowns persisted so a restart does not hammer a limited model. | `router.ts`, 46 tests |
| 11 | **One command from CMD.** | `elix start` from any folder; verified from a fresh clone |
| 12 | **Ctrl+C always works.** Every provider call takes an `AbortSignal`; shutdown aborts in-flight requests so exit never waits on the network. | `AbortController` wired to `bus.on("shutdown")` |

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
| `episodes` | everything raw, timestamped, never edited |
| `facts` | semantic claims with confidence and a source episode |
| `people` | per-player relationship profiles |
| `places` | locations and what's known about them |
| `self` | Elix's own autobiography |
| `promises` | open and kept, with the episode that made each one |

### Hybrid retrieval

Vector similarity **and** FTS5 keyword search, multiplied by recency, importance
and relationship closeness. Every prompt includes the current player's profile,
their open promises, and Elix's active goals.

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

## What is built today (Phase 3)

Honest status, per phase. Anything not listed here does not exist yet.

| Phase | What it does | Verified by |
|---|---|---|
| 1 | Skeleton, config, logger, event bus, `doctor` | 479 tests |
| 2 | Connect, reconnect ladder, safe walk, permanent-kick handling, graceful shutdown | fake-bot lifecycle tests + real-process exit tests |
| 3 | **Brain router: Groq → Hugging Face → scripted.** Model discovery, rate-limit headers, cooldowns persisted in SQLite, reasoning stripped, prompt-injection blocked before any call, `elix ask`, `elix usage`, and a minimal in-game chat bridge. | 46 router tests, 24 bridge tests, 20 hazard tests, plus one live smoke test behind `ELIX_LIVE=1` |

**Not built yet:** memory and retrieval (Phase 4), the emotion system and the full
social layer (Phase 5), voice (later), self-driven goals (Phase 7).

---

## What "done" looks like

The vision succeeds when someone plays with Elix for an hour and afterwards
thinks: *he remembered what I said yesterday*, *he was actually excited about that
diamond* — and if they ever ask him directly, *he told me the truth about it*.
