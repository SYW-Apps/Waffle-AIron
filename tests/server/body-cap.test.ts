import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage } from 'node:http';
import {
  readBody,
  PayloadTooLargeError,
  MAX_BODY_BYTES,
  startHostServer,
  type HostServerHandle,
} from '../../src/server/http.js';
import type { HostConfig } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Fix S3 — request body size cap.
//
// readBody runs on the public data plane (/mcp binds 0.0.0.0) BEFORE any
// authentication, so an unauthenticated client must not be able to stream an
// unbounded body and exhaust memory. readBody caps the accumulated body and an
// oversize Content-Length, rejecting with PayloadTooLargeError → HTTP 413.
// ---------------------------------------------------------------------------

/** A minimal IncomingMessage-like async iterable; tracks how many chunks were
 *  actually pulled so we can assert readBody stops before buffering everything. */
function mockReq(
  headers: Record<string, string>,
  chunks: Buffer[],
): { req: IncomingMessage; pulled: () => number } {
  let pulledCount = 0;
  async function* gen(): AsyncGenerator<Buffer> {
    for (const c of chunks) {
      pulledCount++;
      yield c;
    }
  }
  const iterator = gen();
  const req = {
    headers,
    [Symbol.asyncIterator]() {
      return iterator;
    },
  } as unknown as IncomingMessage;
  return { req, pulled: () => pulledCount };
}

describe('readBody body cap (unit)', () => {
  it('parses a normal-size JSON body', async () => {
    const { req } = mockReq({}, [Buffer.from(JSON.stringify({ hello: 'world' }))]);
    await expect(readBody(req)).resolves.toEqual({ hello: 'world' });
  });

  it('returns undefined for an empty body', async () => {
    const { req } = mockReq({}, []);
    await expect(readBody(req)).resolves.toBeUndefined();
  });

  it('allows a body whose Content-Length is exactly at the limit', async () => {
    const { req } = mockReq({ 'content-length': String(MAX_BODY_BYTES) }, [Buffer.from('{}')]);
    await expect(readBody(req)).resolves.toEqual({});
  });

  it('rejects once streamed bytes exceed the cap, without buffering the whole body', async () => {
    const oneMb = Buffer.alloc(1024 * 1024, 0x61);
    const perCap = Math.floor(MAX_BODY_BYTES / oneMb.length);
    const chunkCount = perCap + 50; // well past the cap
    const chunks = Array.from({ length: chunkCount }, () => oneMb);
    const { req, pulled } = mockReq({}, chunks);

    await expect(readBody(req)).rejects.toBeInstanceOf(PayloadTooLargeError);
    // Stopped as soon as the cap tripped (perCap+1 chunks), not the whole stream.
    expect(pulled()).toBe(perCap + 1);
    expect(pulled()).toBeLessThan(chunkCount);
  });

  it('short-circuits an oversize Content-Length before reading a byte', async () => {
    const { req, pulled } = mockReq({ 'content-length': String(MAX_BODY_BYTES + 1) }, [
      Buffer.alloc(10),
    ]);
    await expect(readBody(req)).rejects.toBeInstanceOf(PayloadTooLargeError);
    expect(pulled()).toBe(0);
  });
});

describe('data plane /mcp body cap (integration)', () => {
  let dataDir: string;
  let dataPort: number;
  const handles: HostServerHandle[] = [];

  function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.on('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const p = (srv.address() as AddressInfo).port;
        srv.close(() => resolve(p));
      });
    });
  }

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-bodycap-'));
    dataPort = await freePort();
    const adminPort = await freePort();
    // authEnabled: false → boots without an admin token; the body cap runs
    // before auth anyway, so this exercises the pre-auth reject path.
    const cfg: HostConfig = {
      host: '127.0.0.1',
      port: dataPort,
      adminHost: '127.0.0.1',
      adminPort,
      dataDir,
      authEnabled: false,
    };
    handles.push(startHostServer(cfg));
  });

  afterEach(() => {
    while (handles.length) handles.pop()!.close();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  it('accepts a normal-size POST to /mcp (not rejected by the body cap)', async () => {
    const res = await fetch(`http://127.0.0.1:${dataPort}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    await res.text();
    expect(res.status).not.toBe(413);
  });

  it('rejects an oversize Content-Length on /mcp with 413 (deterministic raw socket)', async () => {
    // Declare an oversize Content-Length but send only a tiny body: readBody
    // short-circuits on the header, so the server answers 413 immediately
    // without waiting for (or buffering) a multi-MB upload.
    const response = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(dataPort, '127.0.0.1', () => {
        socket.write(
          'POST /mcp HTTP/1.1\r\n' +
            'Host: 127.0.0.1\r\n' +
            'Content-Type: application/json\r\n' +
            `Content-Length: ${MAX_BODY_BYTES + 1}\r\n` +
            'Connection: close\r\n' +
            '\r\n' +
            'x',
        );
      });
      let data = '';
      socket.on('data', (d) => {
        data += d.toString('utf8');
      });
      socket.on('end', () => resolve(data));
      socket.on('error', reject);
      socket.setTimeout(5000, () => {
        socket.destroy();
        reject(new Error('timed out waiting for 413 response'));
      });
    });
    expect(response).toMatch(/^HTTP\/1\.1 413/);
  });
});
