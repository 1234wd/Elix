#!/usr/bin/env node
/**
 * Binary entrypoint (A10).
 *
 * index.ts only auto-runs when it detects itself as the entrypoint, which
 * bundling invalidates. So the published entry sets ELIX_NO_AUTORUN first and
 * then calls run() exactly once — one code path, no double invocation.
 */
process.env["ELIX_NO_AUTORUN"] = "1";

const { run } = await import("./index.js");

void run();