import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache, holdsDesign } from '../../src/core/specs.js';
import { computeGateStateId, validateAsComplete, validateFamily, validateProject, familyApprovals } from '../../src/core/validation.js';
import { getStatusReport } from '../../src/core/status.js';
import { writeSpecFile } from '../../src/core/spec-files.js';
import { projectConfigRepositoryAt } from '../../src/config/project-config.js';
import { runLock, checkApproval, holdsNoDesign } from '../../src/commands/lock.js';
import { designOnly } from '../../src/models/lock.js';
import { SystemSpecSchema, SubsystemSpecSchema, TypeSpecSchema } from '../../src/models/index.js';
import { WAIRON_MAJOR, WAIRON_VERSION } from '../../src/config/defaults.js';

// ---------------------------------------------------------------------------
// A project whose design is types and an export table alone is approvable:
// one predicate (holdsDesign) answers lock, lock-check, status and the family
// check; an L0 with nothing below it has nothing approvable yet.
// ---------------------------------------------------------------------------

const STAMP = '2026-10-20T00:00:00.000Z';
const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  setProjectRoot(null);
  invalidateSpecCache();
  for (const d of dirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* windows locks */ }
  }
});

const specs = (dir: string, ...parts: string[]): string => path.join(dir, '.wai', 'specs', ...parts);

function project(dir: string, id: string, extra: Record<string, unknown> = {}): void {
  fs.mkdirSync(path.join(dir, '.wai'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.wai', 'project.yaml'), yaml.dump({
    schemaVersion: '1.0.0', waironMajor: WAIRON_MAJOR, id, name: id, targets: [], createdAt: STAMP, updatedAt: STAMP, ...extra,
  }));
}

function l0(dir: string, name: string, publicInterfaces: Record<string, unknown>[] = []): void {
  writeSpecFile(specs(dir, '.index.yaml'), SystemSpecSchema.parse({
    schemaVersion: '1.0.0', name, vision: `${name} in miniature`, boundaries: [], globalRequirements: [],
    ...(publicInterfaces.length ? { publicInterfaces } : {}), createdAt: STAMP, updatedAt: STAMP,
  }));
}

function rowType(dir: string, fields: string[]): void {
  writeSpecFile(specs(dir, 'types', 'row.yaml'), TypeSpecSchema.parse({
    kind: 'value-object', id: 'row', name: 'Row', description: 'A row',
    fields: fields.map((name) => ({ name, type: 'string', description: `The ${name}`, optional: false })),
    methods: [], status: 'complete', createdAt: STAMP, updatedAt: STAMP,
  }));
}

/** A types-only project: an L0 exporting one type, and that type. */
function typesOnly(dir: string, fields = ['a', 'b']): void {
  project(dir, 'tonly');
  l0(dir, 'Tonly', [{ typeDef: 'row', audience: 'project' }]);
  rowType(dir, fields);
}

function bind(dir: string): void {
  setProjectRoot(dir);
  invalidateSpecCache();
}

function lockAt(dir: string) {
  bind(dir);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const captured = computeGateStateId();
  const config = projectConfigRepositoryAt(dir).load();
  const gate = validateAsComplete({ rules: config?.rules, projectType: config?.projectType });
  expect(designOnly(gate).issues.filter((i) => i.severity === 'error')).toEqual([]);
  return runLock({ yes: true }, gate, captured);
}

const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-types-only-'));
  dirs.push(d);
  return d;
};

describe('holdsDesign', () => {
  it('fire: a type alone is design', () => {
    const dir = tmp();
    project(dir, 'tonly');
    l0(dir, 'Tonly');
    rowType(dir, ['a']);
    bind(dir);
    expect(holdsDesign()).toBe(true);
  });

  it('fire: an L0 export entry alone is design', () => {
    const dir = tmp();
    project(dir, 'tonly');
    l0(dir, 'Tonly', [{ details: 'A surface', audience: 'project' }]);
    bind(dir);
    expect(holdsDesign()).toBe(true);
  });

  it('fire: a subsystem is design', () => {
    const dir = tmp();
    project(dir, 'sub');
    l0(dir, 'Sub');
    writeSpecFile(specs(dir, 'core', '.index.yaml'), SubsystemSpecSchema.parse({
      id: 'core', name: 'core', description: 'Core', parentSystem: 'Sub', publicInterfaces: [], trustedLinks: [],
      status: 'complete', createdAt: STAMP, updatedAt: STAMP,
    }));
    bind(dir);
    expect(holdsDesign()).toBe(true);
  });

  it('control: an L0 with nothing below it holds no design', () => {
    const dir = tmp();
    project(dir, 'empty');
    l0(dir, 'Empty');
    bind(dir);
    expect(holdsDesign()).toBe(false);
    expect(holdsNoDesign()).toBe(true);
  });
});

describe('a types-only project is approved', () => {
  it('locks, lock-checks, and catches a field rename and a field reorder', () => {
    const dir = tmp();
    typesOnly(dir);
    bind(dir);
    expect(holdsNoDesign()).toBe(false);
    expect(lockAt(dir)).not.toBeNull();
    bind(dir);
    expect(checkApproval(true)).toMatchObject({ state: 'locked', approved: true });

    // A field renamed.
    rowType(dir, ['a', 'c']);
    bind(dir);
    expect(checkApproval(true)).toMatchObject({ state: 'stale', approved: false });

    // Back as approved, then only the declaration order moved.
    rowType(dir, ['a', 'b']);
    bind(dir);
    expect(checkApproval(true)).toMatchObject({ state: 'locked', approved: true });
    rowType(dir, ['b', 'a']);
    bind(dir);
    expect(checkApproval(true)).toMatchObject({ state: 'stale', approved: false });
  });

  it('control: an L0-only project locks nothing, saying nothing is approvable yet (no remedy to add a subsystem)', () => {
    const dir = tmp();
    project(dir, 'empty');
    l0(dir, 'Empty');
    bind(dir);
    const check = checkApproval(true);
    expect(check.state).toBe('unlocked');
    expect(check.message).toContain('Nothing approvable yet');
    expect(check.message).not.toContain('Add a subsystem');
    expect(check.message).not.toContain('add a subsystem');
  });

  it('status reads a never-approved types-only tree as never approved, and an empty L0 as nothing approvable yet', () => {
    const typed = tmp();
    typesOnly(typed);
    bind(typed);
    const typedReport = getStatusReport({ approvals: familyApprovals() });
    expect(typedReport.text).toContain('Approval: this project is never approved');
    expect(typedReport.text).not.toContain('nothing approvable yet');
    expect(typedReport.validatorVersion).toBe(WAIRON_VERSION);

    const empty = tmp();
    project(empty, 'empty');
    l0(empty, 'Empty');
    bind(empty);
    const emptyReport = getStatusReport({ approvals: familyApprovals() });
    expect(emptyReport.text).toContain('Approval: nothing approvable yet');
    expect(emptyReport.text).not.toContain('add a subsystem');
  });
});

describe('the family check on members with nothing approvable', () => {
  const family = (): string => {
    const top = tmp();
    project(top, 'top', { members: { tonly: './tonly', lonly: './lonly' } });
    l0(top, 'Top');
    typesOnly(path.join(top, 'tonly'));
    project(path.join(top, 'lonly'), 'lonly');
    l0(path.join(top, 'lonly'), 'Lonly');
    // A subsystem keeps the parent itself approvable.
    writeSpecFile(specs(top, 'app', '.index.yaml'), SubsystemSpecSchema.parse({
      id: 'app', name: 'app', description: 'App', parentSystem: 'Top', publicInterfaces: [], trustedLinks: [],
      status: 'complete', createdAt: STAMP, updatedAt: STAMP,
    }));
    return top;
  };

  it('an L0-only member is MEMBER_NOTHING_APPROVABLE (notice); a types-only member stays MEMBER_UNAPPROVED (warning)', () => {
    const top = family();
    bind(top);
    const approvals = familyApprovals();
    expect(approvals.find((a) => a.key === 'lonly')?.approvable).toBe(false);
    expect(approvals.find((a) => a.key === 'tonly')?.approvable).toBe(true);
    const result = validateFamily({ family: true });
    const nothing = result.issues.filter((i) => i.code === 'MEMBER_NOTHING_APPROVABLE');
    expect(nothing).toHaveLength(1);
    expect(nothing[0].severity).toBe('notice');
    expect(nothing[0].message).toContain('lonly');
    const unapproved = result.issues.filter((i) => i.code === 'MEMBER_UNAPPROVED');
    expect(unapproved).toHaveLength(1);
    expect(unapproved[0].message).toContain('tonly');
    expect(unapproved[0].severity).toBe('warning');
  });
});

describe('validatorVersion', () => {
  it('rides every validation entry point', () => {
    const dir = tmp();
    typesOnly(dir);
    bind(dir);
    expect(validateProject().validatorVersion).toBe(WAIRON_VERSION);
    expect(validateAsComplete().validatorVersion).toBe(WAIRON_VERSION);
    expect(validateFamily({ family: true }).validatorVersion).toBe(WAIRON_VERSION);
  });
});
