import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { devCommandsFor } from '../../src/commands/host.js';

// ---------------------------------------------------------------------------
// The commands `wairon dev` hands its server: the CLI's own, with what they
// print captured and a failure (an error or an exit) reported as a result,
// never an ended process.
// ---------------------------------------------------------------------------

describe('wairon dev commands (sdd_cli)', () => {
  let dir: string;
  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* windows file locks */ }
  });

  it('answers a lock that cannot run as a failed result with the reason, and leaves process.exit and the console alone', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-devcmd-'));
    const exit = process.exit;
    const log = console.log;
    const result = await devCommandsFor(dir).lock(null);
    expect(result.command).toBe('lock');
    expect(result.ok).toBe(false);
    expect(result.output.length).toBeGreaterThan(0);
    // eslint-disable-next-line no-control-regex
    expect(result.output.join('\n')).not.toMatch(/\u001b\[/);
    expect(process.exit).toBe(exit);
    expect(console.log).toBe(log);
  });
});
