import { describe, it, expect } from 'vitest';
import * as net from 'net';
import type { AddressInfo } from 'net';
import { chooseDevPort, DEV_PORT_FIRST, DEV_PORT_LAST } from '../../src/commands/host.js';

// ---------------------------------------------------------------------------
// `wairon dev` port choice: without --port it takes the first free pair from
// 8080 upward (the dev admin listener uses the next port), so a second
// project's dev server or anything else on 8080 never stops it; with --port it
// takes exactly that port and refuses plainly when it is taken.
// ---------------------------------------------------------------------------

function listen(port = 0): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function close(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('wairon dev port choice', () => {
  it('an explicit --port that is taken is refused with a plain message naming it', async () => {
    const busy = await listen();
    const port = (busy.address() as AddressInfo).port;
    try {
      await expect(chooseDevPort(String(port))).rejects.toThrow(`Port ${port} or ${port + 1}`);
    } finally {
      await close(busy);
    }
  });

  it('an explicit --port that is free is used as given', async () => {
    // Find a port whose neighbour is free too, then release both.
    for (let attempt = 0; attempt < 20; attempt++) {
      const probe = await listen();
      const port = (probe.address() as AddressInfo).port;
      await close(probe);
      if (port >= 65534) continue;
      try {
        const next = await listen(port + 1);
        await close(next);
      } catch {
        continue;
      }
      expect(await chooseDevPort(String(port))).toBe(port);
      return;
    }
    throw new Error('no free port pair found to test with');
  });

  it('a --port that is not a port number is refused', async () => {
    await expect(chooseDevPort('eighty')).rejects.toThrow('is not a port number');
  });

  it('without --port, a taken port is skipped for the next free pair in range', async () => {
    const first = await chooseDevPort();
    expect(first).toBeGreaterThanOrEqual(DEV_PORT_FIRST);
    expect(first).toBeLessThanOrEqual(DEV_PORT_LAST);
    if (first === DEV_PORT_LAST) return; // the range is nearly full on this machine; nothing more to show
    const busy = await listen(first);
    try {
      const next = await chooseDevPort();
      expect(next).toBeGreaterThan(first);
      expect(next).toBeLessThanOrEqual(DEV_PORT_LAST);
    } finally {
      await close(busy);
    }
  });
});
