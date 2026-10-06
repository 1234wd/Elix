/**
 * WP9 — status, in a form that can be read out loud and pasted into a bug report without
 * leaking anything.
 *
 * The redaction is the whole design. A status line is the single most likely thing to end up
 * in a screenshot or a pastebin, so:
 *
 *   - NO KEYS. Not masked, not truncated - absent. `redact()` strips anything that LOOKS
 *     like a key (`sk-...`, `hf_...`, `nvapi-...`, `gsk_...`) and any configured env value,
 *     whatever it looks like, because a future provider will use a prefix this file has never
 *     heard of.
 *   - NO CHAT TEXT. Not the last message, not a truncated one, not the player's name. If a
 *     name is needed for "who is asking", the caller passes an OWNER flag, not the name.
 *   - The shape is fixed, so there is no field where a message could end up by accident.
 */
/** One provider's state. This is the ONLY shape a status line is built from. */
export interface ProviderStatus {
  provider: string;
  /** Whether it answered the last health check. */
  healthy: boolean;
  /** When its breaker is open until, or null when it is closed. */
  breakerOpenUntil: number | null;
  /** Calls today. A count, never an error body. */
  callsToday: number;
  /** The model actually in use, or null. Discovered at startup, never hard-coded. */
  model: string | null;
}

/** Everything `elix status` reports. Deliberately small. */
export interface StatusSnapshot {
  /** Providers in the vision's order. */
  providers: ProviderStatus[];
  /** What Elix is doing right now, e.g. "idle" or "follow". */
  currentAction: string;
  /** The mood label, never the mood text. */
  moodLabel: string;
  /** How many safety audits are still in flight. */
  pendingAudits: number;
  /** Whether anybody has said anything to Elix this session. A boolean, not the text. */
  hasSpoken: boolean;
  /** Seconds since Elix joined. */
  uptimeSeconds: number;
}

/** Anything that looks like a key from any provider, past or future. */
const KEY_SHAPED = [
  /\bsk-[A-Za-z0-9_-]{16,}/gu,
  /\bhf_[A-Za-z0-9]{16,}/gu,
  /\bnvapi-[A-Za-z0-9_-]{16,}/gu,
  /\bgsk_[A-Za-z0-9]{16,}/gu,
  /\bAKIA[0-9A-Z]{16}/gu,
  /\bBearer\s+[A-Za-z0-9._-]{16,}/gu,
  /\bapi[_-]?key["'\s:=]+[A-Za-z0-9._-]{16,}/giu,
];

/** The word every redaction uses, so a reader can see something was removed. */
export const REDACTED = "[redacted]";

/**
 * Strip anything key-shaped, plus any literal value the caller says is secret.
 *
 * The extra `secrets` list is the important half: a provider nobody has used yet will use a
 * prefix this file has never seen, so the caller passes the configured env values and they
 * are removed by value.
 */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const pattern of KEY_SHAPED) out = out.replace(pattern, REDACTED);
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 8) {
      out = out.split(secret).join(REDACTED);
    }
  }
  return out;
}

/** True when this text contains anything key-shaped. Used by the redaction tests. */
export function containsKeyShaped(text: string): boolean {
  return KEY_SHAPED.some((pattern) => {
    // Non-global copies, because `.test` on a /g regex is stateful.
    const fresh = new RegExp(pattern.source, pattern.flags.replace("g", ""));
    return fresh.test(text);
  });
}

/** One line per provider, and nothing else about them. */
export function providerLines(snapshot: StatusSnapshot, now: number): string[] {
  const out: string[] = [];
  for (const p of snapshot.providers) {
    const breaker =
      p.breakerOpenUntil === null
        ? "breaker closed"
        : p.breakerOpenUntil <= now
          ? "breaker closed"
          : `breaker open for ${Math.ceil((p.breakerOpenUntil - now) / 60_000)} min`;
    out.push(`${p.provider}: ${p.healthy ? "ok" : "not answering"}, ${breaker}, ${p.callsToday} calls today${p.model === null ? "" : `, model ${p.model}`}`);
  }
  return out;
}

/**
 * The status text, for the CLI and for a whisper.
 *
 * Plain lines, no colour codes, no JSON - this is going into a chat window or a terminal
 * either way, and a status that has to be formatted differently in each place is a status
 * that will be reformatted wrongly in one of them.
 */
export function renderStatus(snapshot: StatusSnapshot, now: number, secrets: readonly string[] = []): string {
  const lines: string[] = [];
  lines.push("elix status");
  lines.push(`uptime: ${Math.floor(snapshot.uptimeSeconds / 60)} min`);
  lines.push(...providerLines(snapshot, now));
  lines.push(`action: ${snapshot.currentAction}`);
  lines.push(`mood: ${snapshot.moodLabel}`);
  lines.push(`pending audits: ${snapshot.pendingAudits}`);
  // A boolean. The message itself is not here and never will be.
  lines.push(`talked to someone: ${snapshot.hasSpoken ? "yes" : "no"}`);
  return redact(lines.join("\n"), secrets);
}

/** The short form for a whisper, where four lines is already a lot. */
export function renderStatusWhisper(snapshot: StatusSnapshot, now: number, secrets: readonly string[] = []): string {
  const up = snapshot.providers.filter((p) => p.healthy).length;
  const lines = [
    `elix status: ${up}/${snapshot.providers.length} providers answering`,
    `action: ${snapshot.currentAction}, mood: ${snapshot.moodLabel}`,
    `pending audits: ${snapshot.pendingAudits}`,
  ];
  return redact(lines.join(" | "), secrets);
}

/** A warning `elix doctor` should raise. */
export interface DoctorWarning {
  code: string;
  message: string;
  severity: "warn" | "info";
}

/** What the doctor needs to know about this deployment. */
export interface DoctorInput {
  /** The configured owner list. */
  owners: readonly string[];
  /** The server host as configured. */
  host: string;
  /** Did the server say it is in offline mode? Null when it did not say. */
  onlineMode: boolean | null;
}

/**
 * Loopback and private ranges. A LAN server is not the open internet.
 *
 * These are PREFIX matches, not full-string matches. An earlier version anchored the end
 * after `127\.` with only an optional `/...` tail, so `127.0.0.1` did not match it and the
 * doctor told the owner to firewall a loopback address - a warning people learn to ignore.
 */
const LOCAL_HOSTS = /^(localhost|127\.|0\.0\.0\.0|\[::1\]|::1)/u;
const LAN_HOSTS = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/u;

/**
 * The first-run warnings.
 *
 * The offline-mode one is the important one and it is easy to get wrong in a comforting
 * direction: an offline server accepts ANY username, so "they added themselves to owners" is
 * not evidence of anything. On a public IP it means anybody on the internet can type Elix's
 * owner's name and be obeyed.
 */
export function firstRunWarnings(input: DoctorInput): DoctorWarning[] {
  const out: DoctorWarning[] = [];
  if (input.owners.length === 0) {
    out.push({
      code: "no-owners",
      severity: "warn",
      message:
        "no owners configured - nobody can command Elix. Add your Minecraft name to `owners` in config/elix.yaml.",
    });
  }
  const isLocal = LOCAL_HOSTS.test(input.host);
  const isLan = LAN_HOSTS.test(input.host);
  if (input.onlineMode === false && !isLocal && !isLan) {
    out.push({
      code: "offline-public-host",
      severity: "warn",
      message:
        "the server is in OFFLINE mode and the host is not localhost or a LAN address. In offline mode the server accepts any username, so anyone who can reach this port and guesses an owner's name can command Elix. Firewall the port to your own IP.",
    });
  }
  if (input.onlineMode === false && (isLocal || isLan)) {
    out.push({
      code: "offline-private-host",
      severity: "info",
      message:
        "the server is in offline mode but the host is local or on your LAN. Anyone on the same network can still guess an owner's name - that is what an `owners` list cannot protect you from.",
    });
  }
  return out;
}

/** The README's first-run checklist, kept here so the CLI and the docs cannot drift. */
export const FIRST_RUN_CHECKLIST: readonly string[] = Object.freeze([
  "Add your Minecraft name to `owners` in config/elix.yaml - until you do, nobody can command Elix, including you.",
  "Read the warning about `owners` in that same file: on an OFFLINE-mode server any username can be typed by anybody, so the list is only as safe as your server's login and firewall.",
  "Firewall the server port to your own IP. On a public IP with online-mode off, somebody will find it.",
  "If either API key was ever shared, pasted or committed: rotate it. `pnpm test tests/unit/secrets.test.ts` is the check, and a rotated key is the only real fix.",
  "Run `pnpm e2e` before you trust anything: `pnpm exec tsx scripts/e2e-chat.ts --owners <yourName>`.",
  "Run `elix doctor` and clear every warning it prints.",
]);