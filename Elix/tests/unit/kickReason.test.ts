import { describe, it, expect } from "vitest";
import { describeReason } from "../../src/connection/kickReason.js";
import { classifyDisconnect } from "../../src/connection/reconnect.js";

/**
 * A2: in 26.2 the kick reason arrives as an NBT object, not a JSON string.
 * prismarine-chat 1.13.x exports a LOADER function; this suite pins the
 * behaviour that would silently regress to "[object Object]".
 */

describe("describeReason — formats", () => {
  it("handles a plain string", () => {
    const r = describeReason("Kicked by an operator");
    expect(r.text).toBe("Kicked by an operator");
  });

  it("handles a JSON string with a translate key", () => {
    const r = describeReason('{"translate":"multiplayer.disconnect.not_whitelisted"}');
    expect(r.translateKey).toBe("multiplayer.disconnect.not_whitelisted");
    // Language file resolves it to real English, not "[object Object]".
    expect(r.text).not.toBe("[object Object]");
    expect(r.text.length).toBeGreaterThan(0);
  });

  it("handles a plain chat object", () => {
    const r = describeReason({ text: "Kicked by an operator" });
    expect(r.text).toBe("Kicked by an operator");
  });

  it("handles an NBT compound (the real in-game kick format)", () => {
    const raw = {
      type: "compound",
      value: { text: { type: "string", value: "Kicked by an operator" } },
    };
    const r = describeReason(raw);
    expect(r.text).toBe("Kicked by an operator");
    expect(r.text).not.toBe("[object Object]");
  });

  it("handles a plain NBT string", () => {
    const raw = { type: "string", value: "You are not white-listed on this server!" };
    const r = describeReason(raw);
    expect(r.text).toBe("You are not white-listed on this server!");
  });

  it("handles nested extra components", () => {
    const raw = { extra: [{ text: "You are " }, { translate: "multiplayer.disconnect.not_whitelisted" }] };
    const r = describeReason(raw);
    // The translate key lives inside extra — the walker must find it.
    expect(r.translateKey).toBe("multiplayer.disconnect.not_whitelisted");
  });

  it("handles translate + with arguments", () => {
    const raw = { translate: "multiplayer.disconnect.banned.reason", with: ["Elix"] };
    const r = describeReason(raw);
    expect(r.translateKey).toBe("multiplayer.disconnect.banned.reason");
    expect(r.text).toContain("Elix");
  });

  it("handles an NBT compound wrapping a translate key", () => {
    const raw = {
      type: "compound",
      value: { translate: { type: "string", value: "multiplayer.disconnect.banned" } },
    };
    const r = describeReason(raw);
    expect(r.translateKey).toBe("multiplayer.disconnect.banned");
  });

  it("never throws on null or undefined", () => {
    expect(() => describeReason(null)).not.toThrow();
    expect(() => describeReason(undefined)).not.toThrow();
    expect(describeReason(null).text).toBe("null");
  });

  it("never returns [object Object] for any object input", () => {
    const inputs: unknown[] = [
      { text: "hello" },
      { extra: [{ text: "a" }, { text: "b" }] },
      { type: "compound", value: { text: { type: "string", value: "x" } } },
      { type: "string", value: "y" },
    ];
    for (const input of inputs) {
      expect(describeReason(input).text).not.toBe("[object Object]");
    }
  });
});

describe("describeReason → classifyDisconnect (A2 + A6)", () => {
  /** Classify on the translate key when present, else the text. */
  const classify = (raw: unknown) => {
    const d = describeReason(raw);
    return classifyDisconnect(d.translateKey ?? d.text, 0);
  };

  it("classifies vanilla's 'white-listed' English text as whitelist", () => {
    const raw = { type: "string", value: "You are not white-listed on this server!" };
    const info = classify(raw);
    expect(info.kind).toBe("whitelist");
    expect(info.shouldRetry).toBe(false);
  });

  it("classifies an in-game NBT whitelist kick as permanent", () => {
    const raw = {
      type: "compound",
      value: { translate: { type: "string", value: "multiplayer.disconnect.not_whitelisted" } },
    };
    const info = classify(raw);
    expect(info.kind).toBe("whitelist");
    expect(info.shouldRetry).toBe(false);
  });

  it("classifies an in-game NBT ban as permanent", () => {
    const raw = {
      type: "compound",
      value: { translate: { type: "string", value: "multiplayer.disconnect.banned.reason" }, with: [{ type: "string", value: "griefing" }] },
    };
    const info = classify(raw);
    expect(info.kind).toBe("ban");
    expect(info.shouldRetry).toBe(false);
  });

  it("still retries a generic operator kick", () => {
    const raw = {
      type: "compound",
      value: { text: { type: "string", value: "Kicked by an operator" } },
    };
    const info = classify(raw);
    expect(info.kind).toBe("kick");
    expect(info.shouldRetry).toBe(true);
    expect(info.retryAfterMs).toBe(5000);
  });
});