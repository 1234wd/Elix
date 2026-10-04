/**
 * C3 — typing realism.
 *
 * The rate is the assertion that matters. "At most 1 typo in 15 messages" is only
 * checkable because the randomness is seedable, so these tests use seeds rather
 * than counting on luck.
 */
import { describe, expect, it } from "vitest";
import {
  ADJACENT,
  FIX_RATE,
  TYPO_RATE,
  applyTypingRealism,
  fixLine,
  makeTypo,
  newTypingState,
  seededRandom,
} from "../../src/social/typing.js";

/**
 * Is `wrong` exactly one keystroke away from `right`?
 *
 * Either one position differs (an adjacent-key swap), or one letter was inserted
 * (a double-tap). Comparing positions alone is not enough: "there" -> "tthere"
 * differs in two positions because everything shifted, yet only one key was hit.
 */
function oneKeystrokeApart(wrong: string, right: string): boolean {
  if (wrong.length === right.length) {
    return [...wrong].filter((c, i) => right[i] !== c).length === 1;
  }
  if (wrong.length !== right.length + 1) return false;
  for (let i = 0; i < wrong.length; i++) {
    if (wrong.slice(0, i) + wrong.slice(i + 1) === right) return true;
  }
  return false;
}

/** The two typo forms, split by which one was used. */
const SAMPLE = [
  "that build looks really nice",
  "i found a whole cave full of diamonds",
  "do you want to come to my base",
  "the nether portal is finally lit",
  "im pretty sure its behind the hill",
  "someone left their horse by the wall",
  "that farm takes forever to harvest",
  "we should probably mine some more iron",
  "i finished the redstone circuit",
  "meet me at the spawn point soon",
];

/** How many of these messages got a typo. */
function typoCount(seed: number, messages = 300): number {
  const random = seededRandom(seed);
  let n = 0;
  for (let i = 0; i < messages; i++) {
    const text = SAMPLE[i % SAMPLE.length] as string;
    if (makeTypo(text, { random }).wrong !== "") n += 1;
  }
  return n;
}

describe("C3 — the typo rate is at most 1 in 15", () => {
  it("TYPO_RATE is 15, as specified", () => {
    expect(TYPO_RATE).toBe(15);
  });

  it("the aggregate rate is 1 in 15, across 40 seeds", () => {
    let total = 0;
    const counts: number[] = [];
    for (let seed = 1; seed <= 40; seed++) {
      const n = typoCount(seed, 600);
      counts.push(n);
      total += n;
    }
    // 24,000 messages, so ~1600 typos at 1 in 15.
    expect(total).toBeGreaterThan(1400);
    expect(total).toBeLessThan(1800);
    // And no individual seed is an outlier: at 1/15 the 99.99th percentile of 600
    // draws is still under 60. A wrong implementation lands well past that.
    for (let i = 0; i < counts.length; i++) {
      expect(counts[i], `seed ${i + 1} gave ${counts[i]} in 600`).toBeLessThan(60);
    }
  });

  it("is nowhere near the 1-in-2 a missing rate check would give", () => {
    let total = 0;
    for (let seed = 1; seed <= 40; seed++) total += typoCount(seed, 600);
    // 24,000 messages. Half of them typoed would be ~12,000.
    expect(total).toBeLessThan(2400);
  });

  it("actually produces typos — a rate of zero would pass the test above", () => {
    let total = 0;
    for (let seed = 1; seed <= 20; seed++) total += typoCount(seed, 600);
    expect(total).toBeGreaterThan(300);
    // Roughly 1 in 15 of 12,000 messages, so ~800.
    expect(total).toBeLessThan(1400);
  });

  it("is deterministic for a given seed", () => {
    expect(typoCount(7, 300)).toBe(typoCount(7, 300));
  });

  it("is seedable, so the rate is observable rather than lucky", () => {
    const always = () => 0;
    // With random() always below the rate, EVERY message gets a typo.
    expect(makeTypo("that build looks nice", { random: always }).wrong).not.toBe("");
    const never = () => 1;
    expect(makeTypo("that build looks nice", { random: never }).wrong).toBe("");
  });
});

describe("C3 — only two typo forms exist", () => {
  const forms = new Map<string, string>();
  for (let seed = 1; seed <= 60; seed++) {
    for (const text of SAMPLE) {
      const r = makeTypo(text, { random: seededRandom(seed) });
      if (r.wrong === "") continue;
      forms.set(r.wrong, r.right);
    }
  }

  it("produces a decent number of distinct misspellings", () => {
    expect(forms.size).toBeGreaterThan(15);
  });

  it("every typo is ONE keystroke from the word that existed", () => {
    for (const [wrong, right] of forms) {
      expect(
        oneKeystrokeApart(wrong, right),
        `"${right}" -> "${wrong}" is neither an adjacent-key swap nor a doubled letter`,
      ).toBe(true);
    }
  });

  it("NO typo is ever a no-op — the word really does change", () => {
    // This is the bug the doubled-letter insert had: slice(0, pos+2) +
    // slice(pos+2) is the original string, so "pretty" came back as "pretty" and
    // was still reported as a typo. 114 of 1200 attempts were phantom typos.
    expect(forms.size).toBeGreaterThan(0);
    for (const [wrong, right] of forms) {
      expect(wrong, `"${right}" was "misspelt" to itself`).not.toBe(right);
    }
  });

  it("the swap uses two ADJACENT keys, not arbitrary letters", () => {
    for (const [wrong, right] of forms) {
      if (wrong.length !== right.length) continue;
      const i = [...wrong].findIndex((c, k) => c !== right[k]);
      expect(i).toBeGreaterThanOrEqual(0);
      const from = (right[i] ?? "").toLowerCase();
      const to = (wrong[i] ?? "").toLowerCase();
      expect(ADJACENT[from] ?? [], `"${from}"->"${to}" is not adjacent`).toContain(to);
    }
  });

  it("the doubled-letter form is real", () => {
    const doubled = [...forms].filter(([w, r]) => w.length === r.length + 1);
    expect(doubled.length).toBeGreaterThan(0);
    for (const [wrong, right] of doubled) {
      expect(wrong.replace(/(.)\1/, "$1")).toBe(right);
    }
  });

  it("the adjacent-key swap form is real", () => {
    const swaps = [...forms].filter(([w, r]) => w.length === r.length);
    expect(swaps.length).toBeGreaterThan(0);
    for (const [wrong, right] of swaps) {
      // Exactly one position differs.
      const diffs = [...wrong].filter((c, i) => c !== right[i]).length;
      expect(diffs, `"${right}" -> "${wrong}"`).toBe(1);
    }
  });
});

describe("C3 — a typo NEVER lands somewhere it would read as a bug", () => {
  it("never in a number, even though the rest of the line is fair game", () => {
    const CASES: ReadonlyArray<readonly [string, string[]]> = [
      ["i mined 3 logs just now", ["3"]],
      ["i have 142 diamonds total", ["142"]],
      ["that took 27 minutes", ["27"]],
      ["i went from 15 to 32 blocks", ["15", "32"]],
      ["craft 64 planks and 6 sticks please", ["64", "6"]],
    ];
    let typoes = 0;
    for (let seed = 1; seed <= 80; seed++) {
      for (const [text, numbers] of CASES) {
        const r = makeTypo(text, { random: seededRandom(seed), rate: 1 });
        if (r.wrong === "") continue;
        typoes++;
        // rate 1 means every message is a candidate, so a real typo landing in a
        // safe word is expected — the digits must survive it untouched.
        for (const n of numbers) expect(r.text, `"${text}" lost ${n}`).toContain(n);
      }
    }
    // Proves the protection is being exercised rather than dodged.
    expect(typoes).toBeGreaterThan(200);
  });

  it("never in coordinates", () => {
    for (let seed = 1; seed <= 80; seed++) {
      for (const text of [
        "meet me at x: 142 y: 64 z: -233",
        "my base is at x=1200 y=70 z=340",
        "come to 145 64 -233 please",
      ]) {
        // A coordinate token is entirely digits, so the word filter alone already
        // excludes it; this asserts the digits are intact whatever else happens.
        const r = makeTypo(text, { random: seededRandom(seed), rate: 1 });
        for (const n of ["142", "64", "-233", "1200", "70", "340", "145"]) {
          if (text.includes(n)) expect(r.text, `"${text}" lost ${n}`).toContain(n);
        }
      }
    }
  });

  it("never in a player mention", () => {
    for (let seed = 1; seed <= 80; seed++) {
      const MENTIONS: ReadonlyArray<readonly [string, string]> = [
        ["hey @Steve come here", "Steve"],
        ["ping @Notch and @jeb_", "Notch"],
        ["tell @Herobrine he is late", "Herobrine"],
      ];
      for (const [text, name] of MENTIONS) {
        const r = makeTypo(text, { random: seededRandom(seed), rate: 1 });
        if (r.wrong === "") continue;
        // The name must be byte-identical, and the typo landed elsewhere.
        expect(r.text, `"${text}" -> "${r.text}" mangled the name`).toContain("@" + name);
      }
    }
  });

  it("never in short words, where a typo is not a slip but a different word", () => {
    for (let seed = 1; seed <= 60; seed++) {
      // Every word here is three letters or fewer. A swap turns "one" into "ope",
      // which reads as a different word rather than as a mistype.
      for (const text of [
        "yes no ok",
        "go up now",
        "me you it",
        "a in on at to",
        "is it my by ok no",
        "he be do so if",
      ]) {
        expect(makeTypo(text, { random: seededRandom(seed), rate: 1 }).wrong, text).toBe("");
      }
    }
  });

  it("BUT an ordinary five-letter word IS fair game — that is the intended effect", () => {
    // The case the previous test accidentally forbade. "there" is a normal word,
    // and "rhere" is exactly the kind of slip that reads as human.
    let seen = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const r = makeTypo("hi there man", { random: seededRandom(seed), rate: 1 });
      if (r.wrong === "") continue;
      seen++;
      // The only word that changed is "there", and it changed by one keystroke.
      expect(r.right).toBe("there");
      expect(oneKeystrokeApart(r.wrong, r.right), `"there" -> "${r.wrong}"`).toBe(true);
    }
    expect(seen).toBeGreaterThan(40);
  });

  it("never changes a URL, a markdown char, or a bracket", () => {
    for (let seed = 1; seed <= 80; seed++) {
      // A token that is ENTIRELY protected comes back untouched, because there is
      // no eligible word left in the line.
      for (const text of [
        "see https://elix.example.com/docs",
        "[clickable]",
        "{braced}",
        "use *stars*",
      ]) {
        expect(makeTypo(text, { random: seededRandom(seed), rate: 1 }).wrong, text).toBe("");
      }
      // Beside a protected token, an ordinary neighbour is still fair game, and
      // the protected token must come through byte-identical.
      for (const [text, token] of [
        ["[clickable] here", "[clickable]"],
        ["{braced} there", "{braced}"],
        ["use *stars* here", "*stars*"],
      ] as const) {
        const r = makeTypo(text, { random: seededRandom(seed), rate: 1 });
        if (r.wrong === "") continue;
        expect(r.text, `"${text}" -> "${r.text}" mangled ${token}`).toContain(token);
      }
      // And a URL in a sentence survives even when the sentence is typoed.
      for (const text of ["read https://elix.example.com/docs now", "try https://elix.example.com/guide"]) {
        const r = makeTypo(text, { random: seededRandom(seed), rate: 1 });
        if (r.wrong === "") continue;
        expect(r.text, text).toContain("https://elix.example.com/");
      }
    }
  });

  it("never alters a number even in a long line that also has safe words", () => {
    for (let seed = 1; seed <= 80; seed++) {
      const text = "i crafted 16 sticks and 4 planks yesterday afternoon";
      const r = makeTypo(text, { random: seededRandom(seed), rate: 1 });
      if (r.wrong === "") continue;
      // The digits must survive untouched wherever the typo landed.
      for (const n of ["16", "4"]) expect(r.text).toContain(n);
    }
  });
});

describe("C3 — the *fix follow-up", () => {
  it("is a single word, which is how people correct a typo in chat", () => {
    expect(fixLine("mining")).toBe("*mining");
  });

  it("WHEN a fix is offered, it restores the word EXACTLY", () => {
    let checked = 0;
    for (let seed = 1; seed <= 120; seed++) {
      for (const text of SAMPLE) {
        const fixed = applyTypingRealism(text, newTypingState(), {
          random: seededRandom(seed),
          rate: 1,
        });
        if (!fixed.typoed || fixed.followUp === null) continue;
        checked++;
        // This is the property the first implementation got wrong: it tried to
        // reconstruct the correction by un-doubling letters, which cannot undo a
        // swap at all, so "*mining" came back as "*minning".
        const corrected = fixed.followUp.slice(1);
        const original = text.split(" ");
        const typoed = fixed.text.split(" ");
        const idx = typoed.findIndex((w, i) => w !== original[i]);
        expect(fixed.text, `${text} -> ${fixed.text}`).not.toBe(text);
        expect(idx, `${text} -> ${fixed.text}`).toBeGreaterThanOrEqual(0);
        // Exactly ONE word differs — one slip, not a mangled sentence.
        expect(typoed.filter((w, i) => w !== original[i])).toHaveLength(1);
        // And the follow-up names precisely the word that was misspelt.
        expect(corrected).toBe(original[idx]);
        const repaired = [...typoed];
        repaired[idx] = original[idx]!;
        expect(repaired.join(" ")).toBe(text);
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it("the fix line is one word and starts with an asterisk", () => {
    for (let seed = 1; seed <= 120; seed++) {
      for (const text of SAMPLE) {
        const fixed = applyTypingRealism(text, newTypingState(), {
          random: seededRandom(seed),
          rate: 1,
        });
        if (fixed.followUp === null) continue;
        expect(fixed.followUp.startsWith("*")).toBe(true);
        // Exactly one word after the asterisk.
        expect(fixed.followUp.slice(1).split(" ")).toHaveLength(1);
      }
    }
  });

  it("happens roughly a third of the time", () => {
    expect(FIX_RATE).toBeGreaterThan(0);
    expect(FIX_RATE).toBeLessThan(0.5);
    let withFix = 0;
    let total = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const r = applyTypingRealism("that build looks really nice", newTypingState(), {
        random: seededRandom(seed),
        rate: 1,
      });
      if (!r.typoed) continue;
      total += 1;
      if (r.followUp) withFix += 1;
    }
    expect(total).toBeGreaterThan(150);
    expect(withFix / total).toBeGreaterThan(0.15);
    expect(withFix / total).toBeLessThan(0.55);
  });

  it("is null when no typo was made — there is nothing to fix", () => {
    const r = applyTypingRealism("that build looks really nice", newTypingState(), {
      random: () => 1,
    });
    expect(r.typoed).toBe(false);
    expect(r.followUp).toBeNull();
    expect(r.text).toBe("that build looks really nice");
  });
});

describe("C3 — the rate is held across messages, not per call", () => {
  it("counts every message it is shown", () => {
    const state = newTypingState();
    for (let i = 0; i < 20; i++) applyTypingRealism("a nice build there", state, { random: () => 1 });
    expect(state.seen).toBe(20);
  });

  it("the state is session state, never persisted", () => {
    // A fresh session starts clean, so the first message is back to 1-in-15.
    const state = newTypingState();
    expect(state.seen).toBe(0);
    expect(newTypingState().seen).toBe(0);
  });
});

describe("C3 — an empty or unusable line is left completely alone", () => {
  it.each(["", "   ", "1 2 3", "ok", "!!!", "x: 1 y: 2 z: 3"])("leaves %j untouched", (text) => {
    for (let seed = 1; seed <= 30; seed++) {
      const r = makeTypo(text, { random: seededRandom(seed), rate: 1 });
      expect(r.text, JSON.stringify(text)).toBe(text);
      expect(r.wrong).toBe("");
    }
  });
});