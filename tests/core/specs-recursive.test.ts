import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  saveSystemSpec,
  saveSubsystemSpec,
  saveComponentSpec,
  scanAllSpecs,
  invalidateSpecCache,
  getLoaderIssues,
} from '../../src/core/specs.js';

const now = new Date().toISOString();

describe('recursive subproject loading and namespacing', () => {
  let rootDir: string;
  let childDir: string;

  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    if (rootDir) fs.rmSync(rootDir, { recursive: true, force: true });
    if (childDir) fs.rmSync(childDir, { recursive: true, force: true });
  });

  it('correctly loads and namespaces child subprojects from projectPath', () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-root-'));
    childDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-child-'));

    // 1. Setup Root project
    fs.mkdirSync(path.join(rootDir, '.wai', 'specs'), { recursive: true });
    setProjectRoot(rootDir);

    saveSystemSpec({
      schemaVersion: '1.0.0',
      name: 'root-system',
      vision: 'A unified system-of-systems',
      boundaries: [],
      globalRequirements: [],
      createdAt: now,
      updatedAt: now,
    });

    const relPath = path.relative(rootDir, childDir);
    saveSubsystemSpec({
      id: 'billing',
      name: 'Billing',
      description: 'Handles billing',
      parentSystem: 'root-system',
      publicInterfaces: [
        {
          type: 'REST',
          details: 'Public billing portal',
          component: 'invoice_portal',
          interface: 'iinvoice_portal',
        }
      ],
      projectPath: relPath,
      createdAt: now,
      updatedAt: now,
    });

    // 2. Setup Child project
    setProjectRoot(childDir);
    fs.mkdirSync(path.join(childDir, '.wai', 'specs'), { recursive: true });
    
    saveSystemSpec({
      schemaVersion: '1.0.0',
      name: 'child-system',
      vision: 'Child billing system',
      boundaries: [],
      globalRequirements: [],
      createdAt: now,
      updatedAt: now,
    });

    saveSubsystemSpec({
      id: 'invoice',
      name: 'Invoice management',
      description: 'Manages invoices',
      parentSystem: 'child-system',
      publicInterfaces: [],
      createdAt: now,
      updatedAt: now,
    });

    saveComponentSpec({
      id: 'invoice_portal',
      name: 'Invoice portal',
      description: 'Entrance for invoice calls',
      subsystem: 'invoice',
      componentType: 'Portal',
      owns: [],
      dependsOn: ['invoice_store'],
      createdAt: now,
      updatedAt: now,
    });

    saveComponentSpec({
      id: 'invoice_store',
      name: 'Invoice database store',
      description: 'Stores invoices',
      subsystem: 'invoice',
      componentType: 'Store',
      owns: [],
      dependsOn: [],
      createdAt: now,
      updatedAt: now,
    });

    // 3. Scan root project and check federated index
    setProjectRoot(rootDir);
    invalidateSpecCache();
    const index = scanAllSpecs();

    // Verify subsystems
    const billingSub = index.subsystems.find(s => s.id === 'billing');
    const invoiceSub = index.subsystems.find(s => s.id === 'billing::invoice');
    expect(billingSub).toBeDefined();
    expect(invoiceSub).toBeDefined();

    // Verify component namespacing
    const portalComp = index.components.find(c => c.id === 'billing::invoice_portal');
    const storeComp = index.components.find(c => c.id === 'billing::invoice_store');
    expect(portalComp).toBeDefined();
    expect(storeComp).toBeDefined();

    // Verify references and dependencies are namespace-qualified
    expect(portalComp?.subsystem).toBe('billing::invoice');
    expect(portalComp?.dependsOn).toContain('billing::invoice_store');
  });
});
