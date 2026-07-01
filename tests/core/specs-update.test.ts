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
});
