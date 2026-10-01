import { createConnection } from "node:net";

/**
 * Minecraft Server List Ping (SLP) — the protocol used by server browsers.
 * Implemented from scratch over raw TCP: handshake → status request → JSON.
 *
 * Gives us the server's real version, protocol number, software brand,
 * MOTD and player count before we ever connect with mineflayer.
 */

export interface PingResult {
  /** e.g. "26.2" */
  version: string;
  /** e.g. 776 */
  protocol: number;
  /** Server software brand, e.g. "Paper 26.2" */
  software: string;
  /** MOTD text (may be empty) */
  motd: string;
  players: { online: number; max: number };
  /** Raw response for debugging */
  raw: Record<string, unknown>;
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

/** VarInt decoding with read offset. */
function readVarint(buf: Buffer, offset: number): { value: number; offset: number } {
  let value = 0;
  let shift = 0;
  let o = offset;
  while (true) {
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
  const value = buf.toString("utf8", o1, o1 + len);
  return { value, offset: o1 + len };
}

/** Build the handshake + status request packet. */
function buildPingPacket(host: string, port: number): Buffer {
  const protocolVersion = 776; // 26.2 — server responds with its own version
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

/** Parse the JSON status response. */
function parseStatusResponse(buf: Buffer): PingResult {
  // Response: [length][packetId][stringLength][jsonString]
  const { offset: o1 } = readVarint(buf, 0); // packet length
  const { offset: o2 } = readVarint(buf, o1); // packet ID
  const { value: json, offset: _o3 } = readString(buf, o2);
  const raw = JSON.parse(json) as Record<string, unknown>;

  const version = (raw.version as Record<string, unknown>) ?? {};
  const players = (raw.players as Record<string, unknown>) ?? {};

  // Software brand: "Paper" / "Spigot" / etc. from raw.software (if sent)
  const software = (raw.software as string) ?? "unknown";

  // MOTD: can be a string or a rich-text object
  const motdRaw = raw.description;
  let motd = "";
  if (typeof motdRaw === "string") motd = motdRaw;
  else if (motdRaw && typeof motdRaw === "object") {
    const text = (motdRaw as Record<string, unknown>).text;
    if (typeof text === "string") motd = text;
  }

  return {
    version: String(version.name ?? "unknown"),
    protocol: Number(version.protocol ?? 0),
    software,
    motd,
    players: {
      online: Number(players.online ?? 0),
      max: Number(players.max ?? 0),
    },
    raw,
  };
}

/** Ping a Minecraft server. Throws on timeout or protocol error. */
export async function pingServer(
  host: string,
  port: number,
  timeoutMs = 5000,
): Promise<PingResult> {
  return new Promise((resolvePromise, reject) => {
    const sock = createConnection({ host, port });
    let buffer = Buffer.alloc(0);
    let responded = false;

    const timer = setTimeout(() => {
      sock.destroy();
      if (!responded) reject(new Error(`Ping timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    sock.on("connect", () => {
      sock.write(buildPingPacket(host, port));
      // Send status request (packet ID 0x00, empty)
      sock.write(Buffer.from([0x01, 0x00]));
    });

    sock.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      // Try to parse once we have enough data
      try {
        const result = parseStatusResponse(buffer);
        responded = true;
        clearTimeout(timer);
        sock.destroy();
        resolvePromise(result);
      } catch {
        // Incomplete packet — wait for more data
      }
    });

    sock.on("error", (err) => {
      clearTimeout(timer);
      if (!responded) reject(err);
    });

    sock.on("close", () => {
      clearTimeout(timer);
      if (!responded) reject(new Error("Connection closed before response"));
    });
  });
}
