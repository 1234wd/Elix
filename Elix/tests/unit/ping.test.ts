import { describe, it, expect } from "vitest";
import { inferBrand, flattenMotd, parseStatusResponse, NeedMoreData } from "../../src/connection/ping.js";

/**
 * A13: the server brand must be inferred from version.name (Paper and vanilla
 * never send a `software` field), the MOTD must flatten nested `extra`, and
 * readVarint must signal "need more data" instead of reading past the buffer.
 */

/** Build a full SLP status response: [length][id][strlen][json]. */
function statusPacket(json: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(json), "utf8");
  const strLen = varint(payload.length);
  const body = Buffer.concat([Buffer.from([0x00]), strLen, payload]);
  return Buffer.concat([varint(body.length), body]);
}

function varint(value: number): Buffer {
  const out: number[] = [];
  let v = value;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    out.push(b);
  } while (v !== 0);
  return Buffer.from(out);
}

describe("inferBrand", () => {
  it("recognises Paper from version.name", () => {
    expect(inferBrand("Paper 26.2")).toBe("Paper");
  });

  it("recognises Fabric and vanilla", () => {
    expect(inferBrand("Fabric 0.100.0+1.21")).toBe("Fabric");
    expect(inferBrand("1.20.1")).toBe("Vanilla");
  });

  it("recognises other server brands", () => {
    expect(inferBrand("Purpur 26.2")).toBe("Purpur");
    expect(inferBrand("Spigot 26.2")).toBe("Spigot");
    expect(inferBrand("Folia 26.2")).toBe("Folia");
  });

  it("treats a bare version string as vanilla (no brand word = no mod)", () => {
    expect(inferBrand("26.2")).toBe("Vanilla");
    expect(inferBrand("1.20.1")).toBe("Vanilla");
  });

  it("returns unknown when the name is empty or unrecognisable", () => {
    expect(inferBrand("")).toBe("unknown");
    expect(inferBrand("some-proxy-build")).toBe("unknown");
  });
});

describe("flattenMotd", () => {
  it("handles a plain string", () => {
    expect(flattenMotd("Ali's server")).toBe("Ali's server");
  });

  it("concatenates text and every extra entry", () => {
    expect(flattenMotd({ text: "Ali ", extra: [{ text: "'s " }, { text: "server" }] })).toBe(
      "Ali 's server",
    );
  });

  it("returns empty for null or a non-object", () => {
    expect(flattenMotd(null)).toBe("");
    expect(flattenMotd(42)).toBe("");
  });
});

describe("parseStatusResponse", () => {
  it("parses a Paper response, inferring the brand from version.name", () => {
    const buf = statusPacket({
      version: { name: "Paper 26.2", protocol: 776 },
      players: { online: 2, max: 20 },
      description: { text: "Ali ", extra: [{ text: "'s server" }] },
    });
    const r = parseStatusResponse(buf);
    expect(r.version).toBe("Paper 26.2");
    expect(r.protocol).toBe(776);
    expect(r.software).toBe("Paper");
    expect(r.motd).toBe("Ali 's server");
    expect(r.players).toEqual({ online: 2, max: 20 });
  });

  it("reports Vanilla when the server sends a bare version with no brand", () => {
    const buf = statusPacket({
      version: { name: "26.2", protocol: 776 },
      players: { online: 0, max: 10 },
      description: "plain motd",
    });
    const r = parseStatusResponse(buf);
    expect(r.software).toBe("Vanilla");
    expect(r.motd).toBe("plain motd");
  });

  it("prefers an explicit software field when a proxy sends one", () => {
    const buf = statusPacket({
      version: { name: "26.2", protocol: 776 },
      players: { online: 0, max: 10 },
      description: "",
      software: "Velocity",
    });
    expect(parseStatusResponse(buf).software).toBe("Velocity");
  });

  it("throws NeedMoreData on a truncated packet instead of reading past the end", () => {
    const full = statusPacket({
      version: { name: "Paper 26.2", protocol: 776 },
      players: { online: 0, max: 10 },
      description: "x",
    });
    // Every strict prefix must be reported as "wait for more", never as a parse.
    for (let cut = 1; cut < full.length; cut++) {
      expect(() => parseStatusResponse(full.subarray(0, cut)), `prefix of ${cut} bytes`).toThrow(
        NeedMoreData,
      );
    }
    // The whole thing parses.
    expect(parseStatusResponse(full).protocol).toBe(776);
  });

  it("handles a multi-byte varint length", () => {
    // A JSON body over 127 bytes forces a 2-byte length prefix.
    const buf = statusPacket({
      version: { name: "Paper 26.2", protocol: 776 },
      players: { online: 0, max: 20 },
      description: "x".repeat(200),
    });
    expect(buf.length).toBeGreaterThan(140);
    expect(parseStatusResponse(buf).motd.length).toBe(200);
  });
});