import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { http as io } from '../../src/io/index.js';

let server: http.Server;
let base: string;
const seenHeaders: http.IncomingHttpHeaders[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    seenHeaders.push(req.headers);
    const url = req.url ?? '';
    if (url === '/json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    } else if (url === '/echo') {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        res.writeHead(201, { 'content-type': 'text/plain' });
        res.end(`${req.method}:${Buffer.concat(chunks).toString()}`);
      });
    } else if (url === '/missing') {
      res.writeHead(404);
      res.end('nope');
    } else if (url === '/file') {
      res.writeHead(200);
      res.end('file-bytes');
    } else if (url === '/redirect') {
      res.writeHead(302, { location: `${base}/file` });
      res.end();
    } else {
      res.writeHead(500);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) fs.rmSync(t, { recursive: true, force: true });
});
function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-io-http-'));
  temps.push(dir);
  return path.join(dir, 'out.bin');
}

describe('io/http request', () => {
  it('answers the Response, whatever its status', async () => {
    const ok = await io.request(`${base}/json`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    const missing = await io.request(`${base}/missing`);
    expect(missing.ok).toBe(false);
    expect(missing.status).toBe(404);
  });

  it('sends method, headers and body', async () => {
    const res = await io.request(`${base}/echo`, { method: 'POST', headers: { 'x-probe': 'yes' }, body: 'payload' });
    expect(res.status).toBe(201);
    expect(await res.text()).toBe('POST:payload');
    expect(seenHeaders[seenHeaders.length - 1]['x-probe']).toBe('yes');
  });

  it('rejects when the server cannot be reached', async () => {
    const dead = http.createServer();
    await new Promise<void>((resolve) => dead.listen(0, '127.0.0.1', resolve));
    const port = (dead.address() as AddressInfo).port;
    await new Promise<void>((resolve) => dead.close(() => resolve()));
    await expect(io.request(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  });
});

describe('io/http getText', () => {
  it('answers status and body, with the headers it was given', async () => {
    const res = await io.getText(`${base}/json`, { Accept: 'application/json', 'User-Agent': 'probe/1' });
    expect(res).toEqual({ status: 200, body: '{"ok":true}' });
    expect(seenHeaders[seenHeaders.length - 1]['user-agent']).toBe('probe/1');
  });

  it('answers a non-200 status without rejecting', async () => {
    expect(await io.getText(`${base}/missing`, {})).toEqual({ status: 404, body: 'nope' });
  });

  it('does not follow a redirect', async () => {
    const res = await io.getText(`${base}/redirect`, {});
    expect(res.status).toBe(302);
  });

  it('rejects when the server cannot be reached', async () => {
    await expect(io.getText('http://127.0.0.1:1/', {})).rejects.toThrow();
  });
});

describe('io/http download', () => {
  it('saves the body to the file', async () => {
    const dest = tmpFile();
    await io.download(`${base}/file`, dest);
    expect(fs.readFileSync(dest, 'utf8')).toBe('file-bytes');
  });

  it('follows a redirect', async () => {
    const dest = tmpFile();
    await io.download(`${base}/redirect`, dest);
    expect(fs.readFileSync(dest, 'utf8')).toBe('file-bytes');
  });

  it('names the status of a refused download', async () => {
    await expect(io.download(`${base}/missing`, tmpFile())).rejects.toThrow('Download returned 404');
  });

  it('rejects when the server cannot be reached', async () => {
    await expect(io.download('http://127.0.0.1:1/', tmpFile())).rejects.toThrow();
  });
});
