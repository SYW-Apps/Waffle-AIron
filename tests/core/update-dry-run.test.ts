import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  saveSubsystemSpec,
  saveComponentSpec,
  saveInterfaceSpec,
  saveImplementationSpec,
  updateSpec,
  invalidateSpecCache,
} from '../../src/core/specs.js';
import { updateSpecGated } from '../../src/core/authoring.js';

// ---------------------------------------------------------------------------
// The two halves of an update that tells the truth about itself.
//
// DRY RUN: the delta wave wanted a name for the merged spec that exists only
// between the merge and the save. It does exist — for the length of one call —
// and a caller who can ask for it can read a 40-step renumber before wearing it.
// The bar it has to clear is that it can never be mistaken for a write: the
// file's BYTES are what this asserts, not its parsed contents.
//
// INEFFECTIVE: the delta is a permissive record by design, so the top-level
// unknown-key refusal cannot reach one depth down. What it can do is say, after
// the fact, which of the paths it was given landed nowhere. The risk in that is
// the opposite of a silence — a false accusation — so most of what follows is
// about the things it must NOT name: an address, a label twin, a step a delta
// renumbered.
// ---------------------------------------------------------------------------

const now = new Date().toISOString();
let projects: string[] = [];

function seed(): string {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-dryrun-'));
  projects.push(proj);
  fs.mkdirSync(path.join(proj, '.wai', 'specs'), { recursive: true });
  setProjectRoot(proj);
  saveSubsystemSpec({
    schemaVersion: '1.0.0', id: 'billing', name: 'Billing', description: 'Billing',
    parentSystem: 'GK', publicInterfaces: [], createdAt: now, updatedAt: now,
  });
  saveComponentSpec({
    id: 'flow_comp', name: 'Flow', description: 'The flow', subsystem: 'billing',
    componentType: 'Orchestrator', owns: [], dependsOn: [], status: 'complete',
    createdAt: now, updatedAt: now,
  });
  saveInterfaceSpec({
    id: 'iflow', name: 'IFlow', description: 'The flow contract', component: 'flow_comp',
    methods: [{
      name: 'run', description: 'runs the flow', signature: 'run(payload: string)', returns: 'void',
      params: [{ name: 'payload', type: 'string', description: 'what to run' }],
    }],
    status: 'complete', createdAt: now, updatedAt: now,
  });
  saveImplementationSpec({
    id: 'flow_impl', name: 'FlowImpl', description: 'The flow implementation', contract: 'iflow',
    methods: [{
      name: 'run',
      narrative: [
        { stepNumber: 1, description: 'Look at the payload', type: 'local', label: 'start' },
        { stepNumber: 2, description: 'Is it empty?', type: 'branch', condition: 'the payload is empty', onFalseStep: 4 },
        { stepNumber: 3, description: 'Give up', type: 'return', outcome: 'nothing to do' },
        { stepNumber: 4, description: 'Do the work', type: 'local' },
      ],
    } as never],
    status: 'complete', createdAt: now, updatedAt: now,
  });
  invalidateSpecCache();
  return proj;
}

/** The stored file for a spec, found wherever the layout put it. */
function specFile(root: string, stem: string): string {
  const walk = (dir: string): string | null => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === stem) {
          for (const leaf of ['.index.yaml', '.interface.yaml', '.implementation.yaml']) {
            if (fs.existsSync(path.join(full, leaf))) return path.join(full, leaf);
          }
        }
        const deeper = walk(full);
        if (deeper) return deeper;
      } else if (entry.name === `${stem}.yaml`) {
        return full;
      }
    }
    return null;
  };
  const found = walk(path.join(root, '.wai', 'specs'));
  if (!found) throw new Error(`no stored file for "${stem}"`);
  return found;
}

afterEach(() => {
  for (const p of projects) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* windows file locks */ }
  }
  projects = [];
  invalidateSpecCache();
});

describe('a dry run is an account, never a write', () => {
  it('reports the changes it would make and leaves the stored bytes identical', () => {
    const proj = seed();
    const file = specFile(proj, 'flow_comp');
    const before = fs.readFileSync(file);

    const report = updateSpec('component', 'flow_comp', {
      description: 'A description no dry run may persist',
      dependsOn: ['other_comp'],
    }, undefined, true);

    expect(report.dryRun).toBe(true);
    expect(report.written).toBe(false);
    expect(report.changes.map(c => c.path).sort()).toEqual(['dependsOn', 'description']);
    expect(report.summary).toContain('Dry run');
    // Byte-exact: an updatedAt restamp would make this fail, which is the point.
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });

  it('a dry run that would change nothing says so, and still answers as a dry run', () => {
    seed();
    const report = updateSpec('component', 'flow_comp', { description: 'The flow' }, undefined, true);
    expect(report.dryRun).toBe(true);
    expect(report.written).toBe(false);
    expect(report.changes).toEqual([]);
    expect(report.summary).toContain('nothing would be written');
  });

  it('the same delta without the flag writes, and reports itself as a write', () => {
    const proj = seed();
    const file = specFile(proj, 'flow_comp');
    const before = fs.readFileSync(file);

    const report = updateSpec('component', 'flow_comp', { description: 'Persisted after all' });
    expect(report.dryRun).toBe(false);
    expect(report.written).toBe(true);
    expect(fs.readFileSync(file).equals(before)).toBe(false);
  });

  it('runs the write-boundary gate, so an account of a refused write is a refusal', () => {
    const proj = seed();
    const file = specFile(proj, 'flow_comp');
    const before = fs.readFileSync(file);

    // portalType on an Orchestrator is refused by the candidate gate. A dry run
    // that answered "2 changes would be made" here would be an account of a
    // write that could never happen.
    expect(() => updateSpecGated('component', 'flow_comp', { portalType: 'HTTP_API' }, true))
      .toThrow(/UNEXPECTED_PORTAL_FIELD|portalType/);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });
});

describe('an update names the delta paths it did not act on', () => {
  it('names a key that is not a field one level down, and still performs the rest', () => {
    seed();
    const report = updateSpec('interface', 'iflow', {
      methods: [{ name: 'run', descriptoin: 'the typo that used to vanish', returns: 'string' }],
    });
    expect(report.written).toBe(true);
    expect(report.ineffective).toContain('methods.run.descriptoin — the level does not have this field, so the write dropped it');
    expect(report.changes.map(c => c.path)).toContain('methods.run.returns');
  });

  it('names a key nested two levels down, inside an array element of an element', () => {
    seed();
    const report = updateSpec('interface', 'iflow', {
      methods: [{ name: 'run', params: [{ name: 'payload', typ: 'number' }] }],
    });
    expect(report.ineffective).toContain('methods.run.params.payload.typ — the level does not have this field, so the write dropped it');
  });

  it('names a value the stored spec already held', () => {
    seed();
    const report = updateSpec('component', 'flow_comp', { description: 'The flow', name: 'Flow v2' });
    expect(report.ineffective).toContain('description — the stored spec already held this value');
    expect(report.changes.map(c => c.path)).toEqual(['name']);
  });

  it('names an unset that removed nothing, and stays quiet about one that did', () => {
    seed();
    updateSpec('component', 'flow_comp', { basePath: '/v1' });
    const report = updateSpec('component', 'flow_comp', { unset: ['basePath', 'variant'] });
    expect(report.ineffective).toEqual(['variant — unset named a field the stored spec did not have']);
    expect(report.changes.map(c => c.path)).toEqual(['basePath']);
  });

  // ---- and the things it must never accuse -------------------------------

  it('says nothing about the identity a delta restates to ADDRESS an element', () => {
    seed();
    const report = updateSpec('interface', 'iflow', {
      methods: [{ name: 'run', description: 'runs the flow, reworded' }],
    });
    expect(report.ineffective).toEqual([]);
  });

  it('says nothing about a jump label twin, which resolves into its numeric field', () => {
    seed();
    const report = updateSpec('implementation', 'flow_impl', {
      methods: [{ name: 'run', narrative: [{ stepNumber: 2, onFalseLabel: 'start' }] }],
    });
    expect(report.ineffective).toEqual([]);
    expect(report.changes.map(c => c.path)).toContain('methods.run.narrative.step 2.onFalseStep');
  });

  it('says nothing about a narrative a delta renumbered, where no path can be compared', () => {
    seed();
    const report = updateSpec('implementation', 'flow_impl', {
      methods: [{
        name: 'run',
        narrative: [{ stepNumber: 2, action: 'insert', description: 'Count the bytes', type: 'local' }],
      }],
    });
    expect(report.written).toBe(true);
    expect(report.ineffective).toEqual([]);
  });

  it('says nothing about a null, which the delta contract reads as "no change"', () => {
    seed();
    const report = updateSpec('component', 'flow_comp', { description: 'Reworded', basePath: null });
    expect(report.ineffective).toEqual([]);
  });
});
