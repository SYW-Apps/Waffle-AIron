import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  saveSubsystemSpec,
  saveInterfaceSpec,
  loadInterfaceSpec,
  saveImplementationSpec,
  loadImplementationSpec,
  updateSpec,
  invalidateSpecCache,
  saveComponentSpec,
  loadComponentSpec,
  saveTypeSpec,
  loadTypeSpec,
  loadSubsystemSpec,
  getComponentPath,
} from '../../src/core/specs.js';

const now = new Date().toISOString();

describe('granular specification updates via updateSpec', () => {
  let proj: string;
  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    if (proj) fs.rmSync(proj, { recursive: true, force: true });
  });

  it('granularly inserts, deletes, and updates narrative steps in method implementation', () => {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-update-test-'));
    fs.mkdirSync(path.join(proj, '.wai', 'specs'), { recursive: true });
    setProjectRoot(proj);

    // 1. Setup subsystem
    saveSubsystemSpec({
      schemaVersion: '1.0.0',
      id: 'billing',
      name: 'Billing Subsystem',
      description: 'Billing',
      parentSystem: 'GK',
      publicInterfaces: [],
      createdAt: now,
      updatedAt: now,
    });

    // 2. Setup interface
    saveInterfaceSpec({
      id: 'ibilling-portal',
      name: 'IBillingPortal',
      description: 'Portal interface',
      component: 'billing-portal',
      methods: [
        { name: 'authorize', signature: 'auth()', returns: 'Promise<void>', description: 'auth method' }
      ],
      createdAt: now,
      updatedAt: now,
    });

    // 3. Setup implementation narrative with initial steps
    saveImplementationSpec({
      id: 'billing-portal-impl',
      name: 'BillingPortalImpl',
      description: 'Portal implementation',
      contract: 'ibilling-portal',
      methods: [
        {
          name: 'authorize',
          narrative: [
            { stepNumber: 1, description: 'Step 1', type: 'local' },
            { stepNumber: 2, description: 'Step 2', type: 'local' },
            { stepNumber: 3, description: 'Step 3', type: 'local' },
          ],
        },
      ],
      createdAt: now,
      updatedAt: now,
    });

    // 4. Perform update: insert at step 2, delete step 4 (which was original 3), and update step 1
    updateSpec('implementation', 'billing-portal-impl', {
      methods: [
        {
          name: 'authorize',
          narrative: [
            { stepNumber: 2, action: 'insert', description: 'Inserted step 2', type: 'local' },
            { stepNumber: 4, action: 'delete' },
            { stepNumber: 1, description: 'Updated step 1', type: 'local' },
          ],
        },
      ],
    });

    const updated = loadImplementationSpec('billing-portal-impl');
    expect(updated).not.toBeNull();
    const authorizeMethod = updated!.methods.find(m => m.name === 'authorize');
    expect(authorizeMethod).not.toBeUndefined();
    expect(authorizeMethod!.narrative).toHaveLength(3);

    expect(authorizeMethod!.narrative[0]).toEqual({ stepNumber: 1, description: 'Updated step 1', type: 'local' });
    expect(authorizeMethod!.narrative[1]).toEqual({ stepNumber: 2, description: 'Inserted step 2', type: 'local' });
    expect(authorizeMethod!.narrative[2]).toEqual({ stepNumber: 3, description: 'Step 2', type: 'local' });
  });

  it('relocates flow jump fields on narrative insert/delete and refuses to delete a jump target', () => {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-update-flow-'));
    fs.mkdirSync(path.join(proj, '.wai', 'specs'), { recursive: true });
    setProjectRoot(proj);

    saveSubsystemSpec({
      schemaVersion: '1.0.0', id: 'billing', name: 'Billing', description: 'd',
      parentSystem: 'GK', publicInterfaces: [], createdAt: now, updatedAt: now,
    });
    saveInterfaceSpec({
      id: 'iflow', name: 'IFlow', description: 'd', component: 'flow-comp',
      methods: [{ name: 'run', signature: 'run()', returns: 'void', description: 'runs it all, with branching' }],
      createdAt: now, updatedAt: now,
    });
    saveImplementationSpec({
      id: 'flow-impl', name: 'FlowImpl', description: 'd', contract: 'iflow',
      methods: [{
        name: 'run',
        narrative: [
          { stepNumber: 1, description: 'check input', type: 'branch', condition: 'input valid', onFalseStep: 4 },
          { stepNumber: 2, description: 'retry loop', type: 'loop', loopKind: 'while', condition: 'attempts left', endStep: 3 },
          { stepNumber: 3, description: 'do the work', type: 'local' },
          { stepNumber: 4, description: 'bail out', type: 'return', outcome: 'invalid input' },
        ],
      }],
      createdAt: now, updatedAt: now,
    });

    // Insert a step at position 3 (inside the loop body): the branch's
    // onFalseStep (4) and the loop's endStep (3) must both relocate to +1.
    updateSpec('implementation', 'flow-impl', {
      methods: [{
        name: 'run',
        narrative: [{ stepNumber: 3, action: 'insert', description: 'log the attempt', type: 'local' }],
      }],
    });

    let narr = loadImplementationSpec('flow-impl')!.methods[0].narrative;
    expect(narr).toHaveLength(5);
    expect(narr[0]).toMatchObject({ stepNumber: 1, type: 'branch', onFalseStep: 5 });
    expect(narr[1]).toMatchObject({ stepNumber: 2, type: 'loop', endStep: 4 });
    expect(narr[2]).toMatchObject({ stepNumber: 3, description: 'log the attempt' });
    expect(narr[4]).toMatchObject({ stepNumber: 5, type: 'return' });

    // Deleting a step that is a jump target must be rejected, naming the referrer.
    expect(() => updateSpec('implementation', 'flow-impl', {
      methods: [{ name: 'run', narrative: [{ stepNumber: 5, action: 'delete' }] }],
    })).toThrow(/jump target of step\(s\) 1 \(onFalseStep\)/);

    // Deleting an un-referenced step relocates the jumps back down.
    updateSpec('implementation', 'flow-impl', {
      methods: [{ name: 'run', narrative: [{ stepNumber: 3, action: 'delete' }] }],
    });
    narr = loadImplementationSpec('flow-impl')!.methods[0].narrative;
    expect(narr).toHaveLength(4);
    expect(narr[0]).toMatchObject({ stepNumber: 1, onFalseStep: 4 });
    expect(narr[1]).toMatchObject({ stepNumber: 2, endStep: 3 });
  });

  it('preserves metadata, groups, status, and endpoint bindings on updates and resolves nested component path ownership', () => {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-preserve-test-'));
    fs.mkdirSync(path.join(proj, '.wai', 'specs', 'subsystems'), { recursive: true });
    fs.mkdirSync(path.join(proj, '.wai', 'specs', 'components'), { recursive: true });
    fs.mkdirSync(path.join(proj, '.wai', 'specs', 'interfaces'), { recursive: true });
    fs.mkdirSync(path.join(proj, '.wai', 'specs', 'types'), { recursive: true });
    setProjectRoot(proj);

    // 1. Save Subsystem
    saveSubsystemSpec({
      schemaVersion: '1.0.0',
      id: 'billing',
      name: 'Billing Subsystem',
      description: 'Billing',
      parentSystem: 'GK',
      publicInterfaces: [],
      createdAt: '2026-06-01T12:00:00Z',
      updatedAt: '2026-06-01T12:00:00Z',
    });

    // 2. Save Type with Group
    saveTypeSpec({
      schemaVersion: '1.0.0',
      kind: 'value-object',
      id: 'vm-instruction',
      name: 'VmInstruction',
      subsystem: 'billing',
      group: 'runtime-vm',
      fields: [{ name: 'op', type: 'string' }],
      createdAt: '2026-06-01T12:00:00Z',
      updatedAt: '2026-06-01T12:00:00Z',
    });

    // Re-save without group parameter, check if it preserves group
    saveTypeSpec({
      schemaVersion: '1.0.0',
      kind: 'value-object',
      id: 'vm-instruction',
      name: 'VmInstruction',
      subsystem: 'billing',
      fields: [{ name: 'op', type: 'string' }, { name: 'arg', type: 'number', optional: true }],
      createdAt: '2026-06-05T12:00:00Z', // Should be ignored (preserved existing)
      updatedAt: '2026-06-05T12:00:00Z',
    });

    const typeSpec = loadTypeSpec('vm-instruction');
    expect(typeSpec).not.toBeNull();
    expect(typeSpec!.group).toBe('runtime-vm');
    expect(typeSpec!.createdAt).toBe('2026-06-01T12:00:00Z');

    // 3. Save Component with status and verify nested component path resolution under repository owner
    saveComponentSpec({
      schemaVersion: '1.0.0',
      id: 'billing-repo',
      name: 'BillingRepository',
      description: 'Repo pattern',
      subsystem: 'billing',
      componentType: 'Orchestrator',
      owns: ['billing-store'],
      dependsOn: [],
      status: 'complete',
      createdAt: '2026-06-01T12:00:00Z',
      updatedAt: '2026-06-01T12:00:00Z',
    });

    saveComponentSpec({
      schemaVersion: '1.0.0',
      id: 'billing-store',
      name: 'BillingStore',
      description: 'Store member',
      subsystem: 'billing',
      componentType: 'Store',
      dependsOn: [],
      owns: [],
      status: 'complete',
      createdAt: '2026-06-01T12:00:00Z',
      updatedAt: '2026-06-01T12:00:00Z',
    });

    // Verify it is placed under billing-repo directory
    const expectedNestedStorePath = path.join(proj, '.wai', 'specs', 'billing', 'billing-repo', 'billing-store', '.index.yaml');
    expect(fs.existsSync(expectedNestedStorePath)).toBe(true);

    // Save Billing Store with status draft, verify it preserves 'complete'
    saveComponentSpec({
      schemaVersion: '1.0.0',
      id: 'billing-store',
      name: 'BillingStore',
      description: 'Store member',
      subsystem: 'billing',
      componentType: 'Store',
      dependsOn: [],
      owns: [],
      status: 'draft',
      createdAt: '2026-06-05T12:00:00Z',
      updatedAt: '2026-06-05T12:00:00Z',
    });

    const storeComp = loadComponentSpec('billing-store');
    expect(storeComp).not.toBeNull();
    expect(storeComp!.status).toBe('complete');
    expect(storeComp!.createdAt).toBe('2026-06-01T12:00:00Z');

    // Save billing-portal component first
    saveComponentSpec({
      schemaVersion: '1.0.0',
      id: 'billing-portal',
      name: 'BillingPortal',
      description: 'Portal component',
      subsystem: 'billing',
      componentType: 'Portal',
      portalType: 'HTTP_API',
      dependsOn: [],
      owns: [],
      status: 'complete',
      createdAt: '2026-06-01T12:00:00Z',
      updatedAt: '2026-06-01T12:00:00Z',
    });

    // 4. Save Interface with Endpoint bindings
    saveInterfaceSpec({
      schemaVersion: '1.0.0',
      id: 'ibilling-portal',
      name: 'IBillingPortal',
      description: 'Portal contract',
      component: 'billing-portal',
      methods: [
        {
          name: 'charge',
          signature: 'charge()',
          returns: 'void',
          description: 'charge method',
          endpoint: { transport: 'HTTP', method: 'POST', path: '/charge' }
        }
      ],
      createdAt: '2026-06-01T12:00:00Z',
      updatedAt: '2026-06-01T12:00:00Z',
    });

    // Save interface again without endpoint block (e.g. define_interface payload)
    saveInterfaceSpec({
      schemaVersion: '1.0.0',
      id: 'ibilling-portal',
      name: 'IBillingPortal',
      description: 'Portal contract',
      component: 'billing-portal',
      methods: [
        {
          name: 'charge',
          signature: 'charge()',
          returns: 'void',
          description: 'charge method'
        }
      ],
      createdAt: '2026-06-05T12:00:00Z',
      updatedAt: '2026-06-05T12:00:00Z',
    });

    const intfSpec = loadInterfaceSpec('ibilling-portal');
    expect(intfSpec).not.toBeNull();
    expect(intfSpec!.methods[0].endpoint).toEqual({ transport: 'HTTP', method: 'POST', path: '/charge' });
  });

  it('rejects a delta that would produce a schema-invalid spec and leaves the file untouched', () => {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-invalid-delta-test-'));
    fs.mkdirSync(path.join(proj, '.wai', 'specs'), { recursive: true });
    setProjectRoot(proj);

    saveInterfaceSpec({
      id: 'ibilling-portal',
      name: 'IBillingPortal',
      description: 'Portal interface',
      component: 'billing-portal',
      methods: [
        { name: 'authorize', signature: 'auth()', returns: 'Promise<void>', description: 'auth method' },
      ],
      createdAt: now,
      updatedAt: now,
    });

    // Upserting a method missing required fields (signature/returns/description)
    // must fail loudly at write time, not corrupt the file for the next scan.
    expect(() =>
      updateSpec('interface', 'ibilling-portal', { methods: [{ name: 'broken' }] })
    ).toThrow(/Refusing to write invalid interface spec/);

    const intact = loadInterfaceSpec('ibilling-portal');
    expect(intact).not.toBeNull();
    expect(intact!.methods).toHaveLength(1);
    expect(intact!.methods[0].name).toBe('authorize');
  });

  it('ext data key-merges at every level: spec-level, implementation methods, and interface methods', () => {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-ext-merge-test-'));
    fs.mkdirSync(path.join(proj, '.wai', 'specs'), { recursive: true });
    setProjectRoot(proj);

    const EXT = { 'pack-x': { budget: 5, note: 'n' }, 'pack-y': 'keep' };

    saveSubsystemSpec({
      schemaVersion: '1.0.0', id: 'billing', name: 'Billing', description: 'd',
      parentSystem: 'GK', publicInterfaces: [], createdAt: now, updatedAt: now,
    });
    saveComponentSpec({
      schemaVersion: '1.0.0', id: 'billing-engine', name: 'BillingEngine', description: 'Engine',
      subsystem: 'billing', componentType: 'Orchestrator', owns: [], dependsOn: [],
      ext: EXT, createdAt: now, updatedAt: now,
    });
    saveInterfaceSpec({
      id: 'ibilling-engine', name: 'IBillingEngine', description: 'contract', component: 'billing-engine',
      methods: [
        { name: 'charge', signature: 'charge()', returns: 'void', description: 'charge method', ext: EXT },
        { name: 'refund', signature: 'refund()', returns: 'void', description: 'refund method' },
      ],
      createdAt: now, updatedAt: now,
    });
    saveImplementationSpec({
      id: 'billing-engine-impl', name: 'impl', description: 'd', contract: 'ibilling-engine',
      methods: [{
        name: 'charge',
        narrative: [{ stepNumber: 1, description: 'charge it', type: 'local' }],
        ext: EXT,
      }],
      createdAt: now, updatedAt: now,
    });

    // Component-level ext (the reference semantics): a delta mentioning ONE
    // key merges into the map — absent keys survive, nested objects merge.
    updateSpec('component', 'billing-engine', { ext: { 'pack-x': { budget: 9 } } });
    expect(loadComponentSpec('billing-engine')!.ext).toEqual({ 'pack-x': { budget: 9, note: 'n' }, 'pack-y': 'keep' });

    // An unrelated method edit (delta never mentions ext) preserves the
    // method's ext verbatim.
    updateSpec('implementation', 'billing-engine-impl', {
      methods: [{ name: 'charge', narrative: [{ stepNumber: 1, description: 'charge it, updated', type: 'local' }] }],
    });
    let method = loadImplementationSpec('billing-engine-impl')!.methods[0];
    expect(method.narrative[0].description).toBe('charge it, updated');
    expect(method.ext).toEqual(EXT);

    // A method-level ext delta must behave exactly like component-level ext:
    // key-merge, never clobber the whole map.
    updateSpec('implementation', 'billing-engine-impl', {
      methods: [{ name: 'charge', ext: { 'pack-x': { budget: 9 } } }],
    });
    method = loadImplementationSpec('billing-engine-impl')!.methods[0];
    expect(method.ext).toEqual({ 'pack-x': { budget: 9, note: 'n' }, 'pack-y': 'keep' });
    expect(method.narrative[0].description).toBe('charge it, updated');

    // Same parity on L3 contract methods; the untouched sibling keeps having
    // no ext at all.
    updateSpec('interface', 'ibilling-engine', {
      methods: [{ name: 'charge', ext: { 'pack-x': { budget: 9 } } }],
    });
    const intf = loadInterfaceSpec('ibilling-engine')!;
    expect(intf.methods.find(m => m.name === 'charge')!.ext).toEqual({ 'pack-x': { budget: 9, note: 'n' }, 'pack-y': 'keep' });
    expect(intf.methods.find(m => m.name === 'refund')!.ext).toBeUndefined();
  });

  it('allows explicit status demotion via updateSpec while re-adds still cannot demote', () => {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-demote-test-'));
    fs.mkdirSync(path.join(proj, '.wai', 'specs'), { recursive: true });
    setProjectRoot(proj);

    saveSubsystemSpec({
      schemaVersion: '1.0.0',
      id: 'billing',
      name: 'Billing Subsystem',
      description: 'Billing',
      parentSystem: 'GK',
      publicInterfaces: [],
      createdAt: now,
      updatedAt: now,
    });

    saveComponentSpec({
      schemaVersion: '1.0.0',
      id: 'billing-engine',
      name: 'BillingEngine',
      description: 'Engine',
      subsystem: 'billing',
      componentType: 'Orchestrator',
      owns: [],
      dependsOn: [],
      status: 'complete',
      createdAt: now,
      updatedAt: now,
    });

    // A re-add carrying 'draft' (the add tools always do) must NOT reopen it…
    saveComponentSpec({
      schemaVersion: '1.0.0',
      id: 'billing-engine',
      name: 'BillingEngine',
      description: 'Engine',
      subsystem: 'billing',
      componentType: 'Orchestrator',
      owns: [],
      dependsOn: [],
      status: 'draft',
      createdAt: now,
      updatedAt: now,
    });
    expect(loadComponentSpec('billing-engine')!.status).toBe('complete');

    // …but an explicit status change through updateSpec is deliberate and must work.
    updateSpec('component', 'billing-engine', { status: 'draft' });
    expect(loadComponentSpec('billing-engine')!.status).toBe('draft');
  });
});

// ---------------------------------------------------------------------------
// Array deltas UPSERT — they must not replace.
//
// The contract says a delta naming one element leaves the others intact, and that
// an "action: delete" marker removes one. That held for methods/fields/dispatch/lifecycle
// and silently did NOT for everything else: a one-entry delta on trustedLinks,
// invariants, or lint.allow erased every entry it did not mention. Same data loss
// already fixed once for dispatch tables, still live elsewhere — and it left a
// stale lint allow (which wairon fails --ci on) with no way to remove it.
// ---------------------------------------------------------------------------

describe('array deltas upsert by identity and honour delete markers', () => {
  let proj: string;
  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    if (proj) fs.rmSync(proj, { recursive: true, force: true });
  });

  function project(): void {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-arraydelta-'));
    fs.mkdirSync(path.join(proj, '.wai', 'specs'), { recursive: true });
    setProjectRoot(proj);
  }

  it('trustedLinks: a one-entry delta updates that link and KEEPS the others', () => {
    project();
    saveSubsystemSpec({
      schemaVersion: '1.0.0', id: 'billing', name: 'Billing', description: 'd', parentSystem: 'GK',
      publicInterfaces: [], trustedLinks: [{ subsystem: 'x', reason: 'r1' }, { subsystem: 'y', reason: 'r2' }],
      createdAt: now, updatedAt: now,
    } as never);
    invalidateSpecCache();

    updateSpec('subsystem', 'billing', { trustedLinks: [{ subsystem: 'x', reason: 'UPDATED' }] });
    invalidateSpecCache();
    expect(loadSubsystemSpec('billing')!.trustedLinks).toEqual([
      { subsystem: 'x', reason: 'UPDATED' },
      { subsystem: 'y', reason: 'r2' },
    ]);

    updateSpec('subsystem', 'billing', { trustedLinks: [{ subsystem: 'y', action: 'delete' }] });
    invalidateSpecCache();
    expect(loadSubsystemSpec('billing')!.trustedLinks).toEqual([{ subsystem: 'x', reason: 'UPDATED' }]);
  });

  it('type invariants: keyed by id, upserted and deletable', () => {
    project();
    saveTypeSpec({
      kind: 'entity', id: 'invoice', name: 'Invoice', fields: [], methods: [],
      invariants: [{ id: 'i1', description: 'one' }, { id: 'i2', description: 'two' }],
      createdAt: now, updatedAt: now,
    } as never);
    invalidateSpecCache();

    updateSpec('type', 'invoice', { invariants: [{ id: 'i1', description: 'ONE' }] });
    invalidateSpecCache();
    expect(loadTypeSpec('invoice')!.invariants).toEqual([
      { id: 'i1', description: 'ONE' },
      { id: 'i2', description: 'two' },
    ]);

    updateSpec('type', 'invoice', { invariants: [{ id: 'i2', action: 'delete' }] });
    invalidateSpecCache();
    expect(loadTypeSpec('invoice')!.invariants).toEqual([{ id: 'i1', description: 'ONE' }]);
  });

  it('lint.allow: a stale suppression can be REMOVED by code — the dead end that motivated this', () => {
    project();
    saveTypeSpec({ kind: 'entity', id: 'invoice', name: 'Invoice', fields: [], methods: [], createdAt: now, updatedAt: now } as never);
    invalidateSpecCache();
    updateSpec('type', 'invoice', { lint: { allow: [{ code: 'A_CODE', reason: 'ra' }, { code: 'B_CODE', reason: 'rb' }] } });
    invalidateSpecCache();

    // Upsert one, keep the other.
    updateSpec('type', 'invoice', { lint: { allow: [{ code: 'A_CODE', reason: 'RA' }] } });
    invalidateSpecCache();
    expect(loadTypeSpec('invoice')!.lint!.allow).toEqual([
      { code: 'A_CODE', reason: 'RA' },
      { code: 'B_CODE', reason: 'rb' },
    ]);

    // wairon flags a stale allow and fails --ci on it, so removal must be expressible.
    updateSpec('type', 'invoice', { lint: { allow: [{ code: 'B_CODE', reason: 'x', action: 'delete' }] } });
    invalidateSpecCache();
    expect(loadTypeSpec('invoice')!.lint!.allow).toEqual([{ code: 'A_CODE', reason: 'RA' }]);
  });

  it('string arrays have no per-element identity, so they replace wholesale', () => {
    project();
    saveSubsystemSpec({ schemaVersion: '1.0.0', id: 'billing', name: 'B', description: 'd', parentSystem: 'GK', publicInterfaces: [], createdAt: now, updatedAt: now } as never);
    saveComponentSpec({
      id: 'repo', name: 'Repo', description: 'd', subsystem: 'billing', componentType: 'Repository',
      owns: ['a', 'b', 'c'], dependsOn: [], createdAt: now, updatedAt: now,
    } as never);
    invalidateSpecCache();

    updateSpec('component', 'repo', { owns: ['a'] });
    invalidateSpecCache();
    // Deliberate: there is no way to address one string, so the list IS the delta.
    expect(loadComponentSpec('repo')!.owns).toEqual(['a']);
  });

  it('an empty array clears a keyed list outright', () => {
    project();
    saveSubsystemSpec({
      schemaVersion: '1.0.0', id: 'billing', name: 'B', description: 'd', parentSystem: 'GK',
      publicInterfaces: [], trustedLinks: [{ subsystem: 'x', reason: 'r' }], createdAt: now, updatedAt: now,
    } as never);
    invalidateSpecCache();
    updateSpec('subsystem', 'billing', { trustedLinks: [] });
    invalidateSpecCache();
    expect(loadSubsystemSpec('billing')!.trustedLinks).toEqual([]);
  });
});
