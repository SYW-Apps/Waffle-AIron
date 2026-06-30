import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  saveSubsystemSpec,
  saveInterfaceSpec,
  saveImplementationSpec,
  loadImplementationSpec,
  updateSpec,
  invalidateSpecCache,
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
});
