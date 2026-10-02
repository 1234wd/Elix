/**
 * Runtime probe for the kick-reason parser, run OUTSIDE vitest.
 *
 * This project is `"type": "module"`, so a bare `require(...)` is a
 * ReferenceError at runtime. vitest injects its own `require` into every module,
 * which is why the unit tests passed while the real CLI produced
 * "[object Object]" for every in-game kick. This file runs under plain node with
 * tsx, so it exercises the real ESM semantics.
 *
 * Usage: node --import tsx tests/runtime/probe-kickreason.mts
 */
import { describeReason } from "../../src/connection/kickReason.js";
import { classifyDisconnect } from "../../src/connection/reconnect.js";

const NBT_WHITELIST = {
  type: "compound",
  value: { translate: { type: "string", value: "multiplayer.disconnect.not_whitelisted" } },
};

const d = describeReason(NBT_WHITELIST, "26.2");
const info = classifyDisconnect(d.translateKey ?? d.text, 0);

// Machine-readable so tests/runtime/check-kickreason.mjs can assert on it.
console.log(
  JSON.stringify({
    text: d.text,
    translateKey: d.translateKey ?? null,
    kind: info.kind,
    shouldRetry: info.shouldRetry,
  }),
);

const ok = d.translateKey === "multiplayer.disconnect.not_whitelisted" && info.kind === "whitelist";
process.exitCode = ok ? 0 : 1;