/**
 * Kick reason parser — handles JSON strings, plain objects, and NBT compounds.
 *
 * In 26.2, play.kick_disconnect.reason and configuration.disconnect.reason are
 * anonymousNbt (see vendor/.../26.2/protocol.json). Only the login-state
 * disconnect sends a JSON string. prismarine-chat's ChatMessage.fromNotch
 * handles all three via processNbtMessage.
 *
 * Two things this file must get right, both of which are easy to get wrong:
 *
 * 1. prismarine-chat 1.13.x exports a LOADER FUNCTION, not an object:
 *      const ChatMessage = require("prismarine-chat")("26.2")
 *    Calling `.ChatMessage` on the module gives undefined.
 *
 * 2. This project is `"type": "module"`, so a bare `require(...)` throws
 *    ReferenceError at runtime. Only a createRequire-derived require works.
 *    vitest injects its own `require`, which is why unit tests alone did not
 *    catch this — tests/runtime/ spawns real node processes to cover it.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

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
    const loader = require("prismarine-chat") as (v: string) => ChatMessageCtor;
    if (typeof loader !== "function") return null;
    const ctor = loader(version);
    if (typeof ctor?.fromNotch !== "function") return null;
    ctorCache.set(version, ctor);
    return ctor;
  } catch (err) {
    // Surface the cause once — a silent fallback here is what turned every
    // in-game NBT kick into "[object Object]".
    console.error(`[kickReason] prismarine-chat unavailable: ${(err as Error).message}`);
    return null;
  }
}

/** prismarine-nbt's simplify(), or null if it can't be loaded. */
function simplifyNbt(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || !("type" in raw)) return null;
  try {
    const nbt = require("prismarine-nbt") as { simplify(value: unknown): unknown };
    return nbt.simplify(raw);
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
  let out = typeof obj.text === "string" ? obj.text : "";
  if (Array.isArray(obj.extra)) {
    for (const item of obj.extra) out += plainTextFromJson(item);
  }
  return out;
}

/**
 * Unwrap an NBT structure into plain JSON values.
 *
 * prismarine-nbt's `simplify` does this properly ({type:"string",value:"x"}
 * becomes "x"). If it is unavailable, the shape is well-known enough to
 * unwrap by hand: tags nest under `value`, and compound values are objects.
 */
function nbtToJson(raw: unknown): unknown {
  const simplified = simplifyNbt(raw);
  if (simplified !== null) return simplified;

  if (!raw || typeof raw !== "object") return raw;
  const tag = raw as { type?: unknown; value?: unknown };
  if (typeof tag.type !== "string") return raw;
  if (tag.type === "end") return undefined;

  const { value } = tag;
  switch (tag.type) {
    case "compound": {
      if (!value || typeof value !== "object") return {};
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        const converted = nbtToJson(child);
        if (converted !== undefined) out[key] = converted;
      }
      return out;
    }
    case "list": {
      if (!Array.isArray(value)) return [];
      return value.map((item) => nbtToJson(item)).filter((x) => x !== undefined);
    }
    case "string":
    case "byte":
    case "short":
    case "int":
    case "long":
    case "float":
    case "double":
      return value;
    default:
      return value;
  }
}

/** Last resort: never "[object Object]", never a throw. */
function stringifySafe(raw: unknown): string {
  if (typeof raw === "string") return raw.slice(0, 200);
  try {
    return JSON.stringify(raw)?.slice(0, 200) ?? String(raw);
  } catch {
    return Object.prototype.toString.call(raw);
  }
}

/**
 * Describe a kick/disconnect reason from any format:
 * - JSON string: '{"translate":"multiplayer.disconnect.not_whitelisted"}'
 * - Plain object: { text: "You are banned!" }
 * - NBT compound: { type: "compound", value: { text: { type: "string", value: "..." } } }
 * - Plain string: "Kicked by an operator"
 *
 * The returned text is never "[object Object]" — classification depends on it.
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

  // 4. Manual path — normalise to plain JSON, then walk it ourselves. This must
  // understand NBT too, because it is the only path when prismarine-chat is
  // missing (a partial install, or a bundler that broke the require).
  let json: unknown = raw;
  if (typeof raw === "string") {
    try {
      json = JSON.parse(raw);
    } catch {
      return { text: raw };
    }
  } else {
    json = nbtToJson(raw);
  }

  const translateKey = findTranslateKey(json);
  let text = plainTextFromJson(json);
  if (text.length === 0) {
    const obj = json as Record<string, unknown> | null;
    // A translate key with no language entry is better than nothing: the
    // classifier matches on the key itself.
    if (typeof obj?.translate === "string") text = obj.translate;
    else if (typeof obj?.text === "string") text = obj.text;
  }
  if (text.length === 0) {
    // Genuinely unrecognisable. Return something readable and greppable.
    return translateKey ? { text: translateKey, translateKey } : { text: stringifySafe(raw) };
  }
  return translateKey ? { text, translateKey } : { text };
}