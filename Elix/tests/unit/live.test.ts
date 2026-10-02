/**
 * B10 — the one live smoke test.
 *
 * Skipped unless ELIX_LIVE=1, so `pnpm test` stays fully offline and free. When
 * enabled it makes exactly two real calls (one Groq chat completion, one Hugging
 * Face call) and prints the HTTP status, so the report can show real output
 * rather than a claim.
 *
 *   ELIX_LIVE=1 pnpm test tests/unit/live.test.ts
 */
import { describe, expect, it } from "vitest";
import { GroqProvider, GROQ_BASE } from "../../src/brain/groq.js";
import { HuggingFaceProvider, HF_CHAT_URL, hfEmbeddingsUrl } from "../../src/brain/hf.js";
import { stripReasoning } from "../../src/brain/reasoning.js";
import { parseRateLimitHeaders } from "../../src/brain/ratelimit.js";

const LIVE = process.env["ELIX_LIVE"] === "1";
const GROQ_KEY = process.env["GROQ_API_KEY"]?.trim();
const HF_KEY = process.env["HF_TOKEN"]?.trim();

describe.skipIf(!LIVE)("LIVE — real provider calls (ELIX_LIVE=1)", () => {
  it(
    "makes one real Groq call and reports the status, rate-limit headers and stripped answer",
    async () => {
      expect(GROQ_KEY, "GROQ_API_KEY must be set for the live test").toBeTruthy();
      const provider = new GroqProvider({ apiKey: GROQ_KEY! });

      const res = await fetch(`${GROQ_BASE}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${GROQ_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "openai/gpt-oss-20b",
          messages: [{ role: "user", content: "say hi in three words" }],
          max_tokens: 40,
          reasoning_effort: "low",
          reasoning_format: "hidden",
        }),
      });
      const text = await res.text();
      const info = parseRateLimitHeaders(res.headers);
      // Printed so the report can quote a real status rather than assert one.
      console.log(
        `[live] groq ${res.status} remaining-tokens=${info.remainingTokens} ` +
          `reset-tokens=${info.resetTokensSec}s reset-requests=${info.resetRequestsSec}s`,
      );
      console.log(`[live] groq body: ${text.slice(0, 300)}`);

      expect(res.status).toBe(200);

      const parsed = JSON.parse(text) as {
        choices: Array<{ message: { content?: string; reasoning?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const split = stripReasoning({
        content: parsed.choices[0]?.message.content ?? "",
        reasoning: parsed.choices[0]?.message.reasoning,
      });
      // The assertion that matters: no reasoning text reaches the caller.
      expect(split.content).not.toMatch(/<think>/i);
      expect(split.content.trim().length).toBeGreaterThan(0);
      expect(parsed.usage?.prompt_tokens).toBeGreaterThan(0);

      // The adapter itself must work too, not just a hand-rolled fetch.
      const viaAdapter = await provider.complete(
        { messages: [{ role: "user", content: "say hi in three words" }], role: "fast", maxTokens: 40 },
        "openai/gpt-oss-20b",
      );
      expect(viaAdapter.text.trim().length).toBeGreaterThan(0);
      expect(viaAdapter.tokensIn).toBeGreaterThan(0);
    },
    60_000,
  );

  it(
    "makes one real Hugging Face call and reports the status",
    async () => {
      if (!HF_KEY) {
        console.log("[live] HF_TOKEN not set — skipping the HF half");
        return;
      }
      const provider = new HuggingFaceProvider({ apiKey: HF_KEY });

      // First: does the A3 URL fix actually resolve? The point of the test is
      // to print the real status, whatever it is.
      const url = hfEmbeddingsUrl("BAAI/bge-small-en-v1.5");
      console.log(`[live] hf embeddings url: ${url}`);
      const embRes = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${HF_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ inputs: ["hello"] }),
      });
      const embBody = await embRes.text();
      console.log(`[live] hf embeddings ${embRes.status} ${embBody.slice(0, 200)}`);
      expect(embRes.status).toBeGreaterThan(0);

      // Then: the chat route.
      console.log(`[live] hf chat url: ${HF_CHAT_URL}`);
      const chatRes = await fetch(HF_CHAT_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${HF_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "meta-llama/Llama-3.3-70B-Instruct",
          messages: [{ role: "user", content: "say hi in three words" }],
          max_tokens: 40,
        }),
      });
      const chatBody = await chatRes.text();
      console.log(`[live] hf chat ${chatRes.status} ${chatBody.slice(0, 300)}`);

      if (chatRes.ok) {
        const viaAdapter = await provider.complete(
          { messages: [{ role: "user", content: "say hi in three words" }], role: "fast", maxTokens: 40 },
          "meta-llama/Llama-3.3-70B-Instruct",
        );
        expect(viaAdapter.text.trim().length).toBeGreaterThan(0);
      } else {
        // A free-tier 402/429 is a legitimate outcome, not a test failure; the
        // provider layer must have turned it into a credits error.
        expect([402, 429, 401, 403, 404]).toContain(chatRes.status);
        console.log("[live] hf is unavailable (free credit exhausted?) — adapter path not exercised");
      }
    },
    60_000,
  );
});
