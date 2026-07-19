import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';

// ---------------------------------------------------------------------------
// Minimal, self-contained WebSocket transport (RFC 6455) — sdd_host realtime
//
// The build bundles everything (tsup bundle:true), and the `ws` package pulls
// optional native requires that trip esbuild, so the realtime channel rides a
// small hand-rolled server instead of a dependency. It handles exactly what the
// realtime hub needs: the upgrade handshake, masked client text frames, ping →
// pong, and close; server frames are written unmasked. Payloads are tiny JSON
// control messages, so a conservative size cap closes abusive connections.
// ---------------------------------------------------------------------------

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 1 << 20; // 1 MiB — control messages are tiny; this only guards abuse.

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

/** True when the request is a WebSocket upgrade handshake. */
export function isWebSocketUpgrade(req: IncomingMessage): boolean {
  return (
    (req.headers['upgrade'] ?? '').toLowerCase() === 'websocket' &&
    typeof req.headers['sec-websocket-key'] === 'string'
  );
}

/** Complete the handshake and return a live connection, or null when the request
 *  is not a valid WS upgrade (the caller then destroys the socket). */
export function acceptWebSocket(req: IncomingMessage, socket: Duplex): WsConnection | null {
  const key = req.headers['sec-websocket-key'];
  if (!isWebSocketUpgrade(req) || typeof key !== 'string') return null;
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  return new WsConnection(socket);
}

/**
 * One live WebSocket connection. Emits `message` (string) and `close`. Frames
 * arriving fragmented are reassembled; oversized or malformed input closes the
 * connection. Not exported for direct construction — use acceptWebSocket.
 */
export class WsConnection extends EventEmitter {
  private buffer: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private closed = false;

  constructor(private readonly socket: Duplex) {
    super();
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('close', () => this.onSocketClosed());
    socket.on('error', () => this.destroy());
  }

  /** Send a text frame (server frames are never masked). */
  send(text: string): void {
    if (this.closed) return;
    try {
      this.socket.write(encodeFrame(OP_TEXT, Buffer.from(text, 'utf8')));
    } catch {
      this.destroy();
    }
  }

  /** Send a ping (heartbeat). The peer's pong keeps the connection considered live. */
  ping(): void {
    if (this.closed) return;
    try {
      this.socket.write(encodeFrame(OP_PING, Buffer.alloc(0)));
    } catch {
      this.destroy();
    }
  }

  close(): void {
    if (this.closed) return;
    try {
      this.socket.write(encodeFrame(OP_CLOSE, Buffer.alloc(0)));
    } catch {
      /* ignore */
    }
    this.destroy();
  }

  private destroy(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.end();
    } catch {
      /* ignore */
    }
    this.emit('close');
  }

  private onSocketClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }

  private onData(chunk: Buffer): void {
    if (this.closed) return;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    // Parse as many whole frames as the buffer holds; keep any partial tail.
    for (;;) {
      const frame = decodeFrame(this.buffer);
      if (frame === 'incomplete') return;
      if (frame === 'invalid') return this.close();
      this.buffer = this.buffer.subarray(frame.consumed);
      this.handleFrame(frame.opcode, frame.fin, frame.payload);
      if (this.closed) return;
    }
  }

  private handleFrame(opcode: number, fin: boolean, payload: Buffer): void {
    switch (opcode) {
      case OP_PING:
        try {
          this.socket.write(encodeFrame(OP_PONG, payload));
        } catch {
          this.destroy();
        }
        return;
      case OP_PONG:
        return; // heartbeat ack — nothing to do
      case OP_CLOSE:
        return this.close();
      case OP_TEXT:
      case OP_CONTINUATION: {
        this.fragments.push(payload);
        if (this.fragments.reduce((n, f) => n + f.length, 0) > MAX_PAYLOAD) return this.close();
        if (!fin) return; // more fragments to come
        const message = Buffer.concat(this.fragments).toString('utf8');
        this.fragments = [];
        this.emit('message', message);
        return;
      }
      default:
        return this.close(); // binary or reserved opcodes are unused here
    }
  }
}

interface DecodedFrame {
  opcode: number;
  fin: boolean;
  payload: Buffer;
  consumed: number;
}

/** Decode one frame from the front of `buf`. 'incomplete' = need more bytes;
 *  'invalid' = a protocol violation (e.g. an unmasked client frame). */
function decodeFrame(buf: Buffer): DecodedFrame | 'incomplete' | 'invalid' {
  if (buf.length < 2) return 'incomplete';
  const fin = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < offset + 2) return 'incomplete';
    len = buf.readUInt16BE(offset);
    offset += 2;
  } else if (len === 127) {
    if (buf.length < offset + 8) return 'incomplete';
    const big = buf.readBigUInt64BE(offset);
    if (big > BigInt(MAX_PAYLOAD)) return 'invalid';
    len = Number(big);
    offset += 8;
  }
  if (len > MAX_PAYLOAD) return 'invalid';
  // Client→server frames MUST be masked (RFC 6455 §5.1).
  if (!masked) return 'invalid';
  if (buf.length < offset + 4 + len) return 'incomplete';
  const mask = buf.subarray(offset, offset + 4);
  offset += 4;
  const payload = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) payload[i] = buf[offset + i] ^ mask[i & 3];
  return { opcode, fin, payload, consumed: offset + len };
}

/** Encode a server frame (FIN=1, unmasked). */
export function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/** Test-only decode helper exposing the frame parser. */
export function decodeFrameForTest(buf: Buffer): DecodedFrame | 'incomplete' | 'invalid' {
  return decodeFrame(buf);
}
