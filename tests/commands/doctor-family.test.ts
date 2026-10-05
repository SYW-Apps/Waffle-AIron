import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { writeSpecFile } from '../../src/core/spec-files.js';
import { TypeSpecSchema } from '../../src/models/index.js';
import { runDoctor } from '../../src/commands/doctor.js';
import { buildImportFamily, type ImportFamily } from '../helpers/reference-family.js';

// ---------------------------------------------------------------------------
// `wairon doctor` at a family's top: the report counts every member's
// findings (a clean top never reads as a clean family) and names each member
// with repairs pending, and `--fix` cascades the per-project repairs into
// every member inside the root — the way the family run validates them.
// ---------------------------------------------------------------------------

const STAMP = '2026-10-05T00:00:00.000Z';

/** A type of app's, stored with TypeScript spellings the grammar respells. */
function staleMemberType(f: ImportFamily): string {
  const file = path.join(f.app, '.wai', 'specs', 'types', 'tally.yaml');
  writeSpecFile(file, TypeSpecSchema.parse({
    kind: 'value-object', id: 'tally', name: 'tally', description: 'A tally',
    fields: [{ name: 'labels', type: 'string[]', description: 'The labels', optional: false }, { name: 'open', type: 'boolean', description: 'Open', optional: false }],
    methods: [], createdAt: STAMP, updatedAt: STAMP,
  }));
  return file;
}

describe('doctor at a family top', () => {
  let family: ImportFamily | null = null;
  let packs = '';
  const originalCwd = process.cwd();

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    packs = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-doctor-family-packs-'));
    process.env.WAIRON_PACKS_DIR = packs;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    setProjectRoot(null);
    invalidateSpecCache();
    delete process.env.WAIRON_PACKS_DIR;
    family?.cleanup();
    family = null;
    fs.rmSync(packs, { recursive: true, force: true });
  });

  const printed = (): string => (console.log as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0])).join('\n');

  it('reports the family\'s findings, per member, and the members\' pending repairs', async () => {
    family = buildImportFamily();
    staleMemberType(family);
    process.chdir(family.top);
    setProjectRoot(family.top);
    invalidateSpecCache();
    await runDoctor({});
    const out = printed();
    expect(out).not.toContain('Conformance: 0 errors, 0 warnings');
    expect(out).toMatch(/member app: \d+ error\(s\), \d+ warning\(s\)/);
    expect(out).toMatch(/member app: .*2 type position\(s\) to respell.*`wairon doctor --fix` here cascades into it/);
  });

  it('--fix cascades the type-spelling repair into a member inside the root', async () => {
    family = buildImportFamily();
    const file = staleMemberType(family);
    process.chdir(family.top);
    setProjectRoot(family.top);
    invalidateSpecCache();
    await runDoctor({ fix: true, yes: true });
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('type: list<string>');
    expect(text).toContain('type: bool');
    expect(printed()).toMatch(/\[app\] Rewrote 2 type position\(s\) in 1 spec\(s\)/);
  });
});
