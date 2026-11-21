import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { saveSystemSpec, saveSpec, invalidateSpecCache } from '../../src/core/specs.js';
import { computeApprovalId } from '../../src/core/validation.js';
import { writeMemberProject } from '../helpers/member-project.js';
import { stateIdEquals } from '../../src/core/statehash.js';
import type { SubsystemSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// The gate identity also digests the CONSUMED SURFACE SNAPSHOTS — the
// .wai/surfaces/*.yaml files of the bound root and of every chained mount root
// that validation can consult when resolving a cross-tree reference. Swapping
// a pinned contract can flip a verdict without moving the spec-tree digest, so
// without this coverage a lock keeps reading fresh under a changed contract.
//
// Item 6 of stage 1 (chained-subsystem correctness): computeApprovalId reads
// those stored snapshots (this root's own, plus every chained root's) through
// core's consumedContractInputs, which reduces each to a provenance-free
// content key, and hands them to the gate identity as `inputs`.
// ---------------------------------------------------------------------------

const now = '2026-09-12T10:00:00Z';

/** Minimal loadable tree: an L0 system and one subsystem — enough for
 *  computeApprovalId, which only needs a loadable tree, not a validated one. */
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
  saveSpec('subsystem', {
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

describe('the approval identity digests nothing the project consumes', () => {
  let rootDir: string;
  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    if (rootDir) { try { fs.rmSync(rootDir, { recursive: true, force: true }); } catch { /* win file locks */ } }
  });

  it('swapping the bound root own stored snapshot leaves computeApprovalId alone', () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-gateinputs-'));
    buildRoot(rootDir);
    writeRawSnapshot(rootDir, 'peer-a.yaml', snapshotYaml({ projectName: 'peer-a', detail: 'v1' }));
    const before = computeApprovalId();
    writeRawSnapshot(rootDir, 'peer-a.yaml', snapshotYaml({ projectName: 'peer-a', detail: 'v2' }));
    expect(stateIdEquals(before, computeApprovalId())).toBe(true);
  });

  it('a pin recorded in the externals lock or the inputs lock never moves it', () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-gateinputs-'));
    buildRoot(rootDir);
    const before = computeApprovalId();
    fs.writeFileSync(path.join(rootDir, '.wai', 'inputs.lock.yaml'), ['externals: {}', 'packs: {}', ''].join('\n'));
    expect(stateIdEquals(before, computeApprovalId())).toBe(true);
  });

  it('swapping a member stored snapshot leaves the parent computeApprovalId alone', () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-gateinputs-'));
    buildRoot(rootDir);
    writeMemberProject(
      { id: 'kid', name: 'kid', description: 'chained kid', parentSystem: 'gate-inputs-sys',
        publicInterfaces: [], trustedLinks: [], status: 'draft', createdAt: now, updatedAt: now,
        projectPath: 'packages/kid' } as SubsystemSpec,
      'kid',
    );
    invalidateSpecCache();
    setProjectRoot(rootDir);
    const kidRoot = path.join(rootDir, 'packages', 'kid');
    writeRawSnapshot(kidRoot, 'peer-b.yaml', snapshotYaml({ projectName: 'peer-b', detail: 'v1' }));
    const before = computeApprovalId();
    writeRawSnapshot(kidRoot, 'peer-b.yaml', snapshotYaml({ projectName: 'peer-b', detail: 'v2' }));
    expect(stateIdEquals(before, computeApprovalId())).toBe(true);
  });

  it('a member re-locking never moves the parent identity', () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-gateinputs-'));
    buildRoot(rootDir);
    writeMemberProject(
      { id: 'kid', name: 'kid', description: 'chained kid', parentSystem: 'gate-inputs-sys',
        publicInterfaces: [], trustedLinks: [], status: 'draft', createdAt: now, updatedAt: now,
        projectPath: 'packages/kid' } as SubsystemSpec,
      'kid',
    );
    invalidateSpecCache();
    setProjectRoot(rootDir);
    const before = computeApprovalId();
    const kidRoot = path.join(rootDir, 'packages', 'kid');
    fs.writeFileSync(path.join(kidRoot, '.wai', 'lock.json'), JSON.stringify({ format: 4, parts: {}, specs: {}, stateId: { algorithm: 'sha256+design+policy', digest: 'e'.repeat(64) } }));
    expect(stateIdEquals(before, computeApprovalId())).toBe(true);
  });

  it('the algorithm is sha256+design+policy', () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-gateinputs-'));
    buildRoot(rootDir);
    expect(computeApprovalId().algorithm).toBe('sha256+design+policy');
  });
});
