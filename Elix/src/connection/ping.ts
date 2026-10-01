import { createConnection } from "node:net";

/**
 * Minecraft Server List Ping (SLP) — the protocol used by server browsers.
 * Implemented from scratch over raw TCP: handshake → status request → JSON.
 *
 * Gives us the server's real version, protocol number, software brand,
 * MOTD and player count before we ever connect with mineflayer.
 */

export interface PingResult {
  /** e.g. "26.2" — the raw version.name the server reported */
  version: string;
  /** e.g. 776 */
  protocol: number;
  /** Server software brand, e.g. "Paper" */
  software: string;
  /** MOTD text (may be empty) */
  motd: string;
  players: { online: number; max: number };
  /** Raw response for debugging */
  raw: Record<string, unknown>;
}

/**
 * Known server brands, checked in order against version.name.
 * Paper/Spigot/Purpur/Folia put the brand in version.name; vanilla and
 * Fabric usually do not, so those fall back to "unknown" and we use
 * bot.game.serverBrand (the minecraft:brand plugin channel) after login.
 */
const KNOWN_BRANDS: Array<[RegExp, string]> = [
  [/\bpaper\b/i, "Paper"],
  [/\bfolia\b/i, "Folia"],
  [/\bpurpur\b/i, "Purpur"],
  [/\bspigot\b/i, "Spigot"],
  [/\bbukkit\b/i, "Bukkit"],
  [/\byarn\b/i, "Fabric"],
  [/\bfabric\b/i, "Fabric"],
  [/\bneoforge\b/i, "NeoForge"],
  [/\bforge\b/i, "Forge"],
  [/\bquilt\b/i, "Quilt"],
  [/\bvanilla\b/i, "Vanilla"],
  // A bare version with no brand word at all is a vanilla server. Paper,
  // Spigot, Fabric etc. all put a brand word in version.name.
  [/^\d+(\.\d+)*$/, "Vanilla"],
];

/** Infer the software brand from the version.name string. */
export function inferBrand(versionName: string): string {
  for (const [pattern, brand] of KNOWN_BRANDS) {
    if (pattern.test(versionName)) return brand;
  }
  return "unknown";
}

/** VarInt encoding (Minecraft protocol). */
function writeVarint(value: number): Buffer {
  const buf: number[] = [];
  let v = value;
  while (true) {
    if ((v & ~0x7f) === 0) {
      buf.push(v);
      break;
    }
    buf.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  return Buffer.from(buf);
}

/**
 * VarInt decoding with read offset. Throws `NEED_MORE_DATA` when the buffer is
 * incomplete so the caller waits for more bytes instead of reading past the end.
 */
export class NeedMoreData extends Error {
  constructor() {
    super("NEED_MORE_DATA");
    this.name = "NeedMoreData";
  }
}

function readVarint(buf: Buffer, offset: number): { value: number; offset: number } {
  let value = 0;
  let shift = 0;
  let o = offset;
  while (true) {
    if (o >= buf.length) throw new NeedMoreData();
    const b = buf[o++]!;
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 35) throw new Error("VarInt too long");
  }
  return { value, offset: o };
}

function writeString(s: string): Buffer {
  const encoded = Buffer.from(s, "utf8");
  return Buffer.concat([writeVarint(encoded.length), encoded]);
}

function readString(buf: Buffer, offset: number): { value: string; offset: number } {
  const { value: len, offset: o1 } = readVarint(buf, offset);
  if (o1 + len > buf.length) throw new NeedMoreData();
  return { value: buf.toString("utf8", o1, o1 + len), offset: o1 + len };
}

/**
 * Build the handshake + status request packet.
 *
 * The handshake protocol number is a hint only — the server replies with its
 * own version and protocol regardless, so this is not load-bearing.
 */
function buildPingPacket(host: string, port: number, protocolVersion: number): Buffer {
  const hostBytes = writeString(host);
  const portBytes = Buffer.alloc(2);
  portBytes.writeUInt16BE(port, 0);
  const nextState = writeVarint(1); // 1 = status

  const payload = Buffer.concat([
    writeVarint(protocolVersion),
    hostBytes,
    portBytes,
    nextState,
  ]);
  // Packet ID 0x00 for handshake, prefixed with total length
  const packet = Buffer.concat([writeVarint(0x00), payload]);
  return Buffer.concat([writeVarint(packet.length), packet]);
}

/** Flatten a MOTD component (string, {text}, {text, extra[]}) to plain text. */
export function flattenMotd(node: unknown): string {
  if (typeof node === "string") return node;
  if (!node || typeof node !== "object") return "";
  const obj = node as Record<string, unknown>;
  let out = typeof obj.text === "string" ? obj.text : "";
  if (Array.isArray(obj.extra)) {
    for (const child of obj.extra) out += flattenMotd(child);
  }
  return out;
}

/** Parse the JSON status response. Throws NeedMoreData on a partial packet. */
export function parseStatusResponse(buf: Buffer): PingResult {
  // Response: [length][packetId][stringLength][jsonString]
  const { offset: o1 } = readVarint(buf, 0); // packet length
  const { offset: o2 } = readVarint(buf, o1); // packet ID
  const { value: json } = readString(buf, o2);
  const raw = JSON.parse(json) as Record<string, unknown>;

  const version = (raw.version as Record<string, unknown>) ?? {};
  const players = (raw.players as Record<string, unknown>) ?? {};

  const versionName = String(version.name ?? "unknown");

  // Some proxies send an explicit `software` field; otherwise infer the brand
  // from version.name (e.g. "Paper 26.2"). Paper/vanilla normally send neither,
  // so bot.game.serverBrand after login is the reliable source (A13).
  const explicit = typeof raw.software === "string" ? raw.software : "";
  const software = explicit.length > 0 ? explicit : inferBrand(versionName);

  return {
    version: versionName,
    protocol: Number(version.protocol ?? 0),
    software,
    motd: flattenMotd(raw.description),
    players: {
      online: Number(players.online ?? 0),
      max: Number(players.max ?? 0),
    },
    raw,
  };
}

/**
 * Ping a Minecraft server. Throws on timeout, protocol error, or connection
 * failure. `protocolVersion` is only the handshake hint (A11 — never hard-coded).
 */
export async function pingServer(
  host: string,
  port: number,
  timeoutMs = 5000,
  protocolVersion = -1,
): Promise<PingResult> {
  return new Promise((resolvePromise, reject) => {
    const sock = createConnection({ host, port });
    let buffer = Buffer.alloc(0);
    let responded = false;

    const fail = (err: Error) => {
      if (responded) return;
      responded = true;
      clearTimeout(timer);
      sock.destroy();
      reject(err);
    };

    const timer = setTimeout(() => {
      fail(new Error(`Ping timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    sock.on("connect", () => {
      sock.write(buildPingPacket(host, port, protocolVersion));
      // Send status request (packet ID 0x00, empty)
      sock.write(Buffer.from([0x01, 0x00]));
    });

    sock.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        const result = parseStatusResponse(buffer);
        responded = true;
        clearTimeout(timer);
        sock.destroy();
        resolvePromise(result);
      } catch (err) {
        if (err instanceof NeedMoreData) return; // wait for the rest
        // A malformed/oversized packet is a real protocol error.
        fail(err as Error);
      }
    });

    sock.on("error", (err) => fail(err));

    sock.on("close", () => fail(new Error("Connection closed before response")));
  });
}