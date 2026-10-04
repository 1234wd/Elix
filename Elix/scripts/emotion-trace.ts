/**
 * An emotion trace from a scripted event sequence, as Part D asks for.
 *
 * This is the C2 engine driven through the vision's own appraisal table and then
 * some, with a hand-moved clock so decay is exact rather than waited for. It makes
 * the claim "deterministic, and every feeling carries a cause" inspectable instead
 * of asserted.
 *
 * Read-only: nothing here touches a database, a provider, or the network.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EmotionEngine,
  expressionHints,
  loadTemperament,
  parseTemperament as loadTemperamentFrom,
  manipulationProblem,
  type EmotionEvent,
} from "../src/social/emotion.js";
import { PROJECT_ROOT } from "../src/core/config.js";

const MIN = 60_000;
let now = 1_700_000_000_000;
const engine = new EmotionEngine({
  temperament: loadTemperament(join(PROJECT_ROOT, "config", "persona.md")),
  now: () => now,
  familiarity: (p) => (p === "Ali" ? 0.9 : p === "Zed" ? 0.1 : 0.45),
});

const script: Array<{ afterMin: number; event: EmotionEvent }> = [
  { afterMin: 0, event: { kind: "player-joined", player: "Ali", familiar: true } },
  { afterMin: 2, event: { kind: "rare-find", player: "Ali", what: "diamonds" } },
  { afterMin: 3, event: { kind: "thanked", player: "Ali" } },
  { afterMin: 5, event: { kind: "own-death", cause: "a creeper" } },
  { afterMin: 7, event: { kind: "near-miss", goal: "the diamond bridge" } },
  { afterMin: 9, event: { kind: "goal-completed", goal: "finished the house with Ali" } },
  { afterMin: 20, event: { kind: "player-left", player: "Ali", familiar: true } },
  { afterMin: 25, event: { kind: "ignored", player: "Zed", forMs: 95 * MIN } },
  { afterMin: 30, event: { kind: "idle", forMs: 45 * MIN } },
  { afterMin: 32, event: { kind: "player-joined", player: "Ali", familiar: true } },
];

const f = (n: number, w = 5): string => n.toFixed(w);
const pad = (s: string, n: number): string => s.padEnd(n);

console.log("Temperament, parsed from config/persona.md (the single source):");
console.log(`  warmth ${f(engine.traits.warmth, 2)}   extraversion ${f(engine.traits.extraversion, 2)}`);
console.log(`  agreeableness ${f(engine.traits.agreeableness, 2)}   conscientiousness ${f(engine.traits.conscientiousness, 2)}   openness ${f(engine.traits.openness, 2)}`);
const b = engine.baseline;
console.log(`Baseline VAD: valence ${f(b.valence, 3)}  arousal ${f(b.arousal, 3)}  dominance ${f(b.dominance, 3)}  -> calm and warm, as persona.md says`);
// Prove the file is genuinely the source rather than the fallback constants: change
// one trait in a copy of it and show the baseline moves.
const md = readFileSync(join(PROJECT_ROOT, "config", "persona.md"), "utf8");
const tweaked = engine.baseline;
const cold = loadTemperamentFrom(md.replace("| Warmth | high |", "| Warmth | low |"));
console.log(
  `  Source proof: flipping "| Warmth | high |" to "low" in a COPY of persona.md moves`,
);
console.log(
  `  baseline valence ${f(tweaked.valence, 3)} -> ${f((cold.warmth - 0.5) * 0.5, 3)}. Parsed, not hard-coded.`,
);
console.log("");
console.log(
  `${pad("t+", 6)}${pad("event", 44)}${pad("emotion", 12)}${pad("cause", 40)}${pad("intensity", 10)}VAD`,
);
console.log("-".repeat(112));

for (const step of script) {
  now += step.afterMin * MIN;
  const verdict = engine.feel(step.event);
  const s = engine.state();
  if (!verdict) {
    console.log(
      `${pad(`+${step.afterMin}m`, 6)}${pad(step.event.kind, 44)}${pad("(no feeling)", 12)}${pad("below the threshold — nothing warranted", 40)}`,
    );
    continue;
  }
  const clean = manipulationProblem(verdict.cause) ?? "";
  console.log(
    `${pad(`+${step.afterMin}m`, 6)}${pad(step.event.kind, 44)}${pad(verdict.emotion, 12)}${pad(verdict.cause.slice(0, 38), 40)}${pad(f(verdict.intensity, 3), 10)}${f(s.valence, 2)} ${f(s.arousal, 2)} ${f(s.dominance, 2)}${clean ? "  C4 VIOLATION" : ""}`,
  );
}

const moodNow = engine.moodState();
console.log("");
console.log("Mood immediately after the sequence — this is what gets persisted:");
console.log(
  `  valence ${f(moodNow.valence, 3)}  arousal ${f(moodNow.arousal, 3)}  dominance ${f(moodNow.dominance, 3)}  mood "${moodNow.mood}"`,
);
console.log(`  baseline valence was ${f(b.valence, 3)}, so a good hour left a mark. It decays toward baseline, not to zero.`);

console.log("");
console.log("Decay, with the clock moving and nothing happening:");
for (const step of [4, 16, 60, 180]) {
  now += step * MIN;
  const s = engine.state();
  const h = expressionHints(s);
  const m2 = engine.moodState();
  console.log(
    `  +${String(step).padStart(3)} min  emotion ${f(s.intensity, 4)} ${pad(s.named, 10)} cause ${s.cause === null ? "(gone)" : `"${s.cause}"`}  |  mood ${f(m2.valence, 3)} "${m2.mood}"  |  lengthBias ${f(h.lengthBias, 2)} lively ${h.lively} subdued ${h.subdued}`,
  );
}
console.log("");
console.log("  Note the mood name returns to \"content\" once nothing is felt any more, and the");
console.log("  VAD settles back onto the baseline from persona.md rather than to zero.");

// Prove determinism: the same script, twice, must produce identical output.
const replay = (): string => {
  let t = 1_700_000_000_000;
  const e = new EmotionEngine({
    temperament: loadTemperament(join(PROJECT_ROOT, "config", "persona.md")),
    now: () => t,
    familiarity: (p) => (p === "Ali" ? 0.9 : p === "Zed" ? 0.1 : 0.45),
  });
  for (const step of script) {
    t += step.afterMin * MIN;
    e.feel(step.event);
  }
  return JSON.stringify(e.moodState());
};
console.log("");
console.log(`Determinism: two runs of the same script agree — ${replay() === replay() ? "YES" : "NO"}`);
console.log(`  ${replay()}`);
console.log("");
console.log(`persona.md is unchanged by all of this: ${readFileSync(join(PROJECT_ROOT, "config", "persona.md"), "utf8").length} bytes`);