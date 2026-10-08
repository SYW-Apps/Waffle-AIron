import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readLockRecordAt } from '../../src/core/lockfile.js';
import { findOrphanedSpecFiles } from '../../src/core/specs.js';
import { LockRecordUnreadableError } from '../../src/utils/errors.js';
import { runWithProjectRoot } from '../../src/utils/fs.js';

// Round-5 trial (tinkerer M1, M2): a lock record that EXISTS but cannot be
// read was answered as no record at all (null), so plain `lock-check` passed
// a truncated merge; and a specs folder whose L0 was deleted read as an empty
// tree. Both fail closed now.

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-lock-integrity-'));
  fs.mkdirSync(path.join(root, '.wai'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const VALID = { stateId: { algorithm: 'design-v3', digest: 'abc' }, lockedAt: 't', lockedBy: 'local:me', validatorVersion: '1', validationResult: { valid: true, errors: 0, warnings: 0 }, status: 'ready', format: 3, specs: { 'a.yaml': 'd' } };

function write(content: string): void {
  fs.writeFileSync(path.join(root, '.wai', 'lock.json'), content);
}

describe('readLockRecordAt — absent is null, present-but-unreadable is refused', () => {
  it('answers null only when there is no file', () => {
    expect(readLockRecordAt(root)).toBeNull();
  });

  it.each([
    ['a truncated object', '{', 'it is not valid JSON'],
    ['JSON null', 'null', 'it holds null, not a lock record object'],
    ['an empty file', '', 'the file is empty'],
    ['a BOM alone', '﻿', 'the file is empty'],
    ['a string', '"str"', 'it holds a string'],
    ['an array', '[]', 'it holds an array'],
    ['an object with no gate identity', '{"formatVersion": 99}', 'it records no gate identity'],
    ['a newer format', JSON.stringify({ ...VALID, format: 99 }), 'it is lock record format 99, written by a newer wairon'],
    ['a malformed format', JSON.stringify({ ...VALID, format: 'x' }), 'its "format" is "x"'],
    ['specs that are no digest map', JSON.stringify({ ...VALID, specs: ['a'] }), 'its "specs" is not a map'],
  ])('%s', (_what, content, reason) => {
    write(content);
    let thrown: unknown;
    try {
      readLockRecordAt(root);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(LockRecordUnreadableError);
    expect((thrown as Error).message).toContain(reason);
    expect((thrown as Error).message).toContain('cannot be read as an approval record');
    expect((thrown as Error).message).toContain('wairon never overwrites a record it cannot read');
  });

  it('reads a valid record, and the same record behind an editor BOM', () => {
    write(JSON.stringify(VALID));
    expect(readLockRecordAt(root)?.stateId.digest).toBe('abc');
    write(`﻿${JSON.stringify(VALID)}`);
    expect(readLockRecordAt(root)?.stateId.digest).toBe('abc');
  });
});

describe('findOrphanedSpecFiles — spec files under a specs folder that lost its L0', () => {
  const specs = (): string => path.join(root, '.wai', 'specs');

  it('names the files left standing when the L0 is gone', () => {
    fs.mkdirSync(path.join(specs(), 'habits', 'habit_portal'), { recursive: true });
    fs.writeFileSync(path.join(specs(), 'habits', '.index.yaml'), 'id: habits\n');
    fs.writeFileSync(path.join(specs(), 'habits', 'habit_portal', '.index.yaml'), 'id: habit_portal\n');
    const found = runWithProjectRoot(root, () => findOrphanedSpecFiles());
    expect(found).toEqual(['.wai/specs/habits/.index.yaml', '.wai/specs/habits/habit_portal/.index.yaml']);
  });

  it('is empty while the L0 is there, and for a folder with nothing in it', () => {
    fs.mkdirSync(specs(), { recursive: true });
    expect(runWithProjectRoot(root, () => findOrphanedSpecFiles())).toEqual([]);
    // A READABLE L0 (round 6: one that does not read leaves the tree as unjudged as a deleted one).
    fs.writeFileSync(path.join(specs(), '.index.yaml'), 'schemaVersion: "1.0.0"\nname: X\nvision: a readable L0\nboundaries: []\nglobalRequirements: []\ncreatedAt: "2026-01-01T00:00:00.000Z"\nupdatedAt: "2026-01-01T00:00:00.000Z"\n');
    fs.mkdirSync(path.join(specs(), 'habits'), { recursive: true });
    fs.writeFileSync(path.join(specs(), 'habits', '.index.yaml'), 'id: habits\n');
    expect(runWithProjectRoot(root, () => findOrphanedSpecFiles())).toEqual([]);
    // The same tree under an L0 that cannot be read is a tree whose root is broken.
    fs.writeFileSync(path.join(specs(), '.index.yaml'), 'name: X\n');
    expect(runWithProjectRoot(root, () => findOrphanedSpecFiles())).toEqual(['.wai/specs/habits/.index.yaml']);
  });
});
