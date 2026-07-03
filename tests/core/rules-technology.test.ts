import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { validateSddTree } from '../../src/core/validation.js';
import { invalidateSpecCache } from '../../src/core/specs.js';

// ---------------------------------------------------------------------------
// Technology boundaries: an L4 declaring `technologies` makes its component's
// ownership tree the tech's home — TECH_LEAKAGE / VENDOR_NAME_IN_CONTRACT /
// TECH_ON_LOGIC_COMPONENT police the rest of the tree.
// ---------------------------------------------------------------------------

function createTempProject() {
  invalidateSpecCache();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-tech-test-'));

  const waiDir = path.join(tempDir, '.wai');
  fs.mkdirSync(waiDir);
  fs.writeFileSync(path.join(waiDir, 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0',
    name: 'test-project',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {
      noOverlappingOwnership: true,
      requireOwnedPaths: true,
      metaAgentTags: ['meta'],
      enforceReproducibility: true,
    },
  }));

  const specsDir = path.join(waiDir, 'specs');
  for (const d of ['subsystems', 'components', 'interfaces', 'implementations', 'types']) {
    fs.mkdirSync(path.join(specsDir, d), { recursive: true });
  }

  const stamp = "createdAt: '2026-07-03T10:00:00Z'\nupdatedAt: '2026-07-03T10:00:00Z'";
  const writeSpec = (type: string, name: string, content: string) => {
    const filePath = type === 'system'
      ? path.join(specsDir, '.index.yaml')
      : path.join(specsDir, `${type}s`, `${name}.yaml`);
    fs.writeFileSync(filePath, `${content}\n${stamp}\n`);
  };

  writeSpec('system', 'system', 'schemaVersion: 1.0.0\nname: TestSystem\nvision: testing');
  writeSpec('subsystem', 'sub-a', 'schemaVersion: 1.0.0\nid: sub-a\nname: SubA\ndescription: d\nparentSystem: TestSystem');

  return {
    writeSpec,
    component: (id: string, type: string, extra = '') =>
      writeSpec('component', id, `schemaVersion: 1.0.0\nid: ${id}\nname: ${id}\ndescription: d\nsubsystem: sub-a\ncomponentType: ${type}\n${extra}`),
    activate: () => { vi.spyOn(process, 'cwd').mockReturnValue(tempDir); },
    cleanup: () => {
      invalidateSpecCache();
      vi.restoreAllMocks();
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* win file locks */ }
    },
  };
}

const TECH_CODES = ['TECH_LEAKAGE', 'VENDOR_NAME_IN_CONTRACT', 'TECH_ON_LOGIC_COMPONENT'];
const techIssues = (res: { issues: { code: string; specId?: string }[] }) =>
  res.issues.filter(i => TECH_CODES.includes(i.code));

/** A Repository pattern owning a Store and the MySQL-binding Adapter. */
function writeRepositoryBoundary(proj: ReturnType<typeof createTempProject>) {
  proj.component('cust-repo', 'Repository', 'owns: [cust-store, cust-adapter]');
  proj.component('cust-store', 'Store', 'dependsOn: [cust-adapter]');
  proj.component('cust-adapter', 'Adapter');
  proj.writeSpec('interface', 'icust-adapter', `schemaVersion: 1.0.0
id: icust-adapter
name: ICustAdapter
description: Row-level persistence access for customer records.
component: cust-adapter
methods:
  - name: fetchRow
    description: Fetches one customer row by id.
    signature: "fetchRow(id: string): Promise<string>"
    returns: "Promise<string>"`);
  proj.writeSpec('implementation', 'impl-cust-adapter', `schemaVersion: 1.0.0
id: impl-cust-adapter
name: ImplCustAdapter
description: Talks to the MySQL instance via the connection pool.
contract: icust-adapter
technologies: [mysql]
methods:
  - name: fetchRow
    detail: intent
    intent: Executes a parameterized SELECT against the customers table and maps the row; returns null-equivalent empty payload when absent.`);
}

describe('technology boundary rules', () => {
  it('emits nothing when no L4 declares technologies', () => {
    const proj = createTempProject();
    proj.component('orch-a', 'Orchestrator');
    proj.activate();
    try {
      expect(techIssues(validateSddTree())).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('flags TECH_LEAKAGE outside the boundary but exempts the owning pattern', () => {
    const proj = createTempProject();
    writeRepositoryBoundary(proj);
    // In scope: the sibling Store's implementation may talk about mysql.
    proj.writeSpec('interface', 'icust-store', `schemaVersion: 1.0.0
id: icust-store
name: ICustStore
description: Customer persistence.
component: cust-store
methods:
  - name: getCustomer
    description: Loads a customer.
    signature: "getCustomer(id: string): Promise<string>"
    returns: "Promise<string>"`);
    proj.writeSpec('implementation', 'impl-cust-store', `schemaVersion: 1.0.0
id: impl-cust-store
name: ImplCustStore
description: Delegates row access to the mysql adapter.
contract: icust-store
methods:
  - name: getCustomer
    detail: intent
    intent: Fetches the row through the adapter and hydrates the Customer aggregate, caching nothing between calls.`);
    // Out of scope: a portal whose description names the technology.
    proj.writeSpec('component', 'billing-portal', `schemaVersion: 1.0.0
id: billing-portal
name: billing-portal
description: Renders MySQL rows directly for billing
subsystem: sub-a
componentType: Portal
portalType: HTTP_API`);
    proj.activate();
    try {
      const issues = techIssues(validateSddTree());
      expect(issues.some(i => i.code === 'TECH_LEAKAGE' && i.specId === 'billing-portal')).toBe(true);
      expect(issues.some(i => i.specId === 'impl-cust-store')).toBe(false);
      expect(issues.some(i => i.specId === 'impl-cust-adapter')).toBe(false);
    } finally { proj.cleanup(); }
  });

  it('flags VENDOR_NAME_IN_CONTRACT even on the owning component\'s own interface', () => {
    const proj = createTempProject();
    writeRepositoryBoundary(proj);
    // Replace the adapter contract with a vendor-named method.
    proj.writeSpec('interface', 'icust-adapter', `schemaVersion: 1.0.0
id: icust-adapter
name: ICustAdapter
description: Row-level persistence access for customer records.
component: cust-adapter
methods:
  - name: insertMySqlRow
    description: Inserts one customer row.
    signature: "insertMySqlRow(row: string): Promise<void>"
    returns: "Promise<void>"`);
    proj.activate();
    try {
      const issues = techIssues(validateSddTree());
      expect(issues.some(i => i.code === 'VENDOR_NAME_IN_CONTRACT' && i.specId === 'icust-adapter')).toBe(true);
    } finally { proj.cleanup(); }
  });

  it('flags TECH_ON_LOGIC_COMPONENT when an Orchestrator binds a technology', () => {
    const proj = createTempProject();
    proj.component('orch-a', 'Orchestrator');
    proj.writeSpec('interface', 'iorch-a', `schemaVersion: 1.0.0
id: iorch-a
name: IOrch
description: d
component: orch-a
methods:
  - name: run
    description: Runs the workflow end to end.
    signature: "run(): Promise<void>"
    returns: "Promise<void>"`);
    proj.writeSpec('implementation', 'impl-orch-a', `schemaVersion: 1.0.0
id: impl-orch-a
name: ImplOrch
description: d
contract: iorch-a
technologies: [redis]
methods:
  - name: run
    narrative:
      - { stepNumber: 1, description: coordinate the workflow, type: local }`);
    proj.activate();
    try {
      const issues = techIssues(validateSddTree());
      expect(issues.some(i => i.code === 'TECH_ON_LOGIC_COMPONENT' && i.specId === 'impl-orch-a')).toBe(true);
    } finally { proj.cleanup(); }
  });

  it('flags a facade bypass: dependsOn targeting the tech-named adapter from outside', () => {
    const proj = createTempProject();
    proj.component('mysql-adapter', 'Adapter');
    proj.writeSpec('interface', 'imysql-adapter', `schemaVersion: 1.0.0
id: imysql-adapter
name: IRowAccess
description: Row-level persistence access.
component: mysql-adapter
methods:
  - name: fetchRow
    description: Fetches one row.
    signature: "fetchRow(id: string): Promise<string>"
    returns: "Promise<string>"`);
    proj.writeSpec('implementation', 'impl-mysql-adapter', `schemaVersion: 1.0.0
id: impl-mysql-adapter
name: ImplRowAccess
description: MySQL binding.
contract: imysql-adapter
technologies: [mysql]
methods:
  - name: fetchRow
    detail: intent
    intent: Runs a parameterized SELECT and returns the serialized row, or an empty payload when the id is unknown.`);
    proj.component('rogue-orch', 'Orchestrator', 'dependsOn: [mysql-adapter]');
    proj.activate();
    try {
      const issues = techIssues(validateSddTree());
      expect(issues.some(i => i.code === 'TECH_LEAKAGE' && i.specId === 'rogue-orch')).toBe(true);
      // The adapter itself (id contains the token) is in scope — never flagged.
      expect(issues.some(i => i.specId === 'mysql-adapter')).toBe(false);
    } finally { proj.cleanup(); }
  });

  it('flags a vendor-shaped type in the shared type space', () => {
    const proj = createTempProject();
    writeRepositoryBoundary(proj);
    proj.writeSpec('type', 'mysql_row', `schemaVersion: 1.0.0
kind: value-object
id: mysql_row
name: MySqlRow
description: Raw row shape.
fields:
  - name: id
    type: string`);
    proj.activate();
    try {
      const issues = techIssues(validateSddTree());
      expect(issues.some(i => i.code === 'TECH_LEAKAGE' && i.specId === 'mysql_row')).toBe(true);
    } finally { proj.cleanup(); }
  });

  it('lint.allow suppresses TECH_LEAKAGE on the flagged spec', () => {
    const proj = createTempProject();
    writeRepositoryBoundary(proj);
    proj.writeSpec('component', 'billing-portal', `schemaVersion: 1.0.0
id: billing-portal
name: billing-portal
description: Renders MySQL rows directly for billing
subsystem: sub-a
componentType: Portal
portalType: HTTP_API
lint:
  allow:
    - code: TECH_LEAKAGE
      reason: legacy naming, cleanup tracked separately`);
    proj.activate();
    try {
      const res = validateSddTree();
      expect(techIssues(res).some(i => i.specId === 'billing-portal')).toBe(false);
      expect(res.issues.some(i => i.code === 'UNUSED_LINT_ALLOW' && i.specId === 'billing-portal')).toBe(false);
    } finally { proj.cleanup(); }
  });

  it('ignores tokens shorter than 3 characters', () => {
    const proj = createTempProject();
    writeRepositoryBoundary(proj);
    proj.writeSpec('implementation', 'impl-cust-adapter', `schemaVersion: 1.0.0
id: impl-cust-adapter
name: ImplCustAdapter
description: Native binding.
contract: icust-adapter
technologies: [c]
methods:
  - name: fetchRow
    detail: intent
    intent: Executes a parameterized SELECT against the customers table and maps the row into the serialized payload.`);
    proj.writeSpec('component', 'c-portal', `schemaVersion: 1.0.0
id: c-portal
name: c-portal
description: c everywhere c c
subsystem: sub-a
componentType: Portal
portalType: HTTP_API`);
    proj.activate();
    try {
      expect(techIssues(validateSddTree())).toHaveLength(0);
    } finally { proj.cleanup(); }
  });
});
