import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  saveSystemSpec,
  saveSubsystemSpec,
  saveComponentSpec,
  saveInterfaceSpec,
  saveTypeSpec,
  scanAllSpecs,
  invalidateSpecCache,
  getLoaderIssues,
} from '../../src/core/specs.js';
import { validateSddTree } from '../../src/core/validation.js';
import { getStatusReport } from '../../src/commands/status.js';

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

  it('correctly resolves paths and strips namespace prefixes when saving specs to subprojects', () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-root-write-'));
    childDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-child-write-'));

    // 1. Setup parent project structure
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
      publicInterfaces: [],
      projectPath: relPath,
      createdAt: now,
      updatedAt: now,
    });

    // 2. Setup child project structure
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

    // 3. Switch back to parent context and save a new component under the child's namespace
    setProjectRoot(rootDir);
    invalidateSpecCache();

    saveComponentSpec({
      id: 'billing::invoice_portal',
      name: 'Invoice portal',
      description: 'Entrance for invoice calls',
      subsystem: 'billing::invoice',
      componentType: 'Portal',
      owns: [],
      dependsOn: [],
      createdAt: now,
      updatedAt: now,
    });

    // 4. Verify that the file was written to the child project path, and contains stripped IDs
    const childComponentPath = path.join(childDir, '.wai', 'specs', 'invoice', 'invoice_portal', 'component.yaml');
    expect(fs.existsSync(childComponentPath)).toBe(true);

    const contents = fs.readFileSync(childComponentPath, 'utf8');
    expect(contents).toContain('id: invoice_portal'); // prefix stripped!
    expect(contents).toContain('subsystem: invoice'); // prefix stripped!
    expect(contents).not.toContain('billing::');

    // 5. Save a namespaced type
    saveTypeSpec({
      kind: 'entity',
      id: 'billing::invoice_event',
      name: 'Invoice Event',
      subsystem: 'billing::invoice',
      fields: [{ name: 'amount', type: 'number', optional: false }],
      methods: [],
      createdAt: now,
      updatedAt: now,
    });

    const childTypePath = path.join(childDir, '.wai', 'specs', 'invoice', 'types', 'invoice_event.yaml');
    expect(fs.existsSync(childTypePath)).toBe(true);
    const typeContents = fs.readFileSync(childTypePath, 'utf8');
    expect(typeContents).toContain('id: invoice_event'); // stripped!
    expect(typeContents).toContain('subsystem: invoice'); // stripped!
    expect(typeContents).not.toContain('billing::');

    // 6. Save a namespaced interface
    saveInterfaceSpec({
      id: 'billing::i-invoice-portal',
      name: 'IInvoicePortal',
      description: 'Invoice portal interface',
      component: 'billing::invoice_portal',
      methods: [],
      createdAt: now,
      updatedAt: now,
    });

    const childInterfacePath = path.join(childDir, '.wai', 'specs', 'invoice', 'invoice_portal', 'interface.yaml');
    expect(fs.existsSync(childInterfacePath)).toBe(true);
    const interfaceContents = fs.readFileSync(childInterfacePath, 'utf8');
    expect(interfaceContents).toContain('id: i-invoice-portal'); // stripped!
    expect(interfaceContents).toContain('component: invoice_portal'); // stripped!
    expect(interfaceContents).not.toContain('billing::');

    // 7. Save a type using a bare subsystem name that matches a unique child subsystem
    saveTypeSpec({
      kind: 'entity',
      id: 'invoice_item',
      name: 'Invoice Item',
      subsystem: 'invoice', // bare subsystem name!
      fields: [{ name: 'price', type: 'number', optional: false }],
      methods: [],
      createdAt: now,
      updatedAt: now,
    });

    const childItemPath = path.join(childDir, '.wai', 'specs', 'invoice', 'types', 'invoice_item.yaml');
    expect(fs.existsSync(childItemPath)).toBe(true);
    const itemContents = fs.readFileSync(childItemPath, 'utf8');
    expect(itemContents).toContain('id: invoice_item');
    expect(itemContents).toContain('subsystem: invoice');

    // 8. Save a namespaced subsystem under the child's namespace and check parentSystem rewriting
    saveSubsystemSpec({
      id: 'billing::tax',
      name: 'Tax Management',
      description: 'Handles tax calculations',
      parentSystem: 'root-system', // Passed parent system from parent context (e.g. Waffler)
      publicInterfaces: [],
      createdAt: now,
      updatedAt: now,
    });

    const childSubsystemPath = path.join(childDir, '.wai', 'specs', 'tax', 'subsystem.yaml');
    expect(fs.existsSync(childSubsystemPath)).toBe(true);
    const subContents = fs.readFileSync(childSubsystemPath, 'utf8');
    expect(subContents).toContain('id: tax');
    expect(subContents).toContain('parentSystem: child-system'); // Automatically rewritten!
    expect(subContents).not.toContain('parentSystem: root-system');
  });

  it('correctly respects recursive and depth limits when scanning', () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-root-depth-'));
    childDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-child-depth-'));
    const grandchildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-grandchild-depth-'));

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

    saveSubsystemSpec({
      id: 'billing',
      name: 'Billing',
      description: 'Handles billing',
      parentSystem: 'root-system',
      publicInterfaces: [],
      projectPath: path.relative(rootDir, childDir),
      createdAt: now,
      updatedAt: now,
    });

    // 2. Setup Child project
    fs.mkdirSync(path.join(childDir, '.wai', 'specs'), { recursive: true });
    setProjectRoot(childDir);
    
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
      projectPath: path.relative(childDir, grandchildDir),
      createdAt: now,
      updatedAt: now,
    });

    // 3. Setup Grandchild project
    fs.mkdirSync(path.join(grandchildDir, '.wai', 'specs'), { recursive: true });
    setProjectRoot(grandchildDir);
    
    saveSystemSpec({
      schemaVersion: '1.0.0',
      name: 'grandchild-system',
      vision: 'Grandchild system',
      boundaries: [],
      globalRequirements: [],
      createdAt: now,
      updatedAt: now,
    });

    saveSubsystemSpec({
      id: 'tax',
      name: 'Tax Calculation',
      description: 'Calculates tax',
      parentSystem: 'grandchild-system',
      publicInterfaces: [],
      createdAt: now,
      updatedAt: now,
    });

    // 4. Test scans from root project with different recursion settings
    setProjectRoot(rootDir);
    
    // Depth 0 (non-recursive)
    invalidateSpecCache();
    const index0 = scanAllSpecs({ recursive: false });
    expect(index0.subsystems.find(s => s.id === 'billing')).toBeDefined();
    expect(index0.subsystems.find(s => s.id === 'billing::invoice')).toBeUndefined();
    expect(index0.subsystems.find(s => s.id === 'billing::invoice::tax')).toBeUndefined();

    // Depth 1 (recursive up to depth 1)
    invalidateSpecCache();
    const index1 = scanAllSpecs({ recursive: 1 });
    expect(index1.subsystems.find(s => s.id === 'billing')).toBeDefined();
    expect(index1.subsystems.find(s => s.id === 'billing::invoice')).toBeDefined();
    expect(index1.subsystems.find(s => s.id === 'billing::invoice::tax')).toBeUndefined();

    // Depth 2 (recursive up to depth 2 / full)
    invalidateSpecCache();
    const index2 = scanAllSpecs({ recursive: true });
    expect(index2.subsystems.find(s => s.id === 'billing')).toBeDefined();
    expect(index2.subsystems.find(s => s.id === 'billing::invoice')).toBeDefined();
    expect(index2.subsystems.find(s => s.id === 'billing::invoice::tax')).toBeDefined();

    // Clean up grandchild directory since it's not tracked by afterEach
    fs.rmSync(grandchildDir, { recursive: true, force: true });
  });

  it('correctly filters validation and status by scopeSubsystem', () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-root-scope-'));
    childDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-child-scope-'));

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

    saveSubsystemSpec({
      id: 'billing',
      name: 'Billing',
      description: 'Handles billing',
      parentSystem: 'root-system',
      publicInterfaces: [],
      projectPath: path.relative(rootDir, childDir),
      createdAt: now,
      updatedAt: now,
    });

    // 2. Setup Child project
    fs.mkdirSync(path.join(childDir, '.wai', 'specs'), { recursive: true });
    setProjectRoot(childDir);
    
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

    // Add a component in the invoice subsystem
    saveComponentSpec({
      id: 'invoice_portal',
      name: 'Invoice Portal',
      description: 'Invoice portal entrance',
      subsystem: 'invoice',
      componentType: 'Portal',
      owns: [],
      dependsOn: [],
      createdAt: now,
      updatedAt: now,
    });

    // 3. Switch back to parent context and validate/status
    setProjectRoot(rootDir);
    invalidateSpecCache();

    // Check validation output with scopeSubsystem
    const valResultFiltered = validateSddTree({ scopeSubsystem: 'billing::invoice' });
    // Filtered validation should focus on child subsystem and run without failing on root subsystem missing specs or other root issues.
    expect(valResultFiltered.issues.some(i => i.specId === 'billing')).toBe(false);

    // Check status report with subsystem option
    const statusReport = getStatusReport({ subsystem: 'billing::invoice' });
    expect(statusReport).toContain('billing::invoice');
    expect(statusReport).toContain('billing::invoice_portal');
    expect(statusReport).not.toContain('billing\n');
  });
});

