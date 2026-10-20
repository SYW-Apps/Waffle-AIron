import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { cleanStaleBinary, swapRunningBinary } from '../../src/commands/update.js';

// ---------------------------------------------------------------------------
// The Windows self-update swap: the running exe is renamed aside and the new
// one copied into its slot. An earlier update's leftover that a process still
// runs from (an MCP server started before that update) cannot be removed and
// holds the `.old` name; the swap must move aside under a fresh name rather
// than fail on it. A process holding a file is simulated by a non-empty folder
// of that name, which neither unlink nor rename can replace.
// ---------------------------------------------------------------------------

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function bin(): { dir: string; exe: string; fresh: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-swap-'));
  dirs.push(dir);
  const exe = path.join(dir, 'wairon.exe');
  const fresh = path.join(dir, 'new-wairon.exe');
  fs.writeFileSync(exe, 'old build');
  fs.writeFileSync(fresh, 'new build');
  return { dir, exe, fresh };
}

describe('the self-update swap', () => {
  it('swaps the binary and removes the one it moved aside', () => {
    const { dir, exe, fresh } = bin();
    swapRunningBinary(fresh, exe);
    expect(fs.readFileSync(exe, 'utf8')).toBe('new build');
    expect(fs.readdirSync(dir).sort()).toEqual(['new-wairon.exe', 'wairon.exe']);
  });

  it('sweeps an earlier leftover it can remove before the swap', () => {
    const { dir, exe, fresh } = bin();
    fs.writeFileSync(`${exe}.old`, 'older build');
    fs.writeFileSync(`${exe}.old-1700000000000`, 'oldest build');
    swapRunningBinary(fresh, exe);
    expect(fs.readFileSync(exe, 'utf8')).toBe('new build');
    expect(fs.readdirSync(dir).sort()).toEqual(['new-wairon.exe', 'wairon.exe']);
  });

  it('moves aside under a fresh name when a held leftover keeps the .old name', () => {
    const { dir, exe, fresh } = bin();
    // Held: neither removable nor replaceable, like an exe a process still runs from.
    fs.mkdirSync(`${exe}.old`);
    fs.writeFileSync(path.join(`${exe}.old`, 'held'), '');
    swapRunningBinary(fresh, exe);
    expect(fs.readFileSync(exe, 'utf8')).toBe('new build');
    // The held leftover stays for a later sweep; nothing else is left behind.
    expect(fs.readdirSync(dir).sort()).toEqual(['new-wairon.exe', 'wairon.exe', 'wairon.exe.old']);
  });

  it('cleanStaleBinary removes only the leftovers of the executable named', () => {
    const { dir, exe } = bin();
    fs.writeFileSync(`${exe}.old`, '');
    fs.writeFileSync(`${exe}.old-42`, '');
    fs.writeFileSync(`${exe}.release-backup`, '');
    fs.writeFileSync(path.join(dir, 'other.exe.old'), '');
    cleanStaleBinary(exe);
    expect(fs.readdirSync(dir).sort()).toEqual(['new-wairon.exe', 'other.exe.old', 'wairon.exe', 'wairon.exe.release-backup']);
  });
});
