import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { writeSpecFile } from '../../src/core/spec-files.js';
import { ImplementationSpecSchema, InterfaceSpecSchema } from '../../src/models/index.js';
import * as migrations from '../../src/migrations/index.js';
import * as transaction from '../../src/migrations/transaction.js';
import { plan as planChaining, isEmpty } from '../../src/migrations/chaining-migration.js';
import type { MigrationPlan } from '../../src/migrations/types.js';
import { buildReferenceFamily, type ReferenceFamily } from '../helpers/reference-family.js';

// ---------------------------------------------------------------------------
// Stage 6 — the chaining migration on the family transaction, through the
// migration portal, over the reference family (Waffler's shape in miniature:
// a top root, a legacy-mounted vocabulary member, and a member with a member
// of its own). Real temp directories; nothing mocked.
//
// Covered: plan writes nothing and apply commits the rehearsal's difference;
// the rehearsal precondition (no writer reads source code); an unfinished
// transaction refuses the next plan; the pending-transaction banner in the CLI
// (`status`, `validate`, `doctor`) and in MCP (sdd_get_status,
// sdd_validate_tree); and `doctor --fix` rolling a crash back first.
// ---------------------------------------------------------------------------

const execFileP = promisify(execFile);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const WAIRON_CLI = path.join(REPO_ROOT, 'src', 'cli', 'index.ts');
const STAMP = '2026-09-30T00:00:00.000Z';

/** `wairon …` in a real process with its home redirected (doctor writes global config); resolves whatever the exit code. */
function cli(cwd: string, home: string, ...args: string[]): Promise<{ stdout: string; code: number }> {
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData'), NO_COLOR: '1', FORCE_COLOR: '0' };
  return execFileP(process.execPath, [TSX_CLI, WAIRON_CLI, ...args], { cwd, env, timeout: 180_000 })
    .then((r) => ({ stdout: r.stdout, code: 0 }))
    .catch((e: Error & { stdout?: string; code?: number }) => ({ stdout: e.stdout ?? '', code: typeof e.code === 'number' ? e.code : 1 }));
}

/** Every file under a root by digest, source excluded — the .wai trees' bytes. */
function waiState(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (entry.isDirectory()) walk(full);
      else if (rel.includes('.wai/')) out[rel] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  };
  walk(root);
  return out;
}

/** Give transpiler an implementation whose sourcePath names a source file — the kind of thing a writer must never read. */
function addImplementation(f: ReferenceFamily): void {
  const specs = path.join(f.transpiler, '.wai', 'specs', 'lowering', 'lowering-core');
  writeSpecFile(path.join(specs, '.interface.yaml'), InterfaceSpecSchema.parse({
    id: 'ilowering-core', name: 'ilowering-core', description: 'The lowering core contract', component: 'lowering-core',
    methods: [{ name: 'lower', description: 'Lower one unit', signature: 'lower(): void', returns: 'void', params: [] }],
    status: 'complete', createdAt: STAMP, updatedAt: STAMP,
  }));
  writeSpecFile(path.join(specs, '.implementation.yaml'), ImplementationSpecSchema.parse({
    id: 'lowering-core-impl', name: 'lowering-core-impl', description: 'Lowers', contract: 'ilowering-core', sourcePath: 'src/lowering.ts',
    methods: [{ name: 'lower', narrative: [{ stepNumber: 1, type: 'call', description: 'Ask the engine', targetComponent: 'super::engine-portal', targetMethod: 'run' }] }],
    status: 'complete', createdAt: STAMP, updatedAt: STAMP,
  }));
}

const at = <T>(dir: string, fn: () => T): T => {
  invalidateSpecCache();
  setProjectRoot(dir);
  return fn();
};

/**
 * The plan's file changes as comparable lines: owner relative to the family,
 * path, action and digest — a pin's snapshot stamps the time it was generated
 * (`generatedAt`), so its digest is left out and its presence compared.
 */
const changeLines = (p: MigrationPlan, top: string): string[] =>
  p.changes.map((c) => `${path.relative(top, c.project).split(path.sep).join('/') || '.'}|${c.path}|${c.action}|${c.path.startsWith('.wai/externals/') ? 'snapshot' : c.stagedDigest ?? '-'}`);

describe('stage 6 — the chaining migration on the family transaction', () => {
  const made: ReferenceFamily[] = [];
  const family = (): ReferenceFamily => {
    const f = buildReferenceFamily();
    made.push(f);
    return f;
  };

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setProjectRoot(null);
    invalidateSpecCache();
    for (const f of made.splice(0)) {
      try { f.cleanup(); } catch { /* windows locks */ }
    }
  });

  it('plan rehearses on a copy and writes nothing into the family; apply commits exactly the plan; the next plan is empty', () => {
    const f = family();
    const before = waiState(f.top);
    const planned = at(f.core, () => migrations.plan({ verb: 'chaining' }));
    expect(planned.refusals).toEqual([]);
    expect(planned.rehearsal?.directory.startsWith(os.tmpdir())).toBe(true);
    expect(planned.changes.length).toBeGreaterThan(0);
    // Writes nothing into the family.
    expect(waiState(f.top)).toEqual(before);
    const report = at(f.core, () => migrations.apply(planned));
    expect(report.applied).toBe(true);
    expect(report.outcome?.committed).toBe(true);
    expect(fs.existsSync(planned.rehearsal!.directory)).toBe(false);
    // Exactly the plan's files moved, each to its staged bytes.
    const after = waiState(f.top);
    for (const c of planned.changes) {
      const rel = path.relative(f.top, path.join(c.project, ...c.path.split('/'))).split(path.sep).join('/');
      expect(after[rel] === undefined ? '-' : `sha256:${after[rel]}`).toBe(c.stagedDigest ?? '-');
    }
    const moved = new Set(planned.changes.map((c) => path.relative(f.top, path.join(c.project, ...c.path.split('/'))).split(path.sep).join('/')));
    for (const [rel, digest] of Object.entries(before)) if (!moved.has(rel)) expect(after[rel]).toBe(digest);
    // Nothing of the rehearsal leaks into a live file, and no transaction is left.
    for (const rel of Object.keys(after)) expect(fs.readFileSync(path.join(f.top, rel), 'utf8')).not.toContain('wairon-migration-');
    expect(Object.keys(after).some((rel) => rel.includes('.wai/transactions'))).toBe(false);
    // Idempotence: the migration re-plans empty, and applying that plan does nothing.
    expect(isEmpty(at(f.top, () => planChaining()))).toBe(true);
    const again = at(f.top, () => migrations.plan({ verb: 'chaining' }));
    expect(again.changes).toEqual([]);
    expect(at(f.top, () => migrations.apply(again))).toMatchObject({ applied: false, relock: [] });
  });

  it('a plan made without a rehearsal (doctor\'s, confirmed as printed) is rehearsed at apply and committed', () => {
    const f = family();
    const planned = at(f.top, () => migrations.plan({ verb: 'chaining', rehearse: false }));
    expect(planned.rehearsal).toBeUndefined();
    expect(planned.changes).toEqual([]);
    expect(planned.chaining && !isEmpty(planned.chaining)).toBe(true);
    const report = at(f.top, () => migrations.apply(planned));
    expect(report.applied).toBe(true);
    expect(report.outcome?.written.length).toBeGreaterThan(0);
    expect(isEmpty(at(f.top, () => planChaining()))).toBe(true);
  });

  it('the rehearsal precondition: no writer on these paths reads source code — absent or unreadable sources plan the same bytes', () => {
    const withSource = family();
    addImplementation(withSource);
    fs.mkdirSync(path.join(withSource.transpiler, 'src'), { recursive: true });
    fs.writeFileSync(path.join(withSource.transpiler, 'src', 'lowering.ts'), 'export function lower(): void { /* real code */ }\n');
    const unreadable = family();
    addImplementation(unreadable);
    // A directory where the source file should be: every read of it throws.
    fs.mkdirSync(path.join(unreadable.transpiler, 'src', 'lowering.ts'), { recursive: true });
    const absent = family();
    addImplementation(absent);

    const a = at(withSource.top, () => migrations.plan({ verb: 'chaining' }));
    const b = at(unreadable.top, () => migrations.plan({ verb: 'chaining' }));
    const c = at(absent.top, () => migrations.plan({ verb: 'chaining' }));
    for (const p of [a, b, c]) {
      expect(p.refusals).toEqual([]);
      migrations.discard(p);
    }
    expect(a.changes.length).toBeGreaterThan(0);
    // The implementation's own spec is among the rewritten ones — the writer re-saved it without its code.
    expect(a.changes.some((ch) => ch.path.endsWith('lowering-core/.implementation.yaml'))).toBe(true);
    expect(changeLines(b, unreadable.top)).toEqual(changeLines(a, withSource.top));
    expect(changeLines(c, absent.top)).toEqual(changeLines(a, withSource.top));
  });

  it('an unfinished transaction refuses the next plan (transaction-pending) until it is recovered', () => {
    const f = family();
    const before = waiState(f.top);
    const planned = at(f.top, () => migrations.plan({ verb: 'chaining' }));
    // Staged, then the process died: journals and backups on disk, nothing swapped.
    transaction.stage(planned.rehearsal!, planned.changes, 'chaining');
    const refused = at(f.transpiler, () => migrations.plan({ verb: 'chaining' }));
    expect(refused.refusals.map((r) => r.code)).toEqual(['transaction-pending']);
    expect(refused.refusals[0].detail).toContain('wairon doctor --fix');
    expect(refused.rehearsal).toBeUndefined();
    expect(at(f.top, () => migrations.apply(refused)).applied).toBe(false);
    // Recovered from the root: the family is as it was, and the plan is back.
    const recovered = migrations.recover(f.top, true);
    expect(recovered.map((r) => r.action)).toEqual(['rolled-back']);
    transaction.discard(planned.rehearsal!);
    expect(waiState(f.top)).toEqual(before);
    const replanned = at(f.top, () => migrations.plan({ verb: 'chaining' }));
    expect(changeLines(replanned, f.top)).toEqual(changeLines(planned, f.top));
    migrations.discard(replanned);
  });
});

describe('stage 6 — the pending-transaction banner and doctor --fix', () => {
  let f: ReferenceFamily;
  let home: string;
  let before: Record<string, string>;
  let touched: { file: string; base?: string }[];

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    f = buildReferenceFamily();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-home-'));
    before = waiState(f.top);
    const planned = at(f.top, () => migrations.plan({ verb: 'chaining' }));
    // Staged and half-swapped by hand: the coordinator reads swapping, the first owner's files are in.
    const journals = transaction.stage(planned.rehearsal!, planned.changes, 'chaining');
    journals[0].phase = 'swapping';
    touched = planned.changes.map((c) => ({ file: path.join(c.project, ...c.path.split('/')), base: c.baseDigest }));
    try {
      transaction.swap(journals.slice(0, 1));
    } finally {
      transaction.discard(planned.rehearsal!);
    }
    setProjectRoot(null);
    invalidateSpecCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of [f.top, home]) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* windows locks */ }
    }
  });

  it('CLI: status and validate lead with a notice naming the transaction; plain doctor reports it; doctor --fix rolls it back first', async () => {
    expect(waiState(f.top)).not.toEqual(before);
    const status = await cli(f.top, home, 'status');
    expect(status.stdout).toMatch(/\[TRANSACTION_PENDING\] an unfinished family migration \(chaining, transaction [0-9a-f]{8}, coordinator phase swapping\) — run `wairon doctor --fix`/);
    const validate = await cli(f.top, home, 'validate');
    expect(validate.stdout).toMatch(/\[TRANSACTION_PENDING\]/);
    // From a member's root too: its journal names the coordinator.
    const fromMember = await cli(f.core, home, 'validate');
    expect(fromMember.stdout).toMatch(/\[TRANSACTION_PENDING\]/);
    const doctor = await cli(f.top, home, 'doctor');
    expect(doctor.stdout).toMatch(/Unfinished family migration [0-9a-f]{8} \(chaining, coordinator phase swapping/);
    expect(doctor.code).not.toBe(0);

    // --fix without --yes: the rollback runs first; the chaining migration itself is not confirmed, so not applied.
    const fixed = await cli(f.top, home, 'doctor', '--fix');
    expect(fixed.stdout).toMatch(/Rolled back the chaining migration [0-9a-f]{8} \(coordinator phase swapping\)/);
    for (const t of touched) {
      const now = fs.existsSync(t.file) ? `sha256:${crypto.createHash('sha256').update(fs.readFileSync(t.file)).digest('hex')}` : undefined;
      expect(now).toBe(t.base);
    }
    for (const dir of [f.top, f.shared, f.core, f.transpiler]) expect(fs.existsSync(path.join(dir, '.wai', 'transactions'))).toBe(false);
    const clean = await cli(f.top, home, 'status');
    expect(clean.stdout).not.toContain('TRANSACTION_PENDING');
  }, 300_000);

  it('MCP: sdd_get_status leads with the banner and sdd_validate_tree lists it as a notice', async () => {
    const client = new Client({ name: 'wairon-banner-test', version: '0.0.1' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [TSX_CLI, WAIRON_CLI, 'mcp', 'serve'],
      cwd: f.top,
      env: { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData') } as Record<string, string>,
      stderr: 'ignore',
    });
    await client.connect(transport);
    try {
      const status: any = await client.callTool({ name: 'sdd_get_status', arguments: {} });
      const text = status.content.map((c: any) => c.text).join('\n');
      expect(text).toMatch(/TRANSACTION PENDING: an unfinished family migration \(chaining, transaction [0-9a-f]{8}, coordinator phase swapping\)/);
      expect(text.indexOf('TRANSACTION PENDING')).toBeLessThan(Math.max(text.indexOf('System'), 1));
      const validated: any = await client.callTool({ name: 'sdd_validate_tree', arguments: {} });
      const notices = validated.structuredContent?.notices ?? [];
      const banner = notices.find((n: any) => n.code === 'TRANSACTION_PENDING');
      expect(banner?.severity).toBe('notice');
      expect(banner?.message).toContain('wairon doctor --fix');
      expect((validated.structuredContent?.errors ?? []).some((e: any) => e.code === 'TRANSACTION_PENDING')).toBe(false);
    } finally {
      try { await client.close(); } catch { /* already gone */ }
    }
  }, 120_000);
});
