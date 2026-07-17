import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getRealtimeHub, publishChange, channelsForWebMutation } from '../../src/server/realtime.js';
import { encodeFrame, decodeFrameForTest } from '../../src/server/websocket.js';
import { createWebSession } from '../../src/server/websessions.js';
import { allow, subjectOf } from './helpers.js';
import type { HostConfig, PrincipalSubject } from '../../src/server/types.js';

/** A web session whose subject is the env-anchored bootstrap admin → instanceAdmin. */
const ADMIN_SUBJECT: PrincipalSubject = { userId: 'bootstrap', kind: 'bootstrap', issuer: 'bootstrap' };

// ---------------------------------------------------------------------------
// Realtime channel hub + WebSocket transport (sdd_host). Exercises the frame
// parser directly and the hub through a mock socket: session-authenticated
// handshake, authorized subscriptions, and change broadcasts (no data on the
// wire — the event is a bare "refetch").
// ---------------------------------------------------------------------------

/** A masked client→server text frame (RFC 6455 §5.1 — clients MUST mask). */
function clientTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const mask = crypto.randomBytes(4);
  const len = payload.length; // test messages stay < 126 bytes
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([Buffer.from([0x81, 0x80 | len]), mask, masked]);
}

/** Parse the unmasked server text frames out of captured writes (skipping the
 *  HTTP 101 handshake). */
function serverMessages(chunks: Buffer[]): Record<string, unknown>[] {
  let buf = Buffer.concat(chunks);
  if (buf.toString('latin1', 0, 5) === 'HTTP/') {
    buf = buf.subarray(buf.indexOf('\r\n\r\n') + 4);
  }
  const out: Record<string, unknown>[] = [];
  let off = 0;
  while (off + 2 <= buf.length) {
    const opcode = buf[off] & 0x0f;
    let len = buf[off + 1] & 0x7f;
    let p = off + 2;
    if (len === 126) {
      len = buf.readUInt16BE(p);
      p += 2;
    }
    if (p + len > buf.length) break;
    if (opcode === 0x1) out.push(JSON.parse(buf.subarray(p, p + len).toString('utf8')));
    off = p + len;
  }
  return out;
}

class MockSocket extends EventEmitter {
  chunks: Buffer[] = [];
  destroyed = false;
  write(data: string | Buffer): boolean {
    this.chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    return true;
  }
  end(): void {
    this.emit('close');
  }
  destroy(): void {
    this.destroyed = true;
    this.emit('close');
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function upgradeReq(cookie?: string): any {
  return {
    url: '/web/ws',
    headers: {
      upgrade: 'websocket',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'sec-websocket-version': '13',
      ...(cookie ? { cookie: `wairon_session=${cookie}` } : {}),
    },
  };
}

describe('WebSocket frame transport (sdd_host)', () => {
  it('decodes a masked client text frame end to end', () => {
    const frame = clientTextFrame('hello');
    const d = decodeFrameForTest(frame);
    expect(typeof d).toBe('object');
    if (typeof d === 'object') {
      expect(d.opcode).toBe(0x1);
      expect(d.fin).toBe(true);
      expect(d.payload.toString('utf8')).toBe('hello');
      expect(d.consumed).toBe(frame.length);
    }
  });

  it('rejects an UNMASKED client frame (protocol violation)', () => {
    expect(decodeFrameForTest(encodeFrame(0x1, Buffer.from('x')))).toBe('invalid');
  });

  it('reports incomplete on a partial frame (buffered until whole)', () => {
    expect(decodeFrameForTest(clientTextFrame('hello').subarray(0, 4))).toBe('incomplete');
  });
});

describe('realtime channel hub (sdd_host)', () => {
  let base: string;
  let dataDir: string;
  let cfg: HostConfig;
  const savedEnv = { ...process.env };
  const hourAhead = () => new Date(Date.now() + 3_600_000).toISOString();

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-rt-'));
    dataDir = path.join(base, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    process.env.WAIRON_DATA_DIR = dataDir;
    cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true };
  });
  afterEach(() => {
    getRealtimeHub().closeAll(); // singleton — never leak subscribers across tests
    process.env = { ...savedEnv };
    try {
      fs.rmSync(base, { recursive: true, force: true });
    } catch {
      /* windows locks */
    }
  });

  function connect(subject: PrincipalSubject): MockSocket {
    const session = createWebSession(dataDir, {
      id: '',
      subject,
      projects: ['*'],
      createdAt: '',
      expiresAt: hourAhead(),
    });
    const sock = new MockSocket();
    getRealtimeHub().handleUpgrade(cfg, upgradeReq(session.id), sock);
    return sock;
  }

  it('an authenticated session subscribes and receives change nudges (instance admin sees admin channels)', () => {
    const sock = connect(ADMIN_SUBJECT);
    expect(sock.chunks[0].toString('latin1')).toContain('101 Switching Protocols');
    expect(getRealtimeHub().size).toBe(1);

    sock.emit('data', clientTextFrame(JSON.stringify({ type: 'subscribe', channels: ['users', 'projects'] })));
    publishChange('users');
    publishChange('projects');

    const msgs = serverMessages(sock.chunks);
    expect(msgs.some((m) => m.type === 'ready')).toBe(true);
    const subscribed = msgs.find((m) => m.type === 'subscribed');
    expect(subscribed?.channels).toEqual(expect.arrayContaining(['users', 'projects']));
    const changed = msgs.filter((m) => m.type === 'change').map((m) => m.channel);
    expect(changed).toEqual(expect.arrayContaining(['users', 'projects']));
  });

  it('authorizes each subscription: a non-admin gets user channels but NOT admin channels', () => {
    const sock = connect(subjectOf('u-plain')); // no grants
    sock.emit('data', clientTextFrame(JSON.stringify({ type: 'subscribe', channels: ['users', 'projects'] })));
    publishChange('users'); // admin channel — must not reach a non-admin
    publishChange('projects'); // user channel — delivered

    const msgs = serverMessages(sock.chunks);
    expect(msgs.find((m) => m.type === 'subscribed')?.channels).toEqual(['projects']);
    const changed = msgs.filter((m) => m.type === 'change').map((m) => m.channel);
    expect(changed).toContain('projects');
    expect(changed).not.toContain('users');
  });

  it('a project channel requires project:read on THAT project', () => {
    allow(dataDir, 'u-r', 'project:read', 'project', 'alpha');
    const sock = connect(subjectOf('u-r'));
    sock.emit(
      'data',
      clientTextFrame(JSON.stringify({ type: 'subscribe', channels: ['project:alpha', 'project:beta'] })),
    );
    const subscribed = serverMessages(sock.chunks).find((m) => m.type === 'subscribed');
    expect(subscribed?.channels).toEqual(['project:alpha']); // beta refused
  });

  it('rejects an unauthenticated upgrade (no session cookie) and never registers it', () => {
    const before = getRealtimeHub().size;
    const sock = new MockSocket();
    getRealtimeHub().handleUpgrade(cfg, upgradeReq(undefined), sock);
    expect(sock.destroyed).toBe(true);
    expect(getRealtimeHub().size).toBe(before);
  });

  it('maps web mutation paths to the channels they invalidate', () => {
    expect(channelsForWebMutation('/web/projects/lock', { projectId: 'demo' })).toEqual(
      expect.arrayContaining(['projects', 'landscape', 'project:demo']),
    );
    expect(channelsForWebMutation('/web/admin/org/units', {})).toEqual(expect.arrayContaining(['units', 'landscape']));
    expect(channelsForWebMutation('/web/admin/users', {})).toContain('users');
    expect(channelsForWebMutation('/web/admin/approvals/decide', {})).toContain('approvals');
    expect(channelsForWebMutation('/web/tokens', {})).toEqual(['tokens']);
    expect(channelsForWebMutation('/web/something-else', {})).toEqual([]);
  });
});
