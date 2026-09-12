import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { saveSystemSpec, saveSubsystemSpec, invalidateSpecCache, computeGateStateId, readLockState } from '../../src/core/specs.js';
import { createChainedSubsystem } from '../../src/core/provision.js';
import { stateIdEquals } from '../../src/core/statehash.js';
import { writeLockRecord, type LockRecord } from '../../src/core/lockfile.js';
import type { SubsystemSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// The gate identity also digests the CONSUMED SURFACE SNAPSHOTS — the
// .wai/surfaces/*.yaml files of the bound root and of every chained mount root
// that validation can consult when resolving a cross-tree reference. Swapping
// a pinned contract can flip a verdict without moving the spec-tree digest, so
// without this coverage a lock keeps reading fresh under a changed contract.
//
// Item 6 of stage 1 (chained-subsystem correctness): computeGateStateId now
// reads those stored snapshots (this root's own, plus every chained root's),
// reduces each to a provenance-free content key, and hands them to
// hashGateState as `inputs`.
// ---------------------------------------------------------------------------

const now = '2026-09-12T10:00:00Z';

/** Minimal loadable tree: an L0 system and one subsystem — enough for
 *  computeGateStateId, which only needs a loadable tree, not a validated one. */
function buildRoot(rootDir: string, systemName = 'gate-inputs-sys'): void {
  fs.mkdirSync(path.join(rootDir, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, '.wai', 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0', name: systemName, projectType: 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {}, createdAt: now, updatedAt: now,
  }));
  setProjectRoot(rootDir);
  saveSystemSpec({
    schemaVersion: '1.0.0', name: systemName, vision: 'gate input fixture',
    boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now,
  });
  saveSubsystemSpec({
    id: 'dom', name: 'dom', description: 'the domain', parentSystem: systemName,
    publicInterfaces: [], trustedLinks: [], status: 'draft', createdAt: now, updatedAt: now,
  } as SubsystemSpec);
  invalidateSpecCache();
  setProjectRoot(rootDir);
}

/** Write a stored surface snapshot as raw YAML text, so the on-disk key order
 *  is exactly what the test dictates rather than whatever a round-trip
 *  through the schema would normalize it to. */
function writeRawSnapshot(rootDir: string, filename: string, yamlBody: string): void {
  const dir = path.join(rootDir, '.wai', 'surfaces');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), yamlBody);
}

/** A minimal, schema-valid snapshot with one interface whose `details` field
 *  carries the given marker — swapping the marker is "swapping the contract". */
const snapshotYaml = (opts: {
  projectName: string;
  detail: string;
  generatedAt?: string;
  stateId?: string;
  origin?: string;
}): string => `projectName: ${opts.projectName}
origin: ${opts.origin ?? 'authored'}
generatedAt: '${opts.generatedAt ?? '2026-09-01T00:00:00Z'}'
${opts.stateId ? `stateId: '${opts.stateId}'\n` : ''}interfaces:
  - id: iface1
    name: Iface1
    audience: instance
    type: Custom
    component: comp1
    methods:
      - name: op
        description: an operation
        signature: 'op(): void'
        returns: void
    details: ${opts.detail}
types: []
`;

/** Same logical content as `snapshotYaml`, but every mapping's keys are
 *  written in a DIFFERENT order — top-level and nested. */
const snapshotYamlReorderedKeys = (opts: { projectName: string; detail: string }): string => `types: []
generatedAt: '2026-09-01T00:00:00Z'
origin: authored
interfaces:
  - component: comp1
    methods:
      - returns: void
        signature: 'op(): void'
        description: an operation
        name: op
    details: ${opts.detail}
    type: Custom
    name: Iface1
    audience: instance
    id: iface1
projectName: ${opts.projectName}
`;

describe('the gate identity digests consumed surface snapshots', () => {
  let rootDir: string;
  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    if (rootDir) { try { fs.rmSync(rootDir, { recursive: true, force: true }); } catch { /* win file locks */ } }
  });

  it('swapping the BOUND ROOT\'s own stored snapshot changes computeGateStateId', () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-gateinputs-'));
    buildRoot(rootDir);
    writeRawSnapshot(rootDir, 'peer-a.yaml', snapshotYaml({ projectName: 'peer-a', detail: 'v1' }));

    const before = computeGateStateId();
    writeRawSnapshot(rootDir, 'peer-a.yaml', snapshotYaml({ projectName: 'peer-a', detail: 'v2' }));
    const after = computeGateStateId();

    expect(stateIdEquals(before, after)).toBe(false);
  });

  it('swapping a CHAINED MOUNT\'s stored snapshot changes computeGateStateId', () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-gateinputs-'));
    buildRoot(rootDir);
    createChainedSubsystem(
      { id: 'kid', name: 'kid', description: 'chained kid', parentSystem: 'gate-inputs-sys',
        publicInterfaces: [], trustedLinks: [], status: 'draft', createdAt: now, updatedAt: now,
        projectPath: 'packages/kid' } as SubsystemSpec,
      'kid',
    );
    invalidateSpecCache();
    setProjectRoot(rootDir);
    const kidRoot = path.join(rootDir, 'packages', 'kid');
    writeRawSnapshot(kidRoot, 'peer-b.yaml', snapshotYaml({ projectName: 'peer-b', detail: 'v1' }));

    const before = computeGateStateId();
    writeRawSnapshot(kidRoot, 'peer-b.yaml', snapshotYaml({ projectName: 'peer-b', detail: 'v2' }));
    const after = computeGateStateId();

    expect(stateIdEquals(before, after)).toBe(false);
  });

  it('re-saving the same content under a new generatedAt/stateId/origin does not change it', () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-gateinputs-'));
    buildRoot(rootDir);
    writeRawSnapshot(rootDir, 'peer-a.yaml', snapshotYaml({
      projectName: 'peer-a', detail: 'stable', generatedAt: '2026-09-01T00:00:00Z',
      stateId: 'sha256:aaaa', origin: 'authored',
    }));
    const before = computeGateStateId();

    // Same interfaces/types content; only the provenance fields moved — as a
    // re-pin of an UNCHANGED contract does.
    writeRawSnapshot(rootDir, 'peer-a.yaml', snapshotYaml({
      projectName: 'peer-a', detail: 'stable', generatedAt: '2026-09-11T23:00:00Z',
      stateId: 'sha256:bbbb', origin: 'generated',
    }));
    const after = computeGateStateId();

    expect(stateIdEquals(before, after)).toBe(true);
  });

  it('YAML key order (top-level and nested) does not change it', () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-gateinputs-'));
    buildRoot(rootDir);
    writeRawSnapshot(rootDir, 'peer-a.yaml', snapshotYaml({ projectName: 'peer-a', detail: 'stable' }));
    const before = computeGateStateId();

    writeRawSnapshot(rootDir, 'peer-a.yaml', snapshotYamlReorderedKeys({ projectName: 'peer-a', detail: 'stable' }));
    const after = computeGateStateId();

    expect(stateIdEquals(before, after)).toBe(true);
  });

  it('the algorithm is sha256+doctrine+inputs', () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-gateinputs-'));
    buildRoot(rootDir);
    expect(computeGateStateId().algorithm).toBe('sha256+doctrine+inputs');
  });

  it('a lock record carrying the retired sha256+doctrine identity reads STALE, never locked', () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-gateinputs-'));
    buildRoot(rootDir);

    // Exactly what a pre-upgrade lock record carries: same digest wairon would
    // compute now, but under the retired algorithm marker.
    const current = computeGateStateId();
    const legacyRecord: LockRecord = {
      stateId: { algorithm: 'sha256+doctrine', digest: current.digest },
      lockedAt: now,
      lockedBy: { id: 'tester <t@example.com>', source: 'git' },
      validatorVersion: 'test',
      validationResult: { valid: true, errors: 0, warnings: 0 },
      status: 'ready',
      specs: {},
      children: {},
    };
    writeLockRecord(legacyRecord);

    const { state, record } = readLockState();
    expect(state).toBe('stale');
    expect(record!.stateId.algorithm).toBe('sha256+doctrine');
  });
});
