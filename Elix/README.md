# Elix

An autonomous Minecraft Java Edition companion that joins offline-mode servers
as a normal player, plays with real skill, remembers everything, and behaves
like a warm, funny, loyal friend.

## Status — Phase 2 (Connection) complete

- [x] **Phase 1 — Skeleton:** repo, zod-validated config, CLI, logging, `elix doctor`
- [x] **Phase 2 — Connection:** mineflayer → 26.2 server, reconnect, safe behaviour
- [ ] Phase 3 — Brain router (Groq → NVIDIA → Hugging Face, failover, usage)
- [ ] Phase 4 — Memory (SQLite + vec + FTS5, consolidation)
- [ ] Phase 5 — Social + persona + emotions
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

Cloud AI only: Groq → NVIDIA NIM → Hugging Face. No local models and no
downloaded weights of any kind.

```bash
cp .env.example .env     # then fill in whichever keys you have
```

`.env` is read from the project root regardless of your current folder. With no
keys at all Elix still connects and plays — the brain just falls back to
scripted in-character lines.

## Server

Default profile `main` = `145.241.127.222:25565` — Minecraft 26.2 (protocol
776), offline mode, whitelist on. `config/elix.yaml` holds it.

The target version is a **config value**. Moving to a new Minecraft version is a
one-line change in `config/elix.yaml` plus updated protocol data in
`vendor/minecraft-data/`.

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

## Project layout

```
src/
  cli/          commander commands; bin.ts is the entrypoint
  core/         config (zod), logger (pino), typed event bus, lifecycle, doctor
  connection/   mineflayer session, ping, reconnect, kick reasons, version adapter
  social/       SayQueue — the single outbound chat path (rate limit + typing)
config/         elix.yaml, models.yaml, persona.md
data/           elix.db (gitignored), overrides/ (committed), kb/, backups/
patches/        pnpm patches for mineflayer, prismarine-chunk, prismarine-physics
vendor/         vendored minecraft-data with 26.2
tests/unit/     203 tests
```

## Development

```bash
pnpm typecheck   # tsc --noEmit on src, then on src + tests
pnpm lint
pnpm test
pnpm build
pnpm doctor
```

## Behaviour notes

- **No authentication, ever.** No Microsoft/Mojang login, no `/register`, no
  `/login`, no passwords. Whitelist kick prints exactly one line —
  `whitelist add Elix` — and exits. It never loops.
- **Never digs.** The walk test uses a `Movements` config with `canDig = false`,
  no 1×1 towers and no scaffolding, and only picks a target with a solid floor
  and clear head height. If no safe direction exists it skips the walk and says
  why.
- **Rate-limited chat.** Everything goes through `src/social/say.ts`: at most
  `safety.chatRateLimitPer2s` messages per 2 s, a ~55 ms/char typing delay capped
  at 3 s, and duplicates dropped within 10 s.
- **Survives drops.** A failed ping or a socket close reconnects on a
  5 s → 10 s → 30 s → 60 s ladder. A successful spawn resets it.
- **Ctrl+C is clean.** "gtg, cya" goes out through the chat queue, the bot
  quits, memory cleanups run, and the process exits. A second Ctrl+C force-exits
  with code 130.
- **Emotions are a simulation.** The code and docs say so. If asked directly
  whether he is an AI, Elix does not deny it.