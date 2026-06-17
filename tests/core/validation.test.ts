import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { validateRegistry, validateProjectConfig, validateSddTree } from '../../src/core/validation.js';
import { createEmptyRegistry } from '../../src/models/registry.js';
import { createAgentRecord } from '../../src/models/agent.js';
import { RulesConfig } from '../../src/models/project.js';

const defaultRules: RulesConfig = {
  noOverlappingOwnership: true,
  requireOwnedPaths: true,
  metaAgentTags: ['meta', 'guardian', 'architect'],
  enforceReproducibility: true,
};

describe('validateRegistry', () => {
  it('passes for an empty registry', () => {
    const registry = createEmptyRegistry();
    const result = validateRegistry(registry, defaultRules);
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('detects duplicate agent ids', () => {
    const registry = createEmptyRegistry();
    const agent = createAgentRecord({
      id: 'my-agent',
      name: 'My Agent',
      template: 'domain-owner',
      creationReason: 'test',
      ownedPaths: ['src/**'],
    });
    registry.agents.push(agent, { ...agent });

    const result = validateRegistry(registry, defaultRules);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'DUPLICATE_AGENT_ID')).toBe(true);
  });

  it('warns when a non-meta agent has no ownedPaths', () => {
    const registry = createEmptyRegistry();
    registry.agents.push(
      createAgentRecord({
        id: 'orphan-agent',
        name: 'Orphan',
        template: 'implementer',
        creationReason: 'test',
        ownedPaths: [],
      }),
    );

    const result = validateRegistry(registry, defaultRules);
    expect(result.issues.some((i) => i.code === 'NO_OWNED_PATHS')).toBe(true);
  });

  it('does not warn about missing ownedPaths for meta-tagged agents', () => {
    const registry = createEmptyRegistry();
    registry.agents.push(
      createAgentRecord({
        id: 'my-architect',
        name: 'Architect',
        template: 'architect',
        creationReason: 'test',
        ownedPaths: [],
        tags: ['meta', 'architect'],
      }),
    );

    const result = validateRegistry(registry, defaultRules);
    expect(result.issues.filter((i) => i.code === 'NO_OWNED_PATHS')).toHaveLength(0);
  });

  it('detects overlapping ownedPaths', () => {
    const registry = createEmptyRegistry();
    registry.agents.push(
      createAgentRecord({
        id: 'agent-a',
        name: 'Agent A',
        template: 'domain-owner',
        creationReason: 'test',
        ownedPaths: ['services/core/**'],
      }),
      createAgentRecord({
        id: 'agent-b',
        name: 'Agent B',
        template: 'domain-owner',
        creationReason: 'test',
        ownedPaths: ['services/core/**'],
      }),
    );

    const result = validateRegistry(registry, defaultRules);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'OVERLAPPING_OWNERSHIP')).toBe(true);
  });
});

describe('validateProjectConfig', () => {
  it('fails when no targets are configured', () => {
    const config = {
      schemaVersion: '1.0.0',
      name: 'test',
      targets: [],
      rules: defaultRules,
      createdAt: '2026-04-10T12:00:00.000Z',
      updatedAt: '2026-04-10T12:00:00.000Z',
    };

    const result = validateProjectConfig(config);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'NO_TARGETS')).toBe(true);
  });

  it('passes when a valid target is configured', () => {
    const config = {
      schemaVersion: '1.0.0',
      name: 'test',
      targets: [{ type: 'claude' as const, outputDir: '.claude/agents', enabled: true }],
      rules: defaultRules,
      createdAt: '2026-04-10T12:00:00.000Z',
      updatedAt: '2026-04-10T12:00:00.000Z',
    };

    const result = validateProjectConfig(config);
    expect(result.valid).toBe(true);
  });
});

describe('validateSddTree', () => {
  function createTempProject() {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-sdd-test-'));
    const originalCwd = process.cwd();

    // Create .wai directory and project.yaml
    const waiDir = path.join(tempDir, '.wai');
    fs.mkdirSync(waiDir);
    fs.writeFileSync(path.join(waiDir, 'project.yaml'), JSON.stringify({
      schemaVersion: '1.0.0',
      name: 'test-project',
      targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
      rules: defaultRules,
    }));

    const specsDir = path.join(waiDir, 'specs');
    fs.mkdirSync(specsDir);
    fs.mkdirSync(path.join(specsDir, 'subsystems'));
    fs.mkdirSync(path.join(specsDir, 'components'));
    fs.mkdirSync(path.join(specsDir, 'interfaces'));
    fs.mkdirSync(path.join(specsDir, 'implementations'));

    return {
      tempDir,
      originalCwd,
      writeSpec: (type: 'system' | 'subsystem' | 'component' | 'interface' | 'implementation', name: string, content: string) => {
        let filePath = '';
        if (type === 'system') {
          filePath = path.join(specsDir, 'system.yaml');
        } else {
          filePath = path.join(specsDir, `${type}s`, `${name}.yaml`);
        }
        fs.writeFileSync(filePath, content);
      },
      activate: () => {
        vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
      },
      cleanup: () => {
        vi.restoreAllMocks();
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (e) {
          // ignore cleanup errors on windows if file locks occur
        }
      }
    };
  }

  it('passes validation for a clean, correct spec tree', () => {
    const proj = createTempProject();
    proj.writeSpec('system', 'system', `
schemaVersion: 1.0.0
name: TestSystem
vision: A system for testing
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);
    proj.writeSpec('subsystem', 'sub-a', `
schemaVersion: 1.0.0
id: sub-a
name: SubsystemA
description: Subsystem A description
parentSystem: TestSystem
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);
    proj.writeSpec('component', 'comp-a', `
schemaVersion: 1.0.0
id: comp-a
name: ComponentA
description: Component A description
subsystem: sub-a
componentType: Orchestrator
dependsOn: []
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);
    proj.writeSpec('interface', 'icomp-a', `
schemaVersion: 1.0.0
id: icomp-a
name: InterfaceA
description: Interface A description
component: comp-a
methods:
  - name: doSomething
    description: Do something
    signature: "doSomething(): Promise<void>"
    returns: "Promise<void>"
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);
    proj.writeSpec('implementation', 'impl-a', `
schemaVersion: 1.0.0
id: impl-a
name: ImplementationA
description: Implementation A description
contract: icomp-a
sourcePath: src/comp-a.ts
methods:
  - name: doSomething
    narrative:
      - stepNumber: 1
        description: Local work step
        type: local
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);

    proj.activate();
    try {
      const res = validateSddTree();
      expect(res.valid).toBe(true);
      expect(res.issues).toHaveLength(0);
    } finally {
      proj.cleanup();
    }
  });

  it('enforces pattern ownership rules (owns): containment + block-owns-members', () => {
    const proj = createTempProject();
    proj.writeSpec('system', 'system', `
schemaVersion: 1.0.0
name: TestSystem
vision: A system for testing
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);
    proj.writeSpec('subsystem', 'sub-a', `
id: sub-a
name: Sub A
description: test subsystem
parentSystem: TestSystem
status: complete
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);
    // Repository owning an Orchestrator (not a data block) -> REPOSITORY_CONTAINMENT
    proj.writeSpec('component', 'bad-repo', `
id: bad-repo
name: Bad Repo
description: repo owning a non-data block
subsystem: sub-a
componentType: Repository
owns: [some-orch]
dependsOn: []
status: complete
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);
    proj.writeSpec('component', 'some-orch', `
id: some-orch
name: Some Orchestrator
description: wrongly owned by a repo and a store
subsystem: sub-a
componentType: Orchestrator
owns: []
dependsOn: []
status: complete
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);
    // A Store (building block) that wrongly declares owns -> BLOCK_OWNS_MEMBERS
    proj.writeSpec('component', 'bad-store', `
id: bad-store
name: Bad Store
description: a block that wrongly owns members
subsystem: sub-a
componentType: Store
owns: [some-orch]
dependsOn: []
status: complete
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);
    proj.activate();
    try {
      const res = validateSddTree();
      expect(res.valid).toBe(false);
      expect(res.issues.some(i => i.code === 'REPOSITORY_CONTAINMENT')).toBe(true);
      expect(res.issues.some(i => i.code === 'BLOCK_OWNS_MEMBERS')).toBe(true);
    } finally {
      proj.cleanup();
    }
  });

  it('allows intra-group member dependencies but rejects outside access to a private member', () => {
    const proj = createTempProject();
    const meta = `status: complete\ncreatedAt: '2026-06-10T22:00:00Z'\nupdatedAt: '2026-06-10T22:00:00Z'`;
    proj.writeSpec('system', 'system', `\nschemaVersion: 1.0.0\nname: TestSystem\nvision: A system for testing\ncreatedAt: '2026-06-10T22:00:00Z'\nupdatedAt: '2026-06-10T22:00:00Z'\n`);
    proj.writeSpec('subsystem', 'sub-a', `\nid: sub-a\nname: Sub A\ndescription: test\nparentSystem: TestSystem\n${meta}\n`);
    proj.writeSpec('component', 'repo', `\nid: repo\nname: Repo\ndescription: data access\nsubsystem: sub-a\ncomponentType: Repository\nowns: [repo-store, repo-registry, repo-index, repo-adapter]\ndependsOn: []\n${meta}\n`);
    proj.writeSpec('component', 'repo-store', `\nid: repo-store\nname: Store\ndescription: state\nsubsystem: sub-a\ncomponentType: Store\nowns: []\ndependsOn: [repo-adapter]\n${meta}\n`);
    proj.writeSpec('component', 'repo-registry', `\nid: repo-registry\nname: Registry\ndescription: writes\nsubsystem: sub-a\ncomponentType: Registry\nowns: []\ndependsOn: [repo-store]\n${meta}\n`);
    proj.writeSpec('component', 'repo-index', `\nid: repo-index\nname: Index\ndescription: reads\nsubsystem: sub-a\ncomponentType: Index\nowns: []\ndependsOn: [repo-store]\n${meta}\n`);
    proj.writeSpec('component', 'repo-adapter', `\nid: repo-adapter\nname: Adapter\ndescription: backend\nsubsystem: sub-a\ncomponentType: Adapter\nowns: []\ndependsOn: []\n${meta}\n`);
    // Outside orchestrator: depends on the repo facade (OK) and reaches into a private member (BAD)
    proj.writeSpec('component', 'orch', `\nid: orch\nname: Orchestrator\ndescription: workflow\nsubsystem: sub-a\ncomponentType: Orchestrator\nowns: []\ndependsOn: [repo, repo-store]\n${meta}\n`);
    proj.activate();
    try {
      const res = validateSddTree();
      const vis = res.issues.filter(i => i.code === 'VISIBILITY_VIOLATION');
      // Intra-group member deps (store->adapter, registry->store, index->store) must NOT be flagged.
      expect(vis.some(i => i.specId === 'repo-store' || i.specId === 'repo-registry' || i.specId === 'repo-index')).toBe(false);
      // The outside orchestrator reaching into the private member `repo-store` MUST be flagged.
      expect(vis.some(i => i.specId === 'orch')).toBe(true);
    } finally {
      proj.cleanup();
    }
  });

  it('collects and reports schema validation errors (Zod errors) rather than swallowing them', () => {
    const proj = createTempProject();
    proj.writeSpec('system', 'system', `
schemaVersion: 1.0.0
name: TestSystem
vision: A system for testing
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);
    // Invalid component ID (not matching regex: lowercase alphanumeric with dashes/underscores)
    proj.writeSpec('component', 'invalid-comp', `
schemaVersion: 1.0.0
id: INVALID_ID_WITH_CAPS
name: ComponentA
description: Invalid component ID
subsystem: sub-a
componentType: Orchestrator
dependsOn: []
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);

    proj.activate();
    try {
      const res = validateSddTree();
      expect(res.valid).toBe(false);
      expect(res.issues.some(i => i.code === 'SCHEMA_VALIDATION_ERROR')).toBe(true);
      const schemaErr = res.issues.find(i => i.code === 'SCHEMA_VALIDATION_ERROR');
      expect(schemaErr?.message).toContain('Failed to parse component spec');
    } finally {
      proj.cleanup();
    }
  });

  it('fails with UNDECLARED_DEPENDENCY_CALL when a call step targets a component not in dependencies', () => {
    const proj = createTempProject();
    proj.writeSpec('system', 'system', `
schemaVersion: 1.0.0
name: TestSystem
vision: A system for testing
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);
    proj.writeSpec('subsystem', 'sub-a', `
schemaVersion: 1.0.0
id: sub-a
name: SubsystemA
description: Subsystem A description
parentSystem: TestSystem
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);
    // comp-a has NO dependencies
    proj.writeSpec('component', 'comp-a', `
schemaVersion: 1.0.0
id: comp-a
name: ComponentA
description: Component A description
subsystem: sub-a
componentType: Orchestrator
dependsOn: []
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);
    proj.writeSpec('component', 'comp-b', `
schemaVersion: 1.0.0
id: comp-b
name: ComponentB
description: Component B description
subsystem: sub-a
componentType: Store
dependsOn: []
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);

    proj.writeSpec('interface', 'icomp-a', `
schemaVersion: 1.0.0
id: icomp-a
name: InterfaceA
description: Interface A description
component: comp-a
methods:
  - name: doSomething
    description: Do something
    signature: "doSomething(): Promise<void>"
    returns: "Promise<void>"
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);
    proj.writeSpec('interface', 'icomp-b', `
schemaVersion: 1.0.0
id: icomp-b
name: InterfaceB
description: Interface B description
component: comp-b
methods:
  - name: getData
    description: Get data
    signature: "getData(): Promise<void>"
    returns: "Promise<void>"
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);

    // impl-a calls comp-b, but comp-a does not list comp-b as a dependency!
    proj.writeSpec('implementation', 'impl-a', `
schemaVersion: 1.0.0
id: impl-a
name: ImplementationA
description: Implementation A description
contract: icomp-a
sourcePath: src/comp-a.ts
methods:
  - name: doSomething
    narrative:
      - stepNumber: 1
        description: Call comp-b which is not a dependency
        type: call
        targetComponent: comp-b
        targetMethod: getData
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);

    proj.activate();
    try {
      const res = validateSddTree();
      expect(res.valid).toBe(false);
      expect(res.issues.some(i => i.code === 'UNDECLARED_DEPENDENCY_CALL')).toBe(true);
      const depErr = res.issues.find(i => i.code === 'UNDECLARED_DEPENDENCY_CALL');
      expect(depErr?.message).toContain('calls component "comp-b" (step 1) but component "comp-a" does not list "comp-b" as a dependency');
    } finally {
      proj.cleanup();
    }
  });

  it('detects circular dependency loops with CIRCULAR_DEPENDENCY and lists the path cycle', () => {
    const proj = createTempProject();
    proj.writeSpec('system', 'system', `
schemaVersion: 1.0.0
name: TestSystem
vision: A system for testing
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);
    proj.writeSpec('subsystem', 'sub-a', `
schemaVersion: 1.0.0
id: sub-a
name: SubsystemA
description: Subsystem A description
parentSystem: TestSystem
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);
    // comp-a depends on comp-b
    proj.writeSpec('component', 'comp-a', `
schemaVersion: 1.0.0
id: comp-a
name: ComponentA
description: Component A description
subsystem: sub-a
componentType: Orchestrator
dependsOn: [comp-b]
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);
    // comp-b depends on comp-a (Cycle: comp-a -> comp-b -> comp-a)
    proj.writeSpec('component', 'comp-b', `
schemaVersion: 1.0.0
id: comp-b
name: ComponentB
description: Component B description
subsystem: sub-a
componentType: Store
dependsOn: [comp-a]
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);

    proj.activate();
    try {
      const res = validateSddTree();
      expect(res.valid).toBe(false);
      expect(res.issues.some(i => i.code === 'CIRCULAR_DEPENDENCY')).toBe(true);
      const cycleErr = res.issues.find(i => i.code === 'CIRCULAR_DEPENDENCY');
      expect(cycleErr?.message).toContain('Circular dependency detected');
      // Should show the path cycle
      expect(cycleErr?.message).toContain('comp-a -> comp-b -> comp-a');
    } finally {
      proj.cleanup();
    }
  });

  it('enforces Portal type validation rules and boundary constraints', () => {
    const proj = createTempProject();
    proj.writeSpec('system', 'system', `
schemaVersion: 1.0.0
name: TestSystem
vision: A system for testing
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);
    proj.writeSpec('subsystem', 'sub-a', `
schemaVersion: 1.0.0
id: sub-a
name: SubsystemA
description: Subsystem A description
parentSystem: TestSystem
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);
    // comp-a has type Portal but missing portalType
    proj.writeSpec('component', 'comp-a', `
schemaVersion: 1.0.0
id: comp-a
name: ComponentA
description: Component A description
subsystem: sub-a
componentType: Portal
dependsOn: []
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);

    proj.activate();
    try {
      const res = validateSddTree();
      expect(res.valid).toBe(false);
      expect(res.issues.some(i => i.code === 'MISSING_PORTAL_TYPE')).toBe(true);
    } finally {
      proj.cleanup();
    }
  });

  it('enforces gRPC and MessageBus endpoint validations on Portals', () => {
    const proj = createTempProject();
    proj.writeSpec('system', 'system', `
schemaVersion: 1.0.0
name: TestSystem
vision: A system for testing
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);
    proj.writeSpec('subsystem', 'sub-a', `
schemaVersion: 1.0.0
id: sub-a
name: SubsystemA
description: Subsystem A description
parentSystem: TestSystem
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);
    // comp-grpc is type Portal, portalType: gRPC
    proj.writeSpec('component', 'comp-grpc', `
schemaVersion: 1.0.0
id: comp-grpc
name: ComponentGrpc
description: gRPC component
subsystem: sub-a
componentType: Portal
portalType: gRPC
dependsOn: []
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);
    // interface is missing grpcEndpoint
    proj.writeSpec('interface', 'icomp-grpc', `
schemaVersion: 1.0.0
id: icomp-grpc
name: InterfaceGrpc
description: Interface gRPC
component: comp-grpc
methods:
  - name: doRpc
    description: RPC method
    signature: "doRpc(): Promise<void>"
    returns: "Promise<void>"
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);

    proj.activate();
    try {
      const res = validateSddTree();
      expect(res.valid).toBe(false);
      expect(res.issues.some(i => i.code === 'MISSING_GRPC_ENDPOINT')).toBe(true);
    } finally {
      proj.cleanup();
    }
  });

  it('downgrades completeness rules to warnings when status is draft or design', () => {
    const proj = createTempProject();
    proj.writeSpec('system', 'system', `
schemaVersion: 1.0.0
name: TestSystem
vision: A system for testing
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);
    proj.writeSpec('subsystem', 'sub-a', `
schemaVersion: 1.0.0
id: sub-a
name: SubsystemA
description: Subsystem A description
parentSystem: TestSystem
status: draft
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);
    // comp-a has type Portal, portalType: HTTP_API, and is draft because subsystem is draft
    proj.writeSpec('component', 'comp-a', `
schemaVersion: 1.0.0
id: comp-a
name: ComponentA
description: Component A description
subsystem: sub-a
componentType: Portal
portalType: HTTP_API
dependsOn: []
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);
    // interface is missing httpEndpoint (normally a hard error)
    proj.writeSpec('interface', 'icomp-a', `
schemaVersion: 1.0.0
id: icomp-a
name: InterfaceA
description: Interface A description
component: comp-a
methods:
  - name: callApi
    description: Api method
    signature: "callApi(): Promise<void>"
    returns: "Promise<void>"
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);

    proj.activate();
    try {
      const res = validateSddTree();
      // Since it's in draft mode, it should be valid (errors downgraded to warnings)
      expect(res.valid).toBe(true);
      expect(res.issues.some(i => i.code === 'MISSING_HTTP_ENDPOINT' && i.severity === 'warning')).toBe(true);
      expect(res.issues.some(i => i.code === 'DRAFT_COMPONENT_WARNING')).toBe(true);
    } finally {
      proj.cleanup();
    }
  });

  it('allows user overrides for rule severity', () => {
    const proj = createTempProject();
    proj.writeSpec('system', 'system', `
schemaVersion: 1.0.0
name: TestSystem
vision: A system for testing
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);
    proj.writeSpec('subsystem', 'sub-a', `
schemaVersion: 1.0.0
id: sub-a
name: SubsystemA
description: Subsystem A description
parentSystem: TestSystem
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);
    // comp-a has type Portal, portalType: HTTP_API, and is complete (default)
    proj.writeSpec('component', 'comp-a', `
schemaVersion: 1.0.0
id: comp-a
name: ComponentA
description: Component A description
subsystem: sub-a
componentType: Portal
portalType: HTTP_API
dependsOn: []
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);
    // interface is missing httpEndpoint (normally a hard error)
    proj.writeSpec('interface', 'icomp-a', `
schemaVersion: 1.0.0
id: icomp-a
name: InterfaceA
description: Interface A description
component: comp-a
methods:
  - name: callApi
    description: Api method
    signature: "callApi(): Promise<void>"
    returns: "Promise<void>"
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);

    proj.activate();
    try {
      // 1. By default, it fails with error severity
      const resDefault = validateSddTree();
      expect(resDefault.valid).toBe(false);
      expect(resDefault.issues.some(i => i.code === 'MISSING_HTTP_ENDPOINT' && i.severity === 'error')).toBe(true);

      // 2. With override severity to warning, it passes
      const rulesWithWarningOverride = {
        ...defaultRules,
        sddRuleSeverity: {
          'MISSING_HTTP_ENDPOINT': 'warning' as const
        }
      };
      const resWarning = validateSddTree(rulesWithWarningOverride);
      expect(resWarning.valid).toBe(true);
      expect(resWarning.issues.some(i => i.code === 'MISSING_HTTP_ENDPOINT' && i.severity === 'warning')).toBe(true);

      // 3. With override severity to off, it ignores the issue completely
      const rulesWithOffOverride = {
        ...defaultRules,
        sddRuleSeverity: {
          'MISSING_HTTP_ENDPOINT': 'off' as const
        }
      };
      const resOff = validateSddTree(rulesWithOffOverride);
      expect(resOff.valid).toBe(true);
      expect(resOff.issues.some(i => i.code === 'MISSING_HTTP_ENDPOINT')).toBe(false);
    } finally {
      proj.cleanup();
    }
  });

  it('parses system.yaml boundaries and globalRequirements containing objects', () => {
    const proj = createTempProject();
    proj.writeSpec('system', 'system', `
schemaVersion: 1.0.0
name: TestSystem
vision: A system for testing
boundaries:
  - name: test-boundary
    description: A boundary defined as an object
globalRequirements:
  - description: A requirement defined as an object
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);
    proj.activate();
    try {
      const res = validateSddTree();
      // It should successfully parse and not throw MISSING_SYSTEM_SPEC or SCHEMA_VALIDATION_ERROR for this
      expect(res.issues.some(i => i.code === 'SCHEMA_VALIDATION_ERROR')).toBe(false);
      expect(res.issues.some(i => i.code === 'MISSING_SYSTEM_SPEC')).toBe(false);
    } finally {
      proj.cleanup();
    }
  });

  it('fails validation when a Portal depends directly on a Store, Repository, or Adapter', () => {
    const proj = createTempProject();
    proj.writeSpec('system', 'system', `
schemaVersion: 1.0.0
name: TestSystem
vision: A system for testing
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);
    proj.writeSpec('subsystem', 'sub-a', `
schemaVersion: 1.0.0
id: sub-a
name: SubsystemA
description: Subsystem A description
parentSystem: TestSystem
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);
    // comp-a is a Portal depending on comp-b (Store)
    proj.writeSpec('component', 'comp-a', `
schemaVersion: 1.0.0
id: comp-a
name: PortalComponent
description: A portal entry point
subsystem: sub-a
componentType: Portal
portalType: HTTP_API
dependsOn:
  - comp-b
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);
    proj.writeSpec('component', 'comp-b', `
schemaVersion: 1.0.0
id: comp-b
name: StoreComponent
description: A store component
subsystem: sub-a
componentType: Store
dependsOn: []
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`);

    proj.activate();
    try {
      const res = validateSddTree();
      expect(res.valid).toBe(false);
      expect(res.issues.some(i => i.code === 'ARCHITECTURE_VIOLATION_PORTAL_FORBIDDEN_DEP')).toBe(true);
    } finally {
      proj.cleanup();
    }
  });

  // ---- Subsystem boundary rules (cross-subsystem + public interface binding) ----

  const SYS = `
schemaVersion: 1.0.0
name: TestSystem
vision: A system for testing
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`;
  const sub = (id: string, publicInterfaces = ''): string => `
schemaVersion: 1.0.0
id: ${id}
name: ${id}
description: ${id} description
parentSystem: TestSystem
${publicInterfaces}createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`;
  const comp = (id: string, subsystem: string, componentType: string, opts: { dependsOn?: string[]; portalType?: string } = {}): string => `
schemaVersion: 1.0.0
id: ${id}
name: ${id}
description: ${id} description
subsystem: ${subsystem}
componentType: ${componentType}
${opts.portalType ? `portalType: ${opts.portalType}\n` : ''}dependsOn: [${(opts.dependsOn ?? []).join(', ')}]
createdAt: '2026-06-10T22:00:00Z'
updatedAt: '2026-06-10T22:00:00Z'
`;

  it('flags a non-Adapter reaching another subsystem (CROSS_SUBSYSTEM_NON_ADAPTER + PRIVATE_ACCESS)', () => {
    const proj = createTempProject();
    proj.writeSpec('system', 'system', SYS);
    proj.writeSpec('subsystem', 'sub-a', sub('sub-a'));
    proj.writeSpec('subsystem', 'sub-b', sub('sub-b'));
    proj.writeSpec('component', 'orch-a', comp('orch-a', 'sub-a', 'Orchestrator', { dependsOn: ['store-b'] }));
    proj.writeSpec('component', 'store-b', comp('store-b', 'sub-b', 'Store'));
    proj.activate();
    try {
      const res = validateSddTree();
      expect(res.valid).toBe(false);
      expect(res.issues.some(i => i.code === 'CROSS_SUBSYSTEM_NON_ADAPTER')).toBe(true);
      expect(res.issues.some(i => i.code === 'CROSS_SUBSYSTEM_PRIVATE_ACCESS')).toBe(true);
    } finally {
      proj.cleanup();
    }
  });

  it('allows an Adapter reaching another subsystem\'s published public component', () => {
    const proj = createTempProject();
    proj.writeSpec('system', 'system', SYS);
    proj.writeSpec('subsystem', 'sub-a', sub('sub-a'));
    proj.writeSpec('subsystem', 'sub-b', sub('sub-b',
      'publicInterfaces:\n  - type: Custom\n    details: facade\n    component: facade-b\n'));
    proj.writeSpec('component', 'adapter-a', comp('adapter-a', 'sub-a', 'Adapter', { dependsOn: ['facade-b'] }));
    proj.writeSpec('component', 'facade-b', comp('facade-b', 'sub-b', 'Orchestrator'));
    proj.activate();
    try {
      const res = validateSddTree();
      expect(res.issues.some(i => i.code.startsWith('CROSS_SUBSYSTEM_'))).toBe(false);
      expect(res.valid).toBe(true);
    } finally {
      proj.cleanup();
    }
  });

  it('flags an Adapter reaching another subsystem\'s INTERNAL (non-public) component', () => {
    const proj = createTempProject();
    proj.writeSpec('system', 'system', SYS);
    proj.writeSpec('subsystem', 'sub-a', sub('sub-a'));
    proj.writeSpec('subsystem', 'sub-b', sub('sub-b'));
    proj.writeSpec('component', 'adapter-a', comp('adapter-a', 'sub-a', 'Adapter', { dependsOn: ['store-b'] }));
    proj.writeSpec('component', 'store-b', comp('store-b', 'sub-b', 'Store'));
    proj.activate();
    try {
      const res = validateSddTree();
      expect(res.issues.some(i => i.code === 'CROSS_SUBSYSTEM_PRIVATE_ACCESS')).toBe(true);
      expect(res.issues.some(i => i.code === 'CROSS_SUBSYSTEM_NON_ADAPTER')).toBe(false);
    } finally {
      proj.cleanup();
    }
  });

  it('flags a public interface with no backing component (PUBLIC_INTERFACE_UNBOUND)', () => {
    const proj = createTempProject();
    proj.writeSpec('system', 'system', SYS);
    proj.writeSpec('subsystem', 'sub-b', sub('sub-b',
      'publicInterfaces:\n  - type: MessageBus\n    details: queue\n'));
    proj.activate();
    try {
      const res = validateSddTree();
      expect(res.valid).toBe(false);
      expect(res.issues.some(i => i.code === 'PUBLIC_INTERFACE_UNBOUND')).toBe(true);
    } finally {
      proj.cleanup();
    }
  });

  it('flags a MessageBus interface backed by an incompatible component (TYPE_MISMATCH)', () => {
    const proj = createTempProject();
    proj.writeSpec('system', 'system', SYS);
    proj.writeSpec('subsystem', 'sub-b', sub('sub-b',
      'publicInterfaces:\n  - type: MessageBus\n    details: queue\n    component: orch-b\n'));
    proj.writeSpec('component', 'orch-b', comp('orch-b', 'sub-b', 'Orchestrator'));
    proj.activate();
    try {
      const res = validateSddTree();
      expect(res.valid).toBe(false);
      expect(res.issues.some(i => i.code === 'PUBLIC_INTERFACE_TYPE_MISMATCH')).toBe(true);
    } finally {
      proj.cleanup();
    }
  });

  it('accepts a MessageBus interface backed by an Observer', () => {
    const proj = createTempProject();
    proj.writeSpec('system', 'system', SYS);
    proj.writeSpec('subsystem', 'sub-b', sub('sub-b',
      'publicInterfaces:\n  - type: MessageBus\n    details: queue\n    component: obs-b\n'));
    proj.writeSpec('component', 'obs-b', comp('obs-b', 'sub-b', 'Observer'));
    proj.activate();
    try {
      const res = validateSddTree();
      expect(res.issues.some(i => i.code.startsWith('PUBLIC_INTERFACE_'))).toBe(false);
      expect(res.valid).toBe(true);
    } finally {
      proj.cleanup();
    }
  });

  it('warns when a Custom interface describes eventing but is backed by a non-event component (EVENT_MISTYPED)', () => {
    const proj = createTempProject();
    proj.writeSpec('system', 'system', SYS);
    proj.writeSpec('subsystem', 'sub-b', sub('sub-b',
      'publicInterfaces:\n  - type: Custom\n    details: Asynchronous dispatcher queue listening for limit warning events\n    component: orch-b\n'));
    proj.writeSpec('component', 'orch-b', comp('orch-b', 'sub-b', 'Orchestrator'));
    proj.activate();
    try {
      const res = validateSddTree();
      const issue = res.issues.find(i => i.code === 'PUBLIC_INTERFACE_EVENT_MISTYPED');
      expect(issue).toBeDefined();
      expect(issue!.severity).toBe('warning');
    } finally {
      proj.cleanup();
    }
  });

  it('does NOT warn when a Custom event interface is genuinely backed by an Observer', () => {
    const proj = createTempProject();
    proj.writeSpec('system', 'system', SYS);
    proj.writeSpec('subsystem', 'sub-b', sub('sub-b',
      'publicInterfaces:\n  - type: Custom\n    details: Asynchronous queue listening for events\n    component: obs-b\n'));
    proj.writeSpec('component', 'obs-b', comp('obs-b', 'sub-b', 'Observer'));
    proj.activate();
    try {
      const res = validateSddTree();
      expect(res.issues.some(i => i.code === 'PUBLIC_INTERFACE_EVENT_MISTYPED')).toBe(false);
    } finally {
      proj.cleanup();
    }
  });

  it('does NOT warn on a Custom interface with no event vocabulary', () => {
    const proj = createTempProject();
    proj.writeSpec('system', 'system', SYS);
    proj.writeSpec('subsystem', 'sub-b', sub('sub-b',
      'publicInterfaces:\n  - type: Custom\n    details: Synchronous facade for account lookups\n    component: orch-b\n'));
    proj.writeSpec('component', 'orch-b', comp('orch-b', 'sub-b', 'Orchestrator'));
    proj.activate();
    try {
      const res = validateSddTree();
      expect(res.issues.some(i => i.code === 'PUBLIC_INTERFACE_EVENT_MISTYPED')).toBe(false);
    } finally {
      proj.cleanup();
    }
  });
});


