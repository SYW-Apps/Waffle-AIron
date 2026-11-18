import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { devCommandsFor } from '../../src/commands/host.js';
import { buildProgram } from '../../src/cli/program.js';

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

describe('wairon dev family commands (sdd_cli)', () => {
  let dir: string;
  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* windows file locks */ }
  });

  const project = (): void => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-devfamily-'));
    fs.mkdirSync(path.join(dir, '.wai', 'specs'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.wai', 'project.yaml'), JSON.stringify({
      schemaVersion: '1.0.0', name: 'family-sys', projectType: 'backend',
      targets: [], rules: {}, createdAt: '2026-11-10T00:00:00Z', updatedAt: '2026-11-10T00:00:00Z',
    }));
  };

  it('runs a family command through the CLI parser, writing what the terminal would', async () => {
    project();
    const result = await devCommandsFor(dir, buildProgram).family({ action: 'network-declare', args: [], options: { description: 'the shop' }, report: false });
    expect(result.ok, result.output.join('\n')).toBe(true);
    expect(fs.readFileSync(path.join(dir, '.wai', 'project.yaml'), 'utf8')).toMatch(/the shop/);
  });

  it('answers an option the command does not define as a failed result, and leaves process.exit alone', async () => {
    project();
    const exit = process.exit;
    const result = await devCommandsFor(dir, buildProgram).family({ action: 'member-move', args: ['a', 'b'], options: { widen: 'true' }, report: false });
    expect(result.ok).toBe(false);
    expect(result.output.join('\n')).toMatch(/takes no --widen/);
    expect(process.exit).toBe(exit);
  });
});
