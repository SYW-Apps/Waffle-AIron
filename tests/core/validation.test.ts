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
dependencies: []
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
dependencies: []
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
dependencies: []
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
dependencies: []
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
dependencies: [comp-b]
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
dependencies: [comp-a]
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
dependencies: []
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
dependencies: []
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
});


