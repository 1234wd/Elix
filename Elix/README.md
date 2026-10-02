# Elix

An autonomous Minecraft Java Edition companion that joins offline-mode servers
as a normal player, plays with real skill, remembers everything, and behaves
like a warm, funny, loyal friend.

The full design — memory, emotions, his own mind, and the honesty rules — is in
**[docs/VISION.md](docs/VISION.md)**. This file is how to run and build it.

## Status — Phase 2 (Connection) complete

- [x] **Phase 1 — Skeleton:** repo, zod-validated config, CLI, logging, `elix doctor`
- [x] **Phase 2 — Connection:** mineflayer → 26.2 server, reconnect, safe behaviour
- [ ] Phase 3 — Brain router (Groq → Hugging Face, failover, usage table)
- [ ] Phase 4 — Memory (SQLite + vec + FTS5, consolidation, diary)
- [ ] Phase 5 — Social + persona + emotion engine + honesty rules
- [ ] Phase 6 — Reflex + core skills
- [ ] Phase 7 — Planner (goals → task trees)
- [ ] Phase 8 — Knowledge (minecraft-data overrides, wiki RAG)
- [ ] Phase 9 — Voice (Simple Voice Chat, STT, TTS, barge-in)
- [ ] Phase 10 — Polish (safety, dashboard, 6-hour soak)

## Install

Requires Node 22 or newer. Nothing else — no Java, no Docker, no ViaProxy.

```bash
pnpm install
pnpm build          # produces dist/cli/index.js
```

### Run it from CMD, from any folder

Copy the launcher once into a directory already on your `PATH`:

```bat
copy elix.cmd C:\Tools\elix.bat
```

Then, anywhere:

```bat
elix start
elix doctor
elix status
```

On Linux/macOS: `ln -s "$PWD/elix.sh" /usr/local/bin/elix`.

`elix start` works before `pnpm build` too — the launcher falls back to running
the TypeScript sources with tsx.

## Provider keys (optional in phase 2)

Two cloud providers. Copy `.env.example` to `.env` and fill in whichever you have.

| Provider | Env var | Used for |
|---|---|---|
| Groq | `GROQ_API_KEY` | chat, planning, STT, TTS, guard |
| Hugging Face | `HF_TOKEN` | chat fallback, memory embeddings |
| `builtin` | — | Elix's own scripted fallback code (no key) |

`.env` is read from the project root regardless of your current folder. With no
keys at all Elix still connects and plays — the brain just falls back to
scripted in-character lines.

**Hugging Face embeddings are not on the `/v1` chat route.** They use a separate
feature-extraction pipeline endpoint, which `elix doctor` probes. Free HF credit
is very small, so from Phase 4 every memory is embedded exactly once and the
vector is stored forever — never re-embedded.

## Server

Default profile `main` = `145.241.127.222:25565` — Minecraft 26.2 (protocol
776), offline mode, whitelist on. `config/elix.yaml` holds it.

The target version is a **config value**, resolved as CLI flag > profile >
`bot.version`. Moving to a new Minecraft version is a one-line config change
plus updated protocol data in `vendor/minecraft-data/`.

## How 26.2 support works

npm's `minecraft-data` 3.117.0 has no 26.2 data, so it is vendored:

| What | Where | Why |
|---|---|---|
| 26.2 protocol/block/item data | `vendor/minecraft-data/` | from PrismarineJS/minecraft-data PR #1298 (commit `68ea7b59`, protocol 776, dataVersion 4903) |
| `minecraft-data` override | `pnpm-workspace.yaml` → `overrides` | makes every package resolve 26.2 |
| mineflayer 26.2 registration | `patches/mineflayer@4.39.0.patch` | adds `26.2` to `testedVersions` |
| chunk codec | `patches/prismarine-chunk@1.41.0.patch` | maps 26.2 to the 1.18 chunk implementation |
| water gravity + ladder climbing | `patches/prismarine-physics@1.11.1.patch` | adds `26.2` to `proportionalLiquidGravity` and `climbUsingJump` |

All three patches are generated with `pnpm patch` / `pnpm patch-commit`, so a
clean `pnpm install` reproduces them. There are **no hand-edits in
`node_modules`** and no runtime monkey-patching.

Because the project is `"type": "module"`, CommonJS dependencies are loaded via
`createRequire(import.meta.url)`. A bare `require(...)` would be a runtime
`ReferenceError`; ESLint forbids one in `src/`.

## Project layout

```
src/
  cli/          commander commands; bin.ts is the entrypoint
  core/         config (zod), logger (pino), event bus, lifecycle, exit, doctor
  connection/   mineflayer session, ping, reconnect, kick reasons, version adapter
  social/       SayQueue — the single outbound chat path (rate limit + typing)
config/         elix.yaml, models.yaml, persona.md
docs/           VISION.md — the design for Phases 3-10
data/           elix.db (gitignored), overrides/ (committed), kb/, backups/
patches/        pnpm patches for mineflayer, prismarine-chunk, prismarine-physics
vendor/         vendored minecraft-data with 26.2
tests/
  unit/         in-process tests
  runtime/      checks that spawn real node processes against the built bundle
```

## Development

```bash
pnpm typecheck   # tsc --noEmit on src, then on src + tests
pnpm lint
pnpm test        # builds dist/ first, so a fresh clone passes
pnpm build
pnpm doctor
```

`pnpm test` builds automatically, and `tests/runtime/` runs the kick-reason
parser under plain node and against `dist/` — unit tests run inside vitest, which
injects its own `require` and hides ESM failures.

## Behaviour notes

- **No authentication, ever.** No Microsoft/Mojang login, no `/register`, no
  `/login`, no passwords. A whitelist kick prints exactly one line —
  `whitelist add Elix` — and exits with code 2. It never loops.
- **Never digs.** The walk uses a `Movements` config with `canDig = false`, no 1×1
  towers and no scaffolding, and only picks a target with a solid, non-hazardous
  floor and clear body and head height. If no safe direction exists it skips the
  walk and says why. Lava, magma, fire, powder snow and the 26.2 sulfur blocks are
  never treated as walkable.
- **Rate-limited chat.** Everything goes through `src/social/say.ts`: at most
  `safety.chatRateLimitPer2s` messages per 2 s, a ~55 ms/char typing delay capped
  at 3 s, duplicates dropped within 10 s, and a hard cap of 5 queued messages so
  a burst can never build a multi-minute backlog.
- **Survives drops.** A failed ping or a socket close reconnects on a
  5 s → 10 s → 30 s → 60 s ladder. A successful spawn resets it.
- **Exits cleanly.** Every exit goes through `src/core/exit.ts`, which sets
  `process.exitCode` and lets the event loop drain. A second Ctrl+C force-exits
  with code 130, and `Lifecycle` owns the only hard timeout.
- **Emotions are a simulation.** The code and docs say so. If asked directly
  whether he is an AI, Elix does not deny it.