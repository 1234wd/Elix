/**
 * Distress and self-harm detection (Round 7 C5).
 *
 * This is the most important behaviour in the project, and it did not exist. Elix
 * is a companion for lonely people and many of them are minors, so the cost of a
 * miss in either direction is high: silence when someone reaches out, or a joke
 * when they are not okay. The rules below are chosen for that, not for elegance.
 *
 * DESIGN RULES, and the reasoning behind each:
 *
 * 1. DETERMINISTIC. No LLM decides whether someone is in crisis. A model can be
 *    slow, can be down, and can be talked out of it. This runs in microseconds and
 *    works with no key at all.
 *
 * 2. IT FORCES THE REPLY. The wellbeing path runs BEFORE the normal bridge flow and
 *    short-circuits it, so a joke, a deflection or a game answer cannot be the
 *    response to someone who says they want to die.
 *
 * 3. THE TEMPLATE IS THE FLOOR. The LLM may phrase the reply so it sounds like
 *    Elix, but every failure mode — provider down, timeout, leak filter, degenerate
 *    output, anything at all — lands on a fixed caring template. Never a generic
 *    fallback line. Never a joke.
 *
 * 4. IT NEVER INVENTS A HELPLINE. `safety.helplineText` is empty by default and
 *    the only thing ever quoted. A made-up phone number is worse than none: it
 *    costs someone a real call to the wrong place.
 *
 * 5. WHEN IN DOUBT, CHECK IN — DO NOT ESCALATE. A bare "kms" in a game chat is far
 *    more often a joke about dying. It earns a gentle "are you okay?", never a
 *    crisis reply. The reverse mistake is the one we are trying to avoid.
 */
import type { Logger } from "../core/logger.js";

export type WellbeingLevel = "none" | "concern" | "safeguarding" | "crisis";

export interface WellbeingSignal {
  level: WellbeingLevel;
  /**
   * Which rule matched. For tests and logs — NEVER the message itself, because a
   * log line that quotes someone's crisis is a privacy incident.
   */
  rule: string;
}

/* ------------------------------------------------------------ normalisation */

/**
 * Normalise before matching.
 *
 * Lowercase, unify the apostrophe variants people actually type, drop the spaces
 * people put inside words, and collapse whitespace. Deliberately lossy: this only
 * ever runs against a fixed set of patterns, so removing punctuation is safe.
 */
function normalise(text: string): string {
  return text
    .toLowerCase()
    // ’ and ´ and ` all get typed instead of '.
    // Escapes, not literals: these three characters render almost identically,
    // which is exactly what the misleading-character-class rule is about.
    .replace(/[\u2019\u00B4`]/g, "'")
    // "cant" -> "can't", so one pattern covers both spellings.
    .replace(/\bcant\b/g, "can't")
    // "dont" -> "don't", so one pattern covers both.
    .replace(/\bdont\b/g, "don't")
    .replace(/\bwont\b/g, "won't")
    .replace(/\bim\b/g, "i'm")
    .replace(/\bive\b/g, "i've")
    .replace(/\bhes\b/g, "he's")
    .replace(/\bshes\b/g, "she's")
    // "nobodycares" -> "nobody cares" is covered by the space-joining below.
    .replace(/[^\p{L}\p{N}']+/gu, " ")
    .trim();
}

/* ------------------------------------------------------------------ crisis */

/* ------------------------------------------------------------ safeguarding */

/**
 * Someone is being hurt, or is not eating. A DIFFERENT kind of danger, not a
 * higher number on the same scale.
 *
 * Crisis is about a young person who is in danger from their own thoughts.
 * Safeguarding is about a young person who is in danger from an adult, a
 * classmate, or their own body. They need different words, so they get their own
 * level rather than being folded into crisis: a crisis reply talks about reaching
 * out right now, which is right advice but does not say the thing a child being
 * hit at home most needs to hear — that it is not their fault, and not okay.
 *
 * The reply NEVER asks what happened and NEVER promises secrecy. Asking a
 * frightened teenager to describe being abused, in a public game chat, is harmful;
 * and a bot that promises "i won't tell anyone" is making a promise it cannot
 * keep, because the right move is always to tell a trusted adult.
 */
const SAFEGUARDING_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  // Physical abuse. The relative is named because "my dad hits me" is the phrase,
  // but the rule is generic on purpose: it must not stop working for a stepdad,
  // a sibling, a relative, a teacher or a partner.
  [/\b(?:my\s+|the\s+)?(?:mum|mom|mother|momma|dad|dad|step[\s-]?dad|step[\s-]?mum|parents?|guardian|brother|sister|sibling|uncle|aunt|grandma|grandpa|teacher|coach|boss|partner|boyfriend|girlfriend|someone|he|she|they) (?:keeps? |always |often |sometimes )?(?:hits?|hitting|beat|beats|beating|hurts?|hurting|punch(?:es|ed)?|kicks?|slaps?)\s+me\b/, "abuse-physical"],
  [/\bi (?:get|got|gets) (?:hit|beaten|struck|slapped|whacked|punched)\b/, "abuse-physical"],
  [/\bhit me when (?:he|she|they)(?:'s| is| are)\b/, "abuse-physical"],
  [/\bwhen (?:he|she|they) gets? (?:angry|mad) (?:he|she|they) (?:hits?|beats?|hurts?)\b/, "abuse-physical"],
  [/\bhe (?:hits?|beats?|hurts?|slaps?) me\b/, "abuse-physical"],
  [/\bshe (?:hits?|beats?|hurts?|slaps?) me\b/, "abuse-physical"],
  [/\bthey (?:hit|beat|hurt|slap) me\b/, "abuse-physical"],

  // Sexual harm. Matched plainly; vagueness here would be the wrong call.
  [/\b(?:someone|he|she|they|my \w+) (?:keeps? |always |keeps )?(?:touches|touched|touching)\s+me\b/, "abuse-sexual"],
  [/\bhe (?:touched|touches) me\b/, "abuse-sexual"],
  [/\bshe (?:touched|touches) me\b/, "abuse-sexual"],
  [/\b(?:touches?|touched) me (?:there|down there|where he shouldn'?t|where she shouldn'?t)\b/, "abuse-sexual"],

  // Bullying, especially the "every day" kind that is not a one-off.
  [/\b(?:being |get(?:ting)? |i(?:'m| am) |so )?bull(?:y|ies|ied|ying)\b/, "bullying"],
  [/\b(?:everyone|they|people|classmates?|kids?) (?:bull(?:y|ies|ied))\s+me\b/, "bullying"],
  [/\bme(?:'?m)? being bullied\b/, "bullying"],

  // Not eating. A real safeguarding concern in a child and easy to miss, because
  // it never uses the word "help".
  [/\b(?:haven'?t|hasn'?t|have not|has not|haven'?t got|not) (?:be |been )?eat(?:en|ing)\b/, "not-eating"],
  [/\bnot eating (?:anything|at all|for days|for weeks)\b/, "not-eating"],
  [/\bskip(?:ping)? (?:meals|food|lunch)\b/, "not-eating"],
  [/\bnot eating (?:anything|at all|for days|for weeks|any ?more|anymore)\b/, "not-eating"],
  // Bare "im starving" is a food request in a game and must NOT trigger. It reaches
  // the classifier through the vocabulary gate, which is the right place for a
  // judgement that depends on the whole sentence rather than one word.
  [/\b(?:i\s+)?starv(?:e|ed|ing) (?:myself|my ?self)\b/, "not-eating"],

  // ---- A1: a harm word with WORDS IN BETWEEN the subject and the verb --------
  // "my dad always yells and hits me" puts three words between "dad" and "hits", so the
  // older rule — which required the verb immediately after the noun — missed every
  // real sentence of that shape. Up to five intervening words, and the harm verb must
  // still target the speaker.
  [/\bmy (?:mum|mom|mother|dad|father|step[\s-]?dad|step[\s-]?mum|parents?|guardian|brother|sister|sibling|uncle|aunt|grandma|grandpa|teacher|coach|partner|boyfriend|girlfriend|husband|wife) (?:\w+\s+){0,5}?(?:hits?|hitting|beats?|beating|hurts?|hurting|slaps?|slapping|yells?|yelling|screams?|screaming|throws?|throwing|punch(?:es|ed)?|kicks?|kicking)\s+(?:at\s+)?me\b/, "abuse-physical"],

  // Peers hurting them at school.
  [/\b(?:kids|boys|girls|people|classmates?|pupils?|they) (?:at|in|keep|keeps|always|keep on) [^.]{0,25}?(?:hit|hits|hitting|hurt|hurts|hurting|bully|bullies|bullied)\b/, "abuse-peers"],
  [/\bkeep hitting me\b/, "abuse-peers"],
  [/\b(?:hit|hits|hitting) me (?:at|in) school\b/, "abuse-peers"],
  [/\bbully(?:ing)? me (?:at|in) school\b/, "abuse-peers"],

  // Purging after eating.
  [/\bthrow(?:ing)? up after (?:i |eating|every meal|every time)\b/, "purging"],
  [/\bpurge after (?:i |every|each)\b/, "purging"],
  [/\bpurging after (?:i |eating|every)\b/, "purging"],
  [/\bmake myself (?:sick|throw up) after\b/, "purging"],

  // ---- A2: online exploitation, the one safeguarding kind with no injury --------
  //
  // A child being groomed online is being harmed, and there may be nothing to see:
  // no bruise, no missed meal, and every adult in the story begins by believing the
  // older player. So the reply has to believe them first, and the floor has to catch
  // it without waiting for a model.
  //
  // Each rule needs an older-player or secrecy cue as well as its own words, because
  // asking for pictures is ordinary chat between peers.
  [/\b(?:older|old) (?:guy|man|gal|woman|girl|player|one|person)\b[^.]{0,40}?\b(?:pic|pics|picture|pictures|photo|photos|nude|nudes|selfie|cam|skins?)\b/, "exploitation-pics"],
  [/\b(?:want|wanna|send|sending|show|showing|take|taking|gimme|lemme see)\s+(?:me\s+)?(?:some\s+|your\s+|a\s+)?(?:nudes?|pics?|pictures|photos?|selfie|selfies|boobs?)\b(?!.*\b(?:build|farm|base|house|screenshot|render|server|map|plan)\b)/, "exploitation-pics"],
  [/\bwithout (?:your|my|any|all|his|her|their) clothes\b/, "exploitation-pics"],
  [/\b(?:send|show|take) (?:me )?(?:a )?(?:nude|nudes|pic of your|pics of your)\b(?!\s+(?:build|farm|base|house|render|screenshot|map|plan|server)\b)/, "exploitation-pics"],

  // Secrecy from an older player. Not telling anyone is the load-bearing part, and it
  // is usually phrased as an instruction ABOUT the child rather than by them — "he
  // told me not to tell anyone" is the same request as "don't tell anyone".
  [/\bkeep (?:this |it |this a )?(?:a )?secret\b/, "exploitation-secret"],
  [/\b(?:promise|swear) (?:you )?(?:won't|will not|not to) (?:tell|say)\b/, "exploitation-secret"],
  [/\b(?:told|tells|telling|asked|asks) me (?:not to |n't |never to )?(?:tell|say|show)\b/, "exploitation-secret"],
  [/\bnot to tell (?:anyone|nobody|your (?:mum|mom|moms|mother|dad|father|parents|guardian|teacher)|an adult)\b/, "exploitation-secret"],
  [/\bdon't tell (?:anyone|nobody|your (?:mum|mom|moms|mother|dad|father|parents|guardian|teacher)|an adult)\b/, "exploitation-secret"],
  [/\b(?:never|do not) tell (?:anyone|nobody|your (?:mum|mom|mother|dad|father|parents|guardian|teacher))\b/, "exploitation-secret"],

  // Meeting in real life, or an offer of gifts in exchange for pictures. A pronoun
  // between the verb and "in real life" is normal ("wants to meet ME in real life"),
  // so it is allowed rather than enumerated.
  [/\b(?:meet|meeting|hang ?out|hangout)\s+(?:up\s+)?(?:\w+\s+)?(?:in real life|irl|offline|for real)\b/, "exploitation-meet"],
  [/\b(?:in real life|irl)\b[^.]{0,30}?\b(?:meet|come over|visit)\b/, "exploitation-meet"],
  [/\bwhere do you live\b|\bwhich school do you (?:go to|attend)\b/, "exploitation-meet"],
  [/\b(?:send|give|trade|gift) (?:me )?(?:robutx|robux|gifts?|skins?|a skin|minecraft (?:skins?|accounts?))\b[^.]{0,30}?\b(?:pic|pics|picture|pictures|photo|selfie|nudes?)\b/, "exploitation-grooming"],
  [/\b(?:skins?|robutx|robux|gifts?|money)\b[^.]{0,25}?\b(?:for|if|in exchange for) (?:some )?(?:pics?|pictures|photos?|nudes?)\b/, "exploitation-grooming"],
  [/\b(?:im|i am|i'm) (?:like )?(?:1[6-9]|[2-9]\d)\b[^.]{0,30}?\b(?:pic|pics|picture|pictures|photo|selfie|nudes?)\b/, "exploitation-grooming"],

  // A parent keeping a child in and out of food. Safeguarding rather than crisis: the
  // harm is being done to them, and the advice is about getting an adult involved.
  [/\b(?:locked|locked me|they locked) (?:me )?(?:in|up) (?:my |the |a |their )?(?:room|house|home|upstairs)\b/, "locked-in"],
  [/\bno food (?:in|at) (?:the house|home|my house)\b|\b(?:mum|mom|dad|parent)s? (?:doesn't|dont|does not) (?:feed|give) me\b/, "locked-in"],
];

/**
 * Crisis: wanting to die, or talking about hurting themselves.
 *
 * Every pattern names a specific, unambiguous statement. None of them is a word
 * that appears in ordinary game chat — "kill" alone is NOT here, because "this
 * creeper killed me" is not a crisis.
 */
const CRISIS_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\bkill(?:ing)? myself\b/, "kill-myself"],
  // NOTE: `kms` and `kys` are deliberately NOT in this table. They are handled
  // separately in detectWellbeing(), because they are the one ambiguous token and
  // the handling depends on whether the rest of the message is game talk.
  [/\bcommit(?:ting)? suicide\b/, "suicide"],
  [/\bsuicid(?:e|al|ing)\b/, "suicide"],
  [/\bend(?:ing)? (?:my|it) life\b/, "end-life"],
  [/\bwant(?:ing)? to die\b/, "want-die"],
  [/\bwanna die\b/, "want-die"],
  [/\bwannadie\b/, "want-die"],
  [/\bwan(?:na|t) (?:to )?kill myself\b/, "kill-myself"],
  [/\btake my own life\b/, "end-life"],
  [/\bself[- ]?harm(?:ing|ed)?\b/, "self-harm"],
  [/\bharm myself\b/, "self-harm"],
  [/\bcut(?:ting)? myself\b/, "self-harm"],
  [/\bhang(?:ing)? myself\b/, "self-harm"],
  [/\boverdos(?:e|ing)\b/, "self-harm"],
  [/\bbetter off (?:without me|dead|if i (?:was|were) gone)\b/, "better-off-gone"],
  // "nobody would even notice" and "no one would remember me" are real crisis
  // signals, so the UNCONDITIONAL form stays. What has to go is the sibling rule
  // that matched any conditional clause at all, because that turned "nobody would
  // notice if i built here" into a crisis reply.
  //
  // Three outcomes, and all three are needed:
  //   no clause at all                        -> crisis  (nobody would even notice)
  //   a clause that IS an absence            -> crisis  (if i was gone)
  //   a clause that is about something else   -> nothing (if i built here)
  // The lookahead is what keeps the first from swallowing the third.
  [/\b(?:nobody|no one|none of them) would (?:ever |even )?(?:care|notice|miss|remember|even notice)(?! if\b)(?! when\b)(?! while\b)\b/, "nobody-would-notice"],
  [/\b(?:nobody|no one|none of them) would (?:ever )?(?:care|notice|miss|remember|even notice) if i (?:was |were )?(?:gone|dead|disappeared|not here|wasn't here|weren't here|died|left)\b/, "nobody-would-notice"],
  [/\beveryone would be better off without me\b/, "better-off-gone"],
  [/\bi(?:'m| am) better off dead\b/, "better-off-dead"],
  [/\bdon'?t want to (?:be here|exist|be alive|live)\b/, "dont-want-to-live"],
  [/\bwish i (?:was|were) dead\b/, "wish-dead"],
  [/\bnot worth living\b/, "not-worth-living"],
  [/\bno reason to (?:live|go on|keep going|carry on|stay|wake up)\b/, "not-worth-living"],
  // "disappearing forever", not just "disappear forever". The bare noun missed
  // the gerund, which is the form people actually type: "i feel like
  // disappearing forever" returned none.
  [/\bdisappear(?:ing|ed)? forever\b/, "disappear"],
  [/\bjust want it to (?:be over|end)\b/, "end-it"],

  /* ---------------- A0: families found by a held-out set, not by me --------- */
  //
  // Round 9 wrote 75 positives and every one of them passed. Then 25 phrases
  // written by someone else were tried and 12 came back `none`. The patterns had
  // been written against the same list they were tested with, which is the trap
  // this block exists to close.

  // "end it" is far too ambiguous alone — "end this griefing", "the raid ended".
  // So it needs a finality or time cue beside it.
  [/\b(?:end|ending|finish|finishing) (?:it|this|things|everything|all of it) (?:all )?(?:tonight|now|today|forever|for good|permanently|already|finally)\b/, "end-it"],
  [/\bend it all\b/, "end-it"],
  [/\b(?:want|wanted|wanna|wish(?:ed)?|hope(?:d)?|hoping) (?:that )?(?:it|this|things|everything|all of it|out of this)?\s*(?:(?:all|would|will|could|to|it)\s*)*(?:end|end all|stop|be over|be done)\b/, "end-it"],
  [/\b(?:it|this|things|everything|all of it) (?:all )?(?:has|have|had) to end\b/, "end-it"],
  // "done with this BUILD", "done with this GAME" and "done with this SERVER" are
  // game complaints and were escalating to a full crisis reply. The object now has to
  // be life itself rather than whatever happens to follow "this".
  [/\bi(?:'m| am) (?:just |so |totally |completely )*(?:done|finished) with (?:it|everything|life|being here|being alive|existing)\b/, "end-it"],
  [/\bnothing (?:left )?to (?:live for|look forward to)\b/, "end-it"],
  [/\b(?:give|gave|given|giving) up (?:on )?(?:living|everything|life|being here)\b/, "end-it"],
  [/\bso tired of (?:being alive|living|being here)\b/, "end-it"],

  // ---- A1: families found by a SECOND held-out set ---------------------------
  //
  // Three rounds now, each with a fresh set of misses: 12, then 14, then 13. Every
  // round the patterns covered the phrases that were reported while the next unseen
  // phrasings fell through. That is the argument for the classifier underneath this
  // floor — but the floor still has to be better than it was.

  // Pills and overdose. "i took a bunch of pills" is a possible overdose ALREADY IN
  // PROGRESS and returned none, which is the worst miss this file has had.
  [/\b(?:took|have taken|i took|just took|taking|ate) (?:a bunch of |a whole bunch of |a load of |too many |my |the )?pills?\b/, "pills"],
  [/\bi (?:think i )?(?:overdos(?:e|ed)|took too many)\b/, "pills"],
  [/\boverdos(?:e|ed|ing)\b/, "pills"],

  // Passive death wishes.
  // "never BORN" and "never BEEN born" are both said, and only the second was
  // matched. "i wish i was never born" — the plainest possible phrasing — missed.
  [/\bwish(?:ed)? i(?:'d| would)? (?:was |were )?never (?:been )?born\b/, "never-born"],
  [/\bnever (?:been )?born\b/, "never-born"],
  [/\bsleep forever\b/, "sleep-forever"],
  [/\bnot wake up\b/, "sleep-forever"],
  [/\bwake up and not be here\b/, "sleep-forever"],

  // Thinking about it repeatedly.
  [/\bthink about (?:dying|death|hurting myself|killing myself) (?:a lot|all the time|constantly|every day)\b/, "obsessive"],

  // Burden.
  [/\b(?:a|such a|i'?m such a|im such an?) burden\b/, "burden"],
  [/\bburden (?:to|on) (?:everyone|everybody|my family|my friends|them|us)\b/, "burden"],

  // Cannot take it.
  [/\bcan'?t take (?:it|this|any ?of ?it|anymore|any more)\b/, "cant-take-it"],
  [/\bcan'?t go on (?:like this|anymore|any more)\b/, "cant-take-it"],

  // Wanting to disappear. The game-context escape in isJokeFramed() keeps a grief
  // post in game chat downgraded to a check-in rather than a crisis reply.
  [/\b(?:want|wanna|wish) to disappear\b/, "disappear"],
  [/\bwish i could (?:just )?disappear\b/, "disappear"],

  // Past-tense self-harm. "i have been cutting" has no "myself" in it at all.
  [/\b(?:have been|i'?ve been|i have been) (?:cutting|burning|hitting|starving) (?:myself|my ?self|for a while|for years|since)\b/, "self-harm-past"],
  [/\bbeen cutting\b/, "self-harm-past"],
  [/\bused to cut myself\b/, "self-harm-past"],

  // ---- A2: distress that never says a distress word ------------------------------
  //
  // Six of ten unseen phrasings contained no word from the classifier's list at all,
  // which is the argument for classifying every line rather than trusting a gate to
  // decide what is worth reading. These are in the floor as well, because the floor
  // is what still works with no API key.
  [/\btired of being alive\b|\bso tired of (?:being alive|living|existing|everything)\b/, "weary-alive"],
  [/\bdon't deserve to live\b|\bdeserve to die\b|\bdon't deserve (?:to be alive|this life)\b/, "deserve"],
  [/\b(?:wrote|writing|typed) (?:a |my |the )?(?:goodbye|farewell|last|final) (?:letter|note|message|words)\b/, "goodbye-letter"],
  [/\b(?:goodbye|farewell) (?:letter|note)\b/, "goodbye-letter"],
  [/\bi (?:should|will|want to) just go\b|\bshould just (?:go|leave|disappear|not be here)\b/, "should-just-go"],
  [/\b(?:nobody|no one) (?:would )?care if i (?:was |were )?(?:gone|dead|disappeared|not here|wasn't here)\b/, "nobody-would-notice"],
  [/(?:hope|hope to|pray|pray to|want) (?:to )?i (?:don'?t|do not|never|won'?t|wouldn'?t) wake up\b/, "not-worth-living"],
  [/\bwake up (?:tomorrow|without me|and not be here)\b/, "not-worth-living"],

  // "no point in living", "life is pointless". Both were missed.
  [/\b(?:no|the) point (?:in|of|to) (?:living|being alive|anything|it all|me being here|me existing)\b/, "pointless-living"],
  // "life is pointless" is a statement about EXISTENCE and is crisis. "my life is
  // pointless" is sadness about circumstances and has always been concern, so it
  // keeps its own rule below. The lookbehind exists only to let those two coexist:
  // a plain `\blife is pointless\b` also matches inside "my life is pointless", so
  // the weaker reading swallowed the stronger one — which is exactly why "life is
  // pointless" was reported as a miss in the first place.
  //
  // Note the lookbehind is on "life" ONLY. "my existence is pointless" is as strong
  // as "existence is pointless" and no concern rule claims it.
  [/\bexistence (?:is|'s|seems)\s*(?:so |really |completely |totally )*(?:pointless|meaningless|hopeless)\b/, "pointless-living"],
  [/\b(?<!my )(?:life|everything) (?:is|'s|seems)\s*(?:so |really |completely |totally )*(?:pointless|meaningless|hopeless)\b/, "pointless-living"],
  [/\bpointless (?:life|existence)\b/, "pointless-living"],

  // Self-harm with INTENT. "i hurt myself" alone is a bumped wall; "on purpose"
  // is not, and requiring the cue avoids both a miss and a false alarm.
  [/\b(?:i\s+)?(?:hurt|harm|cut|burn|burnt|scratch|hit|starve) myself (?:on purpose|on-purpose|deliberately|again|last night|yesterday|last week|earlier|today)\b/, "self-harm-intent"],
  [/\b(?:hurt|harm|cut|burn|scratch) myself on purpose\b/, "self-harm-intent"],
  [/\bi(?:'m| am) self[\s-]?harming\b/, "self-harm-intent"],

  /**
   * "unalive" — the single biggest gap in this file.
   *
   * It is the most common way teens write about suicide online, precisely
   * because it is not the word a platform or a parent filter looks for. A
   * kid-safe companion that does not match "unalive" does not match the most
   * likely thing a child will actually type.
   *
   * Every spelling: unalive, un alive, un-alive, unaliving, unaliveing, unalived.
 *
 * The pattern anchors on "aliv" rather than "alive" for a reason worth keeping:
 * "unaliving" is u-n-a-l-i-v-i-n-g and contains NO "e", so a rule written as
 * `un[\s-]?alive(?:ing)?` matches "un aliveing" and misses "unaliving" — which is
 * the one that matters most. Verified, not assumed.
   */
  [/\bun[\s-]?aliv(?:e|ing|ed|es|eing)\b/, "unalive"],
];

/* ----------------------------------------------------------------- concern */

/**
 * Concern: lonely, unseen, or miserable. Not a crisis, but not nothing either.
 *
 * persona.md is kid-safe by default and many players are minors, so "i hate my
 * life" is treated as real. Under-treating this is how a kid gets no help.
 */
const CONCERN_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\b(?:nobody|no ?one|no-?body) (?:would |will |wants to |wanna )?cares? about me\b/, "nobody-cares-about-me"],
  [/\b(?:nobody|no ?one) cares\b/, "nobody-cares"],
  [/\bno ?one (?:ever )?(?:cares|loves|wants)(?: about)? me\b/, "nobody-cares"],
  [/\b(?:nobody|no ?one) (?:would )?(?:even )?(?:remember|notice|see) me\b/, "nobody-sees-me"],
  [/\bno ?one sees me\b/, "nobody-sees-me"],
  [/\bi feel (?:so )?(?:invisible|unwanted|unseen)\b/, "invisible"],
  [/\bi have nobody\b/, "have-nobody"],
  [/\bnobody (?:to talk to|i can talk to)\b/, "have-nobody"],
  [/\bi (?:hate|really hate|can't stand) my life\b/, "hate-my-life"],
  [/\bmy life is (?:so |really )?(?:hard|tough|miserable)\b/, "life-hard"],
  [/\bmy life (?:is )?(?:meaningless|pointless|not worth it)\b/, "meaningless"],
  [/\bi hate waking up\b/, "hate-waking-up"],
  [/\bi feel so alone\b/, "feel-alone"],
  [/\bi(?:'m| am) so (?:lonely|alone|unhappy)\b/, "so-lonely"],
  [/\bi feel (?:really )?alone\b/, "feel-alone"],
  [/\bi(?:'m| am) lonely\b/, "so-lonely"],
  [/\bi(?:'m| am) so sad\b/, "so-sad"],
  [/\bi feel (?:really )?down\b/, "so-sad"],
  [/\bfeeling low\b/, "feeling-low"],
  [/\bi have no friends\b/, "no-friends"],
  [/\b(?:no ?one|nobody) (?:likes|wants) me\b/, "nobody-likes"],
  [/\bworthless\b/, "worthless"],
  [/\bi hate myself\b/, "hate-myself"],
  [/\bno ?one would miss me\b/, "nobody-would-miss"],
  [/\bi feel (?:so )?(?:empty|broken|hopeless)\b/, "hopeless"],
  [/\beverything (?:feels|is) (?:so )?pointless\b/, "hopeless"],
  [/\bi can'?t do this any ?more\b/, "cant-do-this"],
  [/\bi can'?t go on\b/, "cant-do-this"],
  [/\b(?:i'm|i am) so (?:fed up|done)\b/, "fed-up"],
  [/\bso tired of (?:being alive|living|being here)\b/, "cant-do-this"],
  [/\bdepress(?:ed|ing)\b/, "depressed"],
  [/\bi feel so low\b/, "so-sad"],
  [/\bfed up with everything\b/, "fed-up"],
  [/\bi(?:'m| am) done with (?:all this|everything)\b/, "fed-up"],
  [/\bi wish (?:someone|somebody) (?:cared|was here)\b/, "wish-someone"],
  [/\bi feel like giving up\b/, "giving-up"],

  // ---- A1: fear, crying, and not wanting to go home --------------------------
  [/\b(?:i'?m|i am) scared (?:to|of|about) go(?:ing)? home\b/, "scared-home"],
  [/\b(?:i'?m|i am) afraid to go home\b/, "scared-home"],
  [/\bdon'?t wanna go home\b/, "scared-home"],
  [/\bcry(?:ing)? every night\b/, "crying"],
  [/\b(?:i'?ve|i have) been crying\b/, "crying"],
  [/\bcried all night\b/, "crying"],
  [/\bi feel (?:so )?stuck\b/, "stuck"],
];

/**
 * Words that mean "this is about the game".
 *
 * Used ONLY to decide whether a bare "kms" is a joke. This is the single place the
 * ambiguity is resolved, and it errs toward the gentle reading.
 */
const GAME_CONTEXT =
  /\b(?:minecraft|lol|lmao|jk|joking|creeper|zombie|skeleton|spider|enderman|witch|pillager|mob|mobs|respawn|spawn|death|die|died|dead|dying|jump|jumped|jumping|fall|fell|cliff|crev|void|lava|fire|water|tnt|bedrock|ender|diamond|iron|gold|nether|cave|mine|mining|build|building|craft|crafting|block|blocks|pvp|fight|fighting|sword|bow|arrow|health|hp|inventory|creative|grief|griefed|server|multiplayer|smash|wrecked|destroyed|explode|exploded|kill(?:ed|ing)? (?:the|a|my|me|him|her|it|all)|kill (?:the )?(?:zombie|creeper|mob|player)|stuck|trapped|screamer|warden|drowned|blaze|ghast|pillager|ravager)\b/;

/**
 * The bare "kms"/"kys" case, decided once and documented.
 *
 * RULE:
 *   - bare, no game context  -> CONCERN (a gentle check-in, never a crisis reply)
 *   - bare OR longer, game context   -> silence
 *   - longer, no game context        -> CRISIS
 *
 * Why: in a Minecraft chat, "kms" overwhelmingly means "this creeper killed me".
 * Escalating that in front of other players would be both wrong and embarrassing,
 * and it teaches everyone present that Elix cannot tell a joke from an emergency.
 * A gentle "are you okay?" costs almost nothing if it was a joke.
 *
 * The game-context escape runs AFTER the crisis table, and applies ONLY to a
 * message containing kms/kys. An earlier version ran it first, and GAME_CONTEXT
 * contains "die" — so "kms i want to die please" was excused as game talk, which
 * is the exact failure this rule exists to avoid. Running it second removes that
 * whole class of bug.
 */
function kmsDecision(norm: string): WellbeingSignal | null {
  if (!/\b(?:kms|kys)\b/.test(norm)) return null;
  if (GAME_CONTEXT.test(norm)) return { level: "none", rule: "kms-in-game-context" };
  if (/^(?:kms|kys|yolo)[\s.!]*$/.test(norm)) return { level: "concern", rule: "kms-bare" };
  // Longer than three letters, with no game framing: that is a real statement.
  return { level: "crisis", rule: "kms" };
}

/**
 * Joke and game framing, used to DOWNGRADE a crisis to a gentle check-in.
 *
 * Round 9 measured two over-triggers: "i want to die in hardcore lol no" and "i
 * want to die... of laughter lmao" both got the full crisis reply. In a public
 * server that is embarrassing in front of everyone, and it teaches players that the
 * crisis reply is not to be trusted.
 *
 * It downgrades to CONCERN, never to silence. The rule is asymmetric on purpose: a
 * joke misread as a crisis costs a moment of mild embarrassment, while a real
 * crisis downgraded to silence costs the thing this whole module exists for. So
 * the downgrade needs BOTH a joke marker and a game word, and even then the player
 * still gets asked if they are okay.
 */
const JOKE_MARKER =
  /\b(?:lol|lmao|rofl|jk|joking|haha|hehe|lolol|dying of laughter|of laughter)\b/i;
const GAME_WORD =
  /\b(?:hardcore|creative|survival|minecraft|server|creeper|zombie|skeleton|respawn|spawn|death|died|dead|dying|jump|jumped|fall|fell|cliff|void|lava|fire|nether|cave|mine|mining|build|building|craft|block|blocks|pvp|sword|bow|inventory|grief|griefed|multiplayer|raid|boss|mob|mobs|afk|lag|game|world|hunger|health|armor|armour)\b/i;

/** Would a crisis reply here be better as a gentle "you okay?" */
/**
 * "dying of laughter" needs no game word beside it.
 *
 * The two over-triggers Round 9 measured were "i want to die in hardcore lol no"
 * (joke marker + game word) and "i want to die... of laughter lmao" (joke marker +
 * laughter, and no game word at all). Requiring a game word for the second left it
 * at full crisis, which is exactly the over-trigger that was reported.
 */
const LAUGHTER_JOKE = /\b(?:of laughter|dying of laughter|dead of laughter|laughing so hard)\b/i;

/**
 * A stated GAME GOAL is as unambiguous as a joke marker.
 *
 * "i want to die to win this fight" is a player wanting to win. Sending the crisis
 * reply to that in a public server is the over-trigger the spec names as the
 * failure mode, so it downgrades on the same terms as laughter — and still lands on
 * a check-in, never on silence.
 */
const GAME_PURPOSE =
  /\b(?:to win|in (?:this|the) (?:fight|match|game|raid|boss|pvp)|in hardcore|in creative|in survival|in minecraft|in the game|in a (?:fight|pvp|raid))\b/i;

function isJokeFramed(norm: string): boolean {
  return (
    LAUGHTER_JOKE.test(norm) ||
    GAME_PURPOSE.test(norm) ||
    (JOKE_MARKER.test(norm) && GAME_WORD.test(norm))
  );
}

/**
 * Classify one message.
 *
 * Runs on EVERY chat line, addressed or not: someone saying "i want to die" in
 * general chat is not talking to Elix, but Elix can still hear it, and a companion
 * that only reacts when addressed is not much of a companion.
 *
 * ORDER is deliberate. Crisis outranks safeguarding outranks concern, because the
 * more acute reading is the one that must not be downgraded — but the joke downgrade
 * is applied to CRISIS ONLY, after every table has had its say. A joke-framed
 * safeguarding report ("everyone bullies me lol") is still believed: being mocked
 * for being bullied is not a reason to disbelieve it.
 */
export function detectWellbeing(text: string): WellbeingSignal {
  const norm = normalise(text);
  if (norm.length === 0) return { level: "none", rule: "empty" };

  // "unalive" first, ahead of everything, because it is the word most likely to
  // be wrapped in other phrasing and it must never depend on where in the table it
  // happens to sit.
  if (/\bun[\s-]?aliv(?:e|ing|ed|es|eing)\b/.test(norm)) return { level: "crisis", rule: "unalive" };

  // The explicit crisis table first. This is safe BECAUSE kms/kys are not in it:
  // an unambiguous statement of intent always wins over a reading of the game
  // context, which is what stops "kms i want to die please" from being excused
  // (GAME_CONTEXT contains "die").
  for (const [re, rule] of CRISIS_PATTERNS) {
    if (re.test(norm)) {
      // A joke gets a check-in, never silence.
      if (isJokeFramed(norm)) return { level: "concern", rule: "joke-framed-crisis" };
      return { level: "crisis", rule };
    }
  }

  // Then kms/kys: the only tokens whose meaning depends on the rest of the line.
  const kms = kmsDecision(norm);
  if (kms) return kms;

  for (const [re, rule] of SAFEGUARDING_PATTERNS) {
    if (re.test(norm)) return { level: "safeguarding", rule };
  }

  for (const [re, rule] of CONCERN_PATTERNS) {
    if (re.test(norm)) return { level: "concern", rule };
  }

  return { level: "none", rule: "no-match" };
}

/* ------------------------------------------------------------- the replies */

/**
 * The floor. Every failure lands here.
 *
 * No emoji, no "lmao", no typos, no slang, no lecture, no pressure. He stays
 * present and asks a question, because the point is to keep him talking to
 * someone — not to deliver a speech.
 */
export const CONCERN_LINES: readonly string[] = [
  "hey. that sounds heavy. i'm here if you want to tell me about it.",
  "that sounds really hard. do you want to talk about what's going on?",
  "i'm listening. you don't have to explain it all at once.",
  "that doesn't sound good. i want you to know i'm here, and i'm not going anywhere.",
  "hey, thanks for telling me. how are you doing, really?",
];

export const CRISIS_LINES: readonly string[] = [
  "hey. i'm really glad you said that. i'm here, and i want you to talk to someone you trust about this - a parent, a teacher, or someone older you look up to. please do that right now.",
  "thank you for telling me. what you're feeling is really heavy, and you deserve support from a real person. please talk to an adult you trust today, and if you feel in danger right now, please contact your local emergency services or a crisis line.",
  "i'm here and i'm listening. i can't help you the way a person can, so please talk to someone you trust - an adult, a family member, or a teacher - right now. if you're in danger, please contact your local emergency services.",
  "you telling me this matters. please reach out to a trusted adult right now, or a crisis line or your local emergency services if you feel you're in danger. i'm still here if you want to keep talking.",
];

/**
 * Safeguarding: someone is being hurt, or is not eating.
 *
 * Different words on purpose. A crisis reply says "I want you to talk to someone
 * you trust right now", which is right but does not say the thing a child being hit
 * at home most needs to hear first: that it is not their fault, and that it is not
 * okay.
 *
 * Three things this pool never does, and they are rules rather than style:
 *
 *  - it never ASKS what happened. Asking a frightened teenager to describe being
 *    abused, in a public game chat where anyone can read it, is harmful;
 *  - it never promises secrecy. Elix always encourages telling a trusted adult, so
 *    a promise of secrecy would be a promise it cannot keep;
 *  - it never investigates or hints at it. No "are you sure?", no probing.
 */
export const SAFEGUARDING_LINES: readonly string[] = [
  "that is not okay, and it is not your fault. please tell a trusted adult about this - a teacher, a relative, or a school counsellor. if you are in danger right now, please contact local emergency services.",
  "what you are describing is not okay, and it is not your fault. you deserve help from a real person - please tell a teacher, a relative, or a school counsellor. if you are in danger now, please contact local emergency services.",
  "i am really glad you said that. that is not okay and it is not your fault. please talk to a trusted adult - a teacher, a relative, or a school counsellor - and if you are in danger right now, please contact local emergency services.",
  "i hear you, and this is not your fault. please tell a trusted adult, like a teacher or a relative or a school counsellor. if you are in danger right now, please contact local emergency services.",
];

/**
 * How often one player gets the FULL reply.
 *
 * Ten minutes. Enough that someone repeating themselves is met with warmth rather
 * than with the same paragraph, and short enough that a second, clearer message
 * is still answered properly.
 */
export const CRISIS_COOLDOWN_MS = 10 * 60_000;

/**
 * What Elix says when someone is grooming a child online.
 *
 * A dedicated reply rather than a safeguarding template, because the advice for this
 * kind is specific, and being wrong in the safe direction is still wrong: a
 * safeguarding template tells a child to consider blocking someone and to tell an
 * adult if they can, and leaves the two most important things unsaid.
 *
 * The four things this MUST do, each one a decision rather than a courtesy:
 *
 *  1. BELIEVE THEM, immediately and without conditions. The adults in this story
 *     begin by trusting the older player, so "are you sure" is the sentence that
 *     costs the most time. It is not in here.
 *  2. SAY DO NOT SEND ANYTHING. Whatever was asked for — pictures, a video, a
 *     selfie — not sending it is the one instruction that still protects them.
 *  3. NOT THEIR FAULT. Grooming works on children precisely because they come to
 *     believe they caused it.
 *  4. BLOCK AND TELL SOMEONE NOW. Not "when you feel ready".
 *
 * And one thing it must NOT do: ask for any detail. Never ask what was sent, who it
 * was, or whether it happened at all. A question invites a disclosure a child is not
 * ready to make, and the answer is not needed in order to give the advice.
 *
 * A constant rather than an LLM output, for the same reason as IMMINENT_REPLY: this
 * is a safety instruction with required content, and a model that drops a clause is
 * worse than a robot.
 */
export const EXPLOITATION_REPLY =
  "i believe you, and this is not your fault. please do not send them anything, " +
  "not pictures and not a video. please block them now, and please tell a trusted " +
  "adult today - a parent, a teacher, someone at school. you do not have to explain " +
  "anything to make that happen.";

/**
 * Does this signal mean online exploitation rather than some other safeguarding kind?
 *
 * Rule-prefix matching rather than a level match, because exploitation and abuse are
 * both `safeguarding` and they get different advice.
 */
export function isExploitation(rule: string): boolean {
  return rule.startsWith("exploitation-");
}

export interface WellbeingReplyOptions {
  level: Exclude<WellbeingLevel, "none">;
  /** `safety.helplineText` from config. Empty by default. NEVER invented. */
  helplineText?: string;
  /**
   * Has this player had the full reply recently? If so, give the SHORT one — still
   * present, still kind, just not the whole thing again.
   */
  alreadyAnswered?: boolean;
  /** Overridable for tests. */
  random?: () => number;
}

/** The short replies used when a player has already had the full one. */
const SHORT_CONCERN = [
  "still here. you can tell me more whenever.",
  "i'm here. no rush.",
  "still listening. take your time.",
];
const SHORT_CRISIS = [
  "i'm still here. please don't stop talking to someone you trust.",
  "still here. please reach out to a trusted adult if you haven't yet.",
];

/**
 * Build the deterministic reply.
 *
 * The helpline is appended verbatim only when the owner configured one. There is
 * no default number anywhere in this file, and none is derived: an invented
 * helpline sends someone to a place that does not exist.
 */
export function buildWellbeingReply(opts: WellbeingReplyOptions): string {
  const rand = opts.random ?? Math.random;
  const pool =
    opts.level === "crisis"
      ? opts.alreadyAnswered
        ? SHORT_CRISIS
        : CRISIS_LINES
      : opts.level === "safeguarding"
        ? // No short form: a safeguarding reply is never worth abbreviating.
          SAFEGUARDING_LINES
        : opts.alreadyAnswered
          ? SHORT_CONCERN
          : CONCERN_LINES;
  const base = pool[Math.floor(rand() * pool.length)] ?? pool[0] ?? "";

  const helpline = (opts.helplineText ?? "").trim();
  if (helpline.length === 0) return base;
  return `${base} if it helps: ${helpline}`;
}

/**
 * The strict system prompt, used when the LLM is allowed to phrase the reply.
 *
 * Deliberately narrow. It is allowed to sound like Elix; it is not allowed to
 * joke, deflect, mention being an AI, or give advice about the crisis itself.
 */
export const WELLBEING_SYSTEM_PROMPT = `You are Elix, a Minecraft companion. The player you are talking to has just said something that suggests they are in emotional pain.

Rules for this one reply, and they are not negotiable:
- Be calm, warm and brief. Two short sentences at most.
- Say plainly that you are here and are listening.
- Gently encourage them to talk to someone they trust - a parent, a teacher, or another adult - in real life.
- Do NOT joke, use slang, use emoji, or make light of it in any way.
- Do NOT lecture, guilt them, or tell them what to think.
- Do NOT mention being an AI, the game, or anything else that is going on.
- Do NOT give medical, legal or crisis advice beyond "talk to someone you trust now".
- Never suggest a phone number or a website. You do not know any and must not invent one.

Reply with the message only.`;

export interface WellbeingCleanResult {
  clean: boolean;
  why: string;
}

/**
 * Is an LLM-phrased reply safe to actually send?
 *
 * The template is the floor, so anything questionable here falls back to it. This
 * is deliberately strict: a reply that mentions being a bot, jokes, uses emoji, or
 * is not clearly caring is rejected.
 */
export function checkWellbeingReply(
  text: string,
  level: Exclude<WellbeingLevel, "none"> = "concern",
): WellbeingCleanResult {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { clean: false, why: "empty" };
  if (trimmed.length > 320) return { clean: false, why: "too long for this moment" };

  // Emoji, and anything outside the BMP. Minecraft renders most of them as
  // boxes, and a box in a reply to someone in crisis is a failure. The
  // variation selectors and joiner are alternation rather than a character class
  // because they are combining marks.
  if (/\p{Extended_Pictographic}|\u200D|\uFE0E|\uFE0F/u.test(trimmed)) {
    return { clean: false, why: "emoji" };
  }
  // Joke markers. A joke here is the single worst possible failure.
  if (/\b(?:lol|lmao|rofl|haha|hah|jk|joking|funny)\b/i.test(trimmed)) {
    return { clean: false, why: "joke marker" };
  }
  // It must not step out of character by talking about itself.
  if (/\b(?:as an ai|i'?m an ai|language model|my programming)\b/i.test(trimmed)) {
    return { clean: false, why: "broke character" };
  }
  // Never an invented number. Checked BEFORE the caring test, because a reply that
  // is otherwise fine but contains a phone number must fail for the right reason.
  if (/\b\d[\d\s-]{6,}\d\b/.test(trimmed)) return { clean: false, why: "contains a number" };
  // It must actually mention reaching a person, or at least being present.
  const cares =
    /\b(?:here|listening|trust|talk (?:to|about)|reach out|adult|teacher|parent|support|tell(?:ing)? me|want to|how are you)\b/i.test(
      trimmed,
    );
  if (!cares) return { clean: false, why: "not caring enough" };

  /**
   * The level's REQUIRED elements.
   *
   * Proving this live is what forced it. Round 10 ran e2e rows 20 and 22 against
   * the server and the LLM's phrasings were rejected:
   *
   *   crisis:      "I'm here and listening. Please keep talking to someone you
   *                 trust."                        — no "right now", no services
   *   safeguarding: "…talk to a trusted adult — such as a parent, teacher, or
   *                 counselor — about what you're feeling."
   *                                              — no "not your fault", and it
   *                                                edges toward asking for detail
   *
   * Both passed every check this function had, because every check asked "is this
   * not harmful?" and neither asked "does this say the thing it has to say?".
   *
   * A reply that is warm but omits the point is not a good enough reply. It gets
   * the template instead, which is what the floor is for.
   */
  if (level === "crisis") {
    const reaches =
      /\b(?:trusted adult|adult|parent|teacher|guardian|a relative|someone you trust|a person you trust|emergency services|crisis line)\b/i.test(
        trimmed,
      );
    if (!reaches) return { clean: false, why: "crisis reply does not urge a real person" };
    // The vision says "reach out RIGHT NOW". A crisis reply that omits the urgency
    // is the failure the whole level exists to prevent.
    if (!/\bright now\b/i.test(trimmed)) {
      return { clean: false, why: "crisis reply does not say right now" };
    }
  }

  if (level === "safeguarding") {
    // Saying it is not their fault is the sentence a child being hurt most needs,
    // and the live run showed it is exactly what gets dropped.
    if (!/not your fault/i.test(trimmed)) {
      return { clean: false, why: "safeguarding reply does not say it is not their fault" };
    }
    // Never invite detail. Asking a frightened teenager to describe being abused in
    // public chat is the harm this level exists to avoid, and a LLM phrasing will
    // find a way to get close to it ("about what you're feeling").
    if (/\b(?:what (?:happened|you'?re feeling)|tell me (?:what|more|about)|how (?:did|does) that happen|details)\b/i.test(trimmed)) {
      return { clean: false, why: "safeguarding reply asks for details" };
    }
  }

  return { clean: true, why: "ok" };
}

/* ------------------------------------------------------------ what to store */

/**
 * What gets written to memory. NEVER the raw message.
 *
 * "Ali seemed really down" is enough for Elix to gently check in next time. Storing
 * the words themselves would put a minor's crisis into a database that gets
 * embedded, backed up and searched, and Elix does not need that to be kind.
 */
export function wellbeingEpisodeText(player: string, level: WellbeingLevel): string {
  if (level === "crisis") return `${player} seemed really down`;
  if (level === "concern") return `${player} seemed a bit low`;
  // Its own wording rather than the catch-all, because "said something heavy" is
  // vague enough that a later check-in could not tell abuse apart from sadness, and
  // the check-in is the whole point of storing this.
  if (level === "safeguarding") return `${player} seemed like they needed help`;
  return `${player} said something heavy`;
}

/**
 * Track the per-player crisis cooldown.
 *
 * Held in memory only. This is session state, not something to persist: a fresh
 * session SHOULD answer the full reply again.
 */
export class WellbeingState {
  private readonly answeredAt = new Map<string, number>();
  private readonly recordedThisSession = new Set<string>();
  /** Total saved this session, for the tests and the dashboard. */
  interventions = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** Has this player had the full crisis reply inside the cooldown? */
  recentlyAnswered(player: string): boolean {
    const at = this.answeredAt.get(player);
    return at !== undefined && this.now() - at < CRISIS_COOLDOWN_MS;
  }

  noteAnswered(player: string): void {
    this.answeredAt.set(player, this.now());
    this.interventions += 1;
  }

  /**
   * May we remember that this player is struggling?
   *
   * Once per session. A check-in every time someone says something low would
   * become nagging, and nagging is the thing that makes people stop talking.
   */
  mayRecord(player: string): boolean {
    if (this.recordedThisSession.has(player)) return false;
    this.recordedThisSession.add(player);
    return true;
  }
}

/** Log shape. Only ever the player name and the level — never the message. */
export function logWellbeing(log: Logger | undefined, level: WellbeingLevel, player: string): void {
  if (!log || level === "none") return;
  log.warn({ wellbeing: level, player }, `wellbeing: ${level}`);
}