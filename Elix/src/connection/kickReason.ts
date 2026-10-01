/**
 * Kick reason parser — handles JSON strings, plain objects, and NBT compounds.
 *
 * In 26.2, play.kick_disconnect.reason and configuration.disconnect.reason are
 * anonymousNbt (see vendor/.../26.2/protocol.json). Only the login-state
 * disconnect sends a JSON string. prismarine-chat's ChatMessage.fromNotch
 * handles all three via processNbtMessage.
 *
 * IMPORTANT: prismarine-chat 1.13.x exports a LOADER FUNCTION, not an object:
 *   const ChatMessage = require("prismarine-chat")("26.2")
 * Verified with node scripts/probe-chat.cjs.
 */

/** Minimal shape of the prismarine-chat ChatMessage class we depend on. */
interface ChatMessageLike {
  json: unknown;
  toString(lang?: unknown): string;
}

interface ChatMessageCtor {
  fromNotch(msg: unknown): ChatMessageLike;
}

export interface DescribedReason {
  /** Human-readable text */
  text: string;
  /** Minecraft translate key if found (e.g. "multiplayer.disconnect.not_whitelisted") */
  translateKey?: string;
}

/**
 * prismarine-chat's loader is cached per-version — building the registry for
 * 26.2 walks ~1200 blocks, so we do it once per process.
 */
const ctorCache = new Map<string, ChatMessageCtor>();

function chatMessageFor(version: string): ChatMessageCtor | null {
  const cached = ctorCache.get(version);
  if (cached) return cached;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const loader = require("prismarine-chat") as (v: string) => ChatMessageCtor;
    if (typeof loader !== "function") return null;
    const ctor = loader(version);
    if (typeof ctor?.fromNotch !== "function") return null;
    ctorCache.set(version, ctor);
    return ctor;
  } catch {
    return null;
  }
}

/**
 * Walk a JSON chat object recursively to find a translate key.
 * Checks json.translate, then json.with[*], then json.extra[*].
 */
function findTranslateKey(json: unknown): string | undefined {
  if (!json || typeof json !== "object") return undefined;
  const obj = json as Record<string, unknown>;
  if (typeof obj.translate === "string") return obj.translate;
  for (const key of ["with", "extra"] as const) {
    const list = obj[key];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const found = findTranslateKey(item);
      if (found) return found;
    }
  }
  return undefined;
}

/** Plain-text fallback for JSON-shaped objects with no prismarine-chat available. */
function plainTextFromJson(json: unknown): string {
  if (!json || typeof json !== "object") return "";
  const obj = json as Record<string, unknown>;
  if (typeof obj.text === "string") return obj.text;
  let out = "";
  if (Array.isArray(obj.extra)) {
    for (const item of obj.extra) out += plainTextFromJson(item);
  }
  return out;
}

/**
 * Describe a kick/disconnect reason from any format:
 * - JSON string: '{"translate":"multiplayer.disconnect.not_whitelisted"}'
 * - Plain object: { text: "You are banned!" }
 * - NBT compound: { type: "compound", value: { text: { type: "string", value: "..." } } }
 * - Plain string: "Kicked by an operator"
 */
export function describeReason(raw: unknown, mcVersion = "26.2"): DescribedReason {
  // 1. Plain string that is not JSON — use verbatim.
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
      return trimmed.length > 0 ? { text: raw } : { text: String(raw) };
    }
  }

  // 2. null/undefined — never throws.
  if (raw === null || raw === undefined) {
    return { text: String(raw) };
  }

  // 3. prismarine-chat handles JSON strings, objects and NBT uniformly.
  const ctor = chatMessageFor(mcVersion);
  if (ctor) {
    try {
      const msg = ctor.fromNotch(raw);
      const text = typeof msg.toString() === "string" ? msg.toString() : "";
      const translateKey = findTranslateKey(msg.json);
      if (text.length > 0 || translateKey) {
        return translateKey ? { text, translateKey } : { text };
      }
    } catch {
      // fall through to the manual path
    }
  }

  // 4. Manual path — walk the raw object ourselves.
  let json: unknown = raw;
  if (typeof raw === "string") {
    try {
      json = JSON.parse(raw);
    } catch {
      return { text: raw };
    }
  }
  const translateKey = findTranslateKey(json);
  let text = plainTextFromJson(json);
  if (text.length === 0) {
    const obj = json as Record<string, unknown>;
    if (typeof obj.translate === "string") text = obj.translate;
    else if (typeof obj.text === "string") text = obj.text;
    else text = String(raw);
  }
  return translateKey ? { text, translateKey } : { text };
}