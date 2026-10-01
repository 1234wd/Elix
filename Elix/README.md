# Elix

An autonomous Minecraft Java Edition companion that joins offline-mode servers
as a normal player, plays with real skill, remembers everything, and behaves
like a warm, funny, loyal friend. Built as a real coded project (not a mod,
not a plugin) — one command, headless, from Windows CMD.

## Status — Phase 1 (Skeleton) complete

- [x] **Phase 1 — Skeleton:** repo, zod-validated config, CLI, logging, `elix doctor`
- [ ] Phase 2 — Connection (mineflayer → 26.2 server, reconnect, basic behavior)
- [ ] Phase 3 — Brain router (3 cloud providers, failover, usage)
- [ ] Phase 4 — Memory (SQLite + vec + FTS, consolidation)
- [ ] Phase 5 — Social + persona + emotions
- [ ] Phase 6 — Reflex + core skills
- [ ] Phase 7 — Planner (goals → task trees)
- [ ] Phase 8 — Knowledge (minecraft-data + wiki RAG)
- [ ] Phase 9 — Voice (SVC, VAD, STT, TTS, barge-in)
- [ ] Phase 10 — Polish (safety, dashboard, soak tests)

## Verified ground truth (1 Oct 2026)

| Fact | Result |
|---|---|
| mineflayer latest | 4.39.0 |
| minecraft-data npm | 3.117.0 — no 26.2 |
| 26.2 data source | PR #1298 merged (commit `68ea7b59`), protocol 776 |
| Vendored data | `vendor/minecraft-data/` — 19 files from PR #1298 |

**Connection plan:** Elix connects directly as a 26.2 client using vendored
community data. No ViaProxy, no Java, nothing extra on your laptop. If native
26.2 proves unstable, the fallback is ViaVersion + ViaBackwards on the server
(Elix then joins as 26.1).

## Quickstart (development)

```bash
pnpm install
cp .env.example .env     # add provider keys (optional — scripted fallback works without)
pnpm dev -- doctor       # environment check
pnpm dev -- status       # config summary
```

Release build: `pnpm build` → `elix.cmd` / `elix.sh` wrappers use `dist/`.

## Server

Default profile `main`: `145.241.127.222:25565` — Minecraft 26.2, offline
mode, whitelist on. Elix pings the server on connect to report the exact
version, protocol number and server software.

## CLI

```
elix doctor [--json]     environment + config health check (incl. live API test + server ping)
elix start               connect (phase 2) — validates config, shows the plan
elix status              config summary
elix usage               LLM call tracking (phase 3)
elix memory search|forget (phase 4)
elix kb build            knowledge base (phase 8)
elix setup               first-run wizard (phase 5)
```

## Project layout

```
src/
  cli/     commander commands (doctor, stubs for later phases)
  core/    config (zod), logger (pino), typed event bus, lifecycle, doctor checks
  connection/  (phase 2) mineflayer bot, ping, reconnect, kick classification
  reflex/  (phase 6) 20 Hz survival + combat loop
  skills/  (phase 6) built-in skills; skills/learned/ sandboxed
  planner/ (phase 7) goal stack, task trees, re-planning
  social/  (phase 5) chat, addressing, typing realism
  brain/   (phase 3) provider router, prompt builder, budgeter
  memory/  (phase 4) sqlite + sqlite-vec + FTS5, retrieval, consolidation
  emotion/ (phase 5) affect engine, needs, initiative
  knowledge/ (phase 8) minecraft-data wrapper, wiki RAG
  voice/   (phase 9) svc, vad, stt, tts, opus, barge-in
  safety/  (phase 10) guard, filters, rate limits
  dashboard/ (phase 10)
vendor/
  minecraft-data/  26.2 data (protocol 776) from PR #1298
config/    elix.yaml, models.yaml, persona.md
data/      elix.db, kb/, backups/, overrides/
tests/     unit/ scenarios/
```

## Tests

```bash
pnpm test        # unit tests: config, doctor, event bus, lifecycle
pnpm lint
pnpm exec tsc --noEmit
```

## Honesty notes

- `elix start` is a validated stub in phase 1 — it never fakes a connection.
- Cloud AI only — no local models. Free tiers change and are rate-limited.
  If every provider is down, Elix says "brb, lag" and keeps playing on the
  skill layer.
- Elix's emotions are a simulation that makes him a better companion. If asked
  directly whether he is an AI, he does not deny it.
