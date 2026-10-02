/**
 * B7 — SSE streaming, with awkward chunk boundaries.
 *
 * The real failure mode is not "malformed JSON" but "a network read landed in
 * the middle of a token". Each test here splits the byte stream at a different
 * point and asserts the same assembled output.
 */
import { describe, expect, it } from "vitest";
import { parseSseEvent, iterateSse } from "../../src/brain/groq.js";

/** A well-formed SSE body for a three-delta completion. */
function sseBody(deltas: string[]): string {
  return (
    deltas
      .map((d) => `data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}\n\n`)
      .join("") + "data: [DONE]\n\n"
  );
}

/** Split a string into fixed-size byte chunks, like a real socket read. */
function chunked(text: string, size: number): Uint8Array[] {
  const bytes = new TextEncoder().encode(text);
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) {
    out.push(bytes.slice(i, i + size));
  }
  return out;
}

/** A Response-like object with a ReadableStream body, split at `size` bytes. */
function fakeStream(
  text: string,
  size: number,
): { body: { getReader: () => ReadableStreamDefaultReader<Uint8Array> } } {
  const chunks = chunked(text, size);
  let i = 0;
  return {
    body: {
      getReader: () =>
        ({
          read: () =>
            Promise.resolve(
              i < chunks.length
                ? { done: false, value: chunks[i++] }
                : { done: true, value: undefined },
            ),
        }) as unknown as ReadableStreamDefaultReader<Uint8Array>,
    },
  };
}

async function collect(streamSize: number, deltas = ["he", "llo ", "world"]): Promise<string> {
  const out: string[] = [];
  for await (const chunk of iterateSse(fakeStream(sseBody(deltas), streamSize))) {
    out.push(chunk);
  }
  return out.join("");
}

describe("B7 — SSE parsing across awkward chunk boundaries", () => {
  it("reassembles a stream delivered one byte at a time", async () => {
    expect(await collect(1)).toBe("hello world");
  });

  it("survives a chunk that splits mid-JSON", async () => {
    // A single chunk containing half of a `data: {...}` line.
    const body = sseBody(["abc", "def"]);
    const splitAt = body.indexOf("def") + 2;
    const whole = fakeStream(body.slice(0, splitAt) + body.slice(splitAt), 10_000);
    const out: string[] = [];
    for await (const c of iterateSse(whole)) out.push(c);
    expect(out.join("")).toBe("abcdef");
  });

  it("survives a chunk that splits the 'data:' prefix itself", async () => {
    // First read ends after "dat", the rest arrives later.
    const body = sseBody(["one", "two"]);
    const bytes = new TextEncoder().encode(body);
    let i = 0;
    const pieces = [bytes.slice(0, 3), bytes.slice(3)];
    const response = {
      body: {
        getReader: () => ({
          read: () =>
            Promise.resolve(
              i < pieces.length ? { done: false, value: pieces[i++] } : { done: true, value: undefined },
            ),
        }),
      } as unknown as ReadableStreamDefaultReader<Uint8Array>,
    };
    const out: string[] = [];
    for await (const c of iterateSse(response)) out.push(c);
    expect(out.join("")).toBe("onetwo");
  });

  it("handles a [DONE] arriving on its own with no trailing newline", async () => {
    const body = `data: ${JSON.stringify({ choices: [{ delta: { content: "final" } }] })}\n\ndata: [DONE]`;
    const out: string[] = [];
    for await (const c of iterateSse(fakeStream(body, 7))) out.push(c);
    expect(out.join("")).toBe("final");
  });

  it("ignores comments, event ids and empty data lines", async () => {
    const body = [
      ": keep-alive comment",
      "event: message",
      "id: 42",
      "data: ",
      `data: ${JSON.stringify({ choices: [{ delta: { content: "real" } }] })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const out: string[] = [];
    for await (const c of iterateSse(fakeStream(body, 5))) out.push(c);
    expect(out.join("")).toBe("real");
  });

  it("never yields a reasoning delta, only content", async () => {
    const body =
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning: "internal thought" } }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ delta: { content: "the answer" } }] })}\n\n` +
      "data: [DONE]\n\n";
    const out: string[] = [];
    for await (const c of iterateSse(fakeStream(body, 9))) out.push(c);
    expect(out.join("")).toBe("the answer");
  });

  it("returns nothing for an empty body rather than throwing", async () => {
    const out: string[] = [];
    for await (const c of iterateSse(fakeStream("", 4))) out.push(c);
    expect(out).toEqual([]);
  });
});

describe("B7 — parseSseEvent unit behaviour", () => {
  it("returns the content delta of a well-formed event", () => {
    expect(
      parseSseEvent(`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}`),
    ).toBe("hi");
  });

  it("returns null for a [DONE] event", () => {
    expect(parseSseEvent("data: [DONE]")).toBeNull();
  });

  it("returns null for truncated JSON so the next chunk can complete it", () => {
    expect(parseSseEvent('data: {"choices":[{"delta":{"content":"hi"')).toBeNull();
  });

  it("returns null when a delta has null content", () => {
    expect(parseSseEvent('data: {"choices":[{"delta":{"content":null}}]}')).toBeNull();
  });

  it("handles CRLF line endings", () => {
    expect(
      parseSseEvent(`data: ${JSON.stringify({ choices: [{ delta: { content: "crlf" } }] })}\r\n\r\n`),
    ).toBe("crlf");
  });
});
