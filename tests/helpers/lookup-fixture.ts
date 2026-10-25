import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { saveSystemSpec, saveSpec, invalidateSpecCache } from '../../src/core/specs.js';
import { captureApprovedSpecs } from '../../src/core/approval.js';
import { writeLockRecord, type LockRecord } from '../../src/core/lockfile.js';
import { computeGateStateId } from '../../src/core/validation.js';
import { WAIRON_MAJOR } from '../../src/config/defaults.js';

const now = '2026-10-25T10:00:00.000Z';

/** The code the fixture's specs declare and observe. */
const SOURCES: Record<string, string> = {
  'src/ledger.ts': 'export function record(entry: string): void {\n  void entry;\n}\n',
  'src/orders.ts': "import { record } from './ledger.js';\n\nexport function placeOrder(id: string): void {\n  record(id);\n}\n",
  // Calls ledger.record, and no spec says its component may.
  'src/audit.ts': "import { record } from './ledger.js';\n\nexport function audit(id: string): void {\n  record(`audit:${id}`);\n}\n",
  // Declares a call to ledger.record that the code never makes.
  'src/reports.ts': "export function report(): string {\n  return 'report';\n}\n",
  // Listed in rules.conformance.unclaimed.
  'src/orphan.ts': 'export const orphan = 1;\n',
  // Named by no spec and listed nowhere.
  'src/stray.ts': 'export function strayHelper(): number {\n  return 1;\n}\n',
  'tests/ledger.test.ts': "import { record } from '../src/ledger.js';\n\nrecord('x');\n",
};

interface FixtureMethod { name: string; calls?: [string, string] }
interface FixtureComponent { id: string; subsystem: string; dependsOn?: string[]; methods: FixtureMethod[]; sourcePath?: string }

const COMPONENTS: FixtureComponent[] = [
  { id: 'ledger', subsystem: 'shop', methods: [{ name: 'record' }], sourcePath: 'src/ledger.ts' },
  { id: 'orders', subsystem: 'shop', dependsOn: ['ledger'], methods: [{ name: 'placeOrder', calls: ['ledger', 'record'] }, { name: 'sync' }], sourcePath: 'src/orders.ts' },
  { id: 'audit', subsystem: 'shop', methods: [{ name: 'audit' }, { name: 'sync' }], sourcePath: 'src/audit.ts' },
  { id: 'reports', subsystem: 'shop', dependsOn: ['ledger'], methods: [{ name: 'report', calls: ['ledger', 'record'] }], sourcePath: 'src/reports.ts' },
  // Planned: its file does not exist yet.
  { id: 'shipping', subsystem: 'shop', methods: [{ name: 'ship' }], sourcePath: 'src/shipping.ts' },
];

/** A small project with real code files, a design that mostly agrees with them, and room to disagree. */
export function lookupProject(): {
  root: string;
  lock(): void;
  edit(file: string, content: string): void;
  addComponent(component: FixtureComponent): void;
  cleanup(): void;
} {
  invalidateSpecCache();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-lookup-'));
  fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(root, '.wai', 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0', waironMajor: WAIRON_MAJOR, name: 'lookup-sys', projectType: 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: { conformance: { sourceRoots: ['src'], testRoots: ['tests'], unclaimed: ['src/orphan.ts', 'src/stray.ts'] } },
    createdAt: now, updatedAt: now,
  }));
  for (const [file, content] of Object.entries(SOURCES)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  setProjectRoot(root);
  saveSystemSpec({ schemaVersion: '1.0.0', waironMajor: WAIRON_MAJOR, name: 'lookup-sys', vision: 'a lookup fixture', boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now });
  for (const id of ['shop', 'billing']) {
    saveSpec('subsystem', { id, name: id, description: `the ${id} subsystem`, parentSystem: 'lookup-sys', publicInterfaces: [], trustedLinks: [], status: 'complete', createdAt: now, updatedAt: now } as never);
  }
  const addComponent = (c: FixtureComponent): void => {
    setProjectRoot(root);
    saveSpec('component', { id: c.id, name: c.id, description: `the ${c.id} component`, subsystem: c.subsystem, componentType: 'Orchestrator', owns: [], dependsOn: c.dependsOn ?? [], status: 'complete', createdAt: now, updatedAt: now } as never);
    saveSpec('interface', {
      id: `i${c.id}`, name: `I${c.id}`, description: `the ${c.id} contract`, component: c.id, status: 'complete', createdAt: now, updatedAt: now,
      methods: c.methods.map((m) => ({ name: m.name, description: `${m.name} of ${c.id}.`, signature: `${m.name}(): void`, returns: 'void', params: [] })),
    } as never);
    saveSpec('implementation', {
      id: `${c.id}_impl`, name: `${c.id} implementation`, description: `realizes ${c.id}`, contract: `i${c.id}`,
      ...(c.sourcePath ? { sourcePath: c.sourcePath } : {}), status: 'complete', createdAt: now, updatedAt: now,
      methods: c.methods.map((m) => ({
        name: m.name,
        narrative: [m.calls
          ? { stepNumber: 1, description: `Record through ${m.calls[0]}`, type: 'call', targetComponent: m.calls[0], targetMethod: m.calls[1] }
          : { stepNumber: 1, description: `Do ${m.name}`, type: 'local' }],
      })),
    } as never);
    invalidateSpecCache();
    setProjectRoot(root);
  };
  for (const c of COMPONENTS) addComponent(c);
  return {
    root,
    lock: () => {
      setProjectRoot(root);
      invalidateSpecCache();
      const record: LockRecord = {
        stateId: computeGateStateId(), lockedAt: now, lockedBy: { id: 'tester <t@example.com>', source: 'git' },
        validatorVersion: 'test', validationResult: { valid: true, errors: 0, warnings: 0 }, status: 'ready',
        specs: captureApprovedSpecs(), specsReading: 'design', format: 3,
      };
      writeLockRecord(record);
    },
    edit: (file, content) => {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), content);
    },
    addComponent,
    cleanup: () => {
      setProjectRoot(null);
      invalidateSpecCache();
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows file locks */ }
    },
  };
}
