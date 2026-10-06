# VOICE_PLAN — how Elix would join Simple Voice Chat

Status: **plan only. Nothing in this document is implemented.** Round 17 §3 WP12 asked for a
written plan plus a *minimal, disabled-by-default* spike that can be tested without a live
server. See §7 for what the spike does and does not do, and §8 for the test plan.

The honest first line of this document: **voice is the riskiest thing on the roadmap.** Every
other WP changes what Elix does in a world it can see and roll back. Voice adds a UDP socket,
a crypto handshake, a third-party protocol and a second failure domain, on a bot whose whole
purpose is being a good companion. So everything below is ordered so that the useful half —
the planning — costs nothing if the risky half is never built.

---

## 1. What Simple Voice Chat actually is

Simple Voice Chat (SVC) is a Minecraft mod. Elix is a `mineflayer` client, not a mod, so it
cannot load it. It has to be the **other side of the protocol**, which means:

| Piece | Value | Why it matters here |
| --- | --- | --- |
| Protocol version | 3 | The handshake is versioned; anything else is refused. |
| Transport | **UDP**, no fallback | There is no TCP path. A proxy or a restrictive network can break it and nothing will say so. |
| Port | `24454` default | A second listening socket on the owner's server box. |
| Host address | Configured server address | SVC's master server (`https://simplevoice.chat/`) hands out the voice host per *server*, not per player. |
| Credentials | `uuid`, `username`, `serverId` | The identity is the Minecraft UUID. A bot has one, and it is stable across restarts. |
| Group | `default`, configurable | Everyone in the same group hears each other. |

**Discovery is the first thing to get right and the easiest to get wrong.** The master
server maps a *server id* (derived from the server address) to a voice host. The server id
for SVC is `MurmurHash3(server_address, 0x9747b28c)`. Getting it wrong does not fail loudly:
SVC simply hands back a host nobody is listening on, and Elix joins a silent room. So the
first test must assert the hash against a known vector, not just "a host came back".

### 1.1 Handshake, as an actual sequence

```
Elix                                    SVC voice host
 |                                          |
 |-- UDP: connect(token, udpPort) ---------->|   token from the master server lookup
 |<--------------- token accepted ----------|   (or rejected: no handler, silence)
 |                                          |
 |--- UDP: type 0x1 (server capabilities) -->|
 |<-------------- capabilities ------------|
 |                                          |
 |--- UDP: type 0x2 (peer capabilities) ---->|
 |<--------------- peer list --------------|
 |                                          |
 |--- UDP: type 0x3 (voice chat request) --->|
 |<--------------- voice chat ------------|
 |                                          |
 |          ... Opus frames, 48 kHz, 20 ms, every 20 ms ...
 |                                          |
 |--- UDP: type 0xB (disconnect) ---------->|
```

The detail that decides whether this works at all: **`connect` carries the token and the UDP
port, and the token must be requested per channel.** A single token is not reusable — asking
again invalidates the previous one. Any design that caches a token for the life of the
process will fail on the first reconnect.

### 1.2 Encryption, and the part that is genuinely unsolved

SVC encrypts voice with Salsa20. As of this writing, **SVC does not publish the key
schedule**, so a third-party implementation must derive the 32-byte key from the token by
reverse-engineering. That is the single largest unknown in this plan, and it is why §7's spike
deliberately **does not carry audio**.

Two honest options:

1. **Wait for the reference implementation.** SVC's own server code is the only reliable
   source. A bot that joins a voice group and produces silent packets is worse than a bot that
   never joins.
2. **Ship encrypted transport, decode nothing.** Connect, complete the handshake, send and
   receive correctly-framed packets, and discard the payload. That proves the hard part —
   discovery, handshake, token lifecycle, keepalive — without needing the key schedule at
   all. **This is what the spike in §7 does.**

Until the key schedule is public, do not claim Elix can hear or speak in voice. Say nothing.

### 1.3 Audio format

| Property | Value |
| --- | --- |
| Codec | **Opus**, always |
| Sample rate | **48 000 Hz**, always — Opus has no other rate |
| Frame | **20 ms** (960 samples), every 20 ms |
| Channels | 1 in, 1 out (mono). Stereo is negotiated but never used here. |
| Bitrate | 16–24 kbps is plenty for speech |
| Packetisation | One packet per frame. No FEC, no jitter buffer initially. |

Mono matters: the game gives a positional mix, and Elix's ears should be at his feet, not
spread across a stereo field.

---

## 2. Speaking: the TTS choices

| Option | Quality | Cost | Latency | Verdict |
| --- | --- | --- | --- | --- |
| **Groq Whisper** | — | — | — | **STT, not TTS.** See below. |
| **Local Piper** | Good | Free, CPU-only | ~200 ms | **Primary TTS.** Already a plausible box for a Minecraft server. |
| **Local Kokoro** | Excellent | Free, GPU preferred | ~150 ms | Alt TTS; needs a GPU worth its electricity. |
| **OpenAI-compatible cloud TTS** | Excellent | Per character, needs a key | ~400 ms | Fallback only. |

**STT is Groq Whisper, with a local fallback.** Groq's Whisper is fast, cheap, and already in
`config/models.yaml` under the `stt` role. The local fallback is **whisper.cpp** with a `base`
or `small` model; anything larger is not worth the RAM on the same box as a Minecraft server.

### 2.1 The rules that matter more than the choice

- **Never interrupt.** If Elix is speaking, the STT queue is dropped, not buffered. A backlog
  of things said while he was talking produces replies to the wrong line.
- **One utterance in, one answer out.** The VAD (voice activity detection) gates on a fixed
  silence window; no partial transcripts are ever answered.
- **Echo is the whole problem.** Elix hears himself. The gate is simple and non-negotiable:
  **no microphone input is processed while Elix has TTS audio in flight, plus a 300 ms tail.**
  Without it the bot talks to itself for an hour.
- **Voice never bypasses a gate.** A spoken line is still a line. It goes through
  `gateOwnLine` / `gateReply` exactly like a typed one, because the person cannot tell from
  the content whether Elix classified them.
- **A wellbeing-floor line in voice never triggers an action**, and Elix's *voice* answer to
  one is slowed down, not sped up.
- **Fallback is silent.** If neither STT nor TTS is available, `voice.enabled` behaves
  exactly as if voice did not exist. No "sorry, I can't hear you" every thirty seconds.

---

## 3. Risks, ranked by how much damage they do

| # | Risk | Damage | Mitigation |
| --- | --- | --- | --- |
| 1 | **Echo loop.** Elix hears his own TTS and talks to himself. | Bot becomes unusable; server admin bans it. | Hard mute of mic while TTS is in flight + 300 ms tail. Never optional. |
| 2 | **Unpublished key schedule.** Cannot decode SVC audio. | Voice is half-dead: Elix can join but not hear. | Do not ship audio until it is public. See §1.2. |
| 3 | **Discovery silently fails.** Wrong server id ⇒ silent room. | "Voice doesn't work" with nothing in the log. | Assert the MurmurHash3 vector in a test; log the resolved host and port. |
| 4 | **No UDP.** A proxy or a strict host firewall drops it. | Voice unavailable; no error surfaces. | A startup probe with a short deadline; `elix doctor` reports it. Same shape as the Ollama probe. |
| 5 | **Token lifecycle.** Re-requesting invalidates the old token. | Drops out mid-conversation. | One token per channel, held explicitly, re-requested only on a real disconnect. |
| 6 | **Privacy.** Other players' voices are people. | Serious. | Nothing is recorded. No transcript is persisted. Nothing leaves the box except the STT text already governed by the existing gates. |
| 7 | **Latency.** STT + brain + TTS stacked. | Unnatural pauses. | STT on a fast tier, brain on `smart`, TTS local. Measure each stage; a 2 s reply is worse than no reply. |
| 8 | **Audio bandwidth.** 20 ms packets are a lot of them. | Congestion on a small link. | 16 kbps mono, DTX on during silence. |

Risk 1 is the one that has actually happened in projects like this. It is listed first because
it is the one that ends the experiment.

---

## 4. What "human-like" costs in audio that it did not in text

The vision's social rules — the eased gaze of WP4, the reaction delay of WP3, the crouch-greet
— all have audio equivalents, and all of them must be **slower** in voice, not the same:

- **Reaction delay** applies to speaking, not just to hitting. 180–320 ms is right for a
  swing; a reply that starts 200 ms after the last word sounds like an interruption.
- **Speaking rate** is the loudest single signal of a fake voice. Cap at ~150 wpm, and put a
  small pause at commas. Elix should sound like somebody thinking, not reading.
- **Interruption**: if the human starts talking mid-answer, stop. Being talked over is fine;
  talking over somebody is not, and a bot that cannot be interrupted is the worst company.

---

## 5. Configuration

```yaml
voice:
  enabled: false              # default OFF. No partial voice code runs when this is false.
  channel: default
  tts: local                  # local | cloud | none
  stt: groq                   # groq | local | none
  speakRateWpm: 150
  interruptible: true
  listenWhileSpeaking: false  # the echo guard. Flipping this on is a bug, not a setting.
```

`listenWhileSpeaking: false` is listed as a setting purely so it can be asserted by a test.
It is not something an operator should ever want to change.

---

## 6. Where it would live

- `src/voice/protocol.ts` — handshake frames, token lifecycle, the discovery hash
- `src/voice/transport.ts` — the UDP socket, keepalive, reconnect backoff
- `src/voice/audio.ts` — Opus encode/decode, the 48 kHz/20 ms/mono framing
- `src/voice/vad.ts` — silence gating, one utterance in / one answer out
- `src/voice/stt.ts`, `src/voice/tts.ts` — the two model calls, behind the existing providers

All of them new files. `bot.ts` would get exactly one tick of wiring, the same shape as WP2's
reflex runner: a `VoiceSession` that owns its state, answers to `stop`, and is silent when
`voice.enabled` is false.

---

## 7. The spike, and what it deliberately does not do

**Enabled only behind `voice.enabled`, default false.** Nothing in these modules is imported,
constructed or scheduled when that flag is false — and there is a test that proves it, by
asserting the spike's modules are absent from the module graph of a default start.

The spike does:

1. Compute the SVC server id from the server address (MurmurHash3, seeded `0x9747b28c`) and
   assert it against a known vector.
2. Query the SVC master server for the voice host and port.
3. Perform the UDP connect/handshake, hold the token, and keep the connection alive.
4. Send and receive correctly-framed packets of the right size, and **discard the payload**.

The spike does **not**:

- decode or produce audio;
- run STT or TTS;
- send anything that could be heard.

That is a real, testable increment — the entire hard part minus the part nobody can do yet —
and it cannot produce noise on a server.

---

## 8. Test plan

Everything here is testable without a live Minecraft server, which is why the spike is worth
building first.

**Pure and immediate:**

1. The server-id hash matches a known SVC vector.
2. Token lifecycle: a second request invalidates the first; the spike notices and reconnects.
3. Frame layout: every outbound packet is the right length, and a 20 ms Opus frame is 960
   samples at 48 kHz, mono.
4. `voice.enabled: false` ⇒ the spike's modules are not in the module graph. No socket, no
   timer, no fetch.
5. No audio, no STT and no TTS call happens while the flag is false.

**Against a fake voice host, locally:**

6. Handshake completes against a scripted UDP responder, and a rejected token produces one
   log line and a bounded retry — not a tight loop.
7. Unreachable host ⇒ the probe gives up inside its deadline and `elix doctor` says so,
   exactly like the Ollama probe.
8. Reconnect backoff is bounded and jittered.

**Against the real thing, the owner only:**

9. Start the mod server with a voice group; confirm Elix joins and `elix doctor` reports the
   group id and the resolved host.
10. Speak, and confirm the STT transcript is right **and that Elix does not answer his own
    TTS** — risk 1, checked by eye, because it is the only test that means anything.
11. Interrupt Elix mid-sentence; confirm he stops.

Rows 10 and 11 are ❌ until somebody runs them. They are the acceptance criteria for enabling
voice for real, and until both pass, `voice.enabled` stays false.

---

## 9. Recommendation

Build the spike (§7), ship nothing else, and re-read this document when the key schedule is
public or a reference implementation exists. Voice is a companion's finishing touch, not its
foundation, and the foundation is now good: Elix protects people, gathers, crafts, remembers,
and never touches somebody's chest. None of that is improved by hearing them, and all of it is
damaged by a bot that loops on its own voice.

**Until rows 10 and 11 pass on a real server: `voice.enabled` stays `false`.**