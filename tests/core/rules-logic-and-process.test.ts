import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { validateSddTree, validateComponentCandidate } from '../../src/core/validation.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import type { ComponentSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// The blocks doctrine (D1) as the rules enforce it:
//  - logic is an Orchestrator, and its dependencyClass (pure | read) bounds
//    what it may depend on; any block may use pure logic;
//  - a Supervisor reaches data only through workflows, and a live Actor is
//    reached through a Supervisor that supervises it;
//  - a Query is a Repository member for computed reads over its Store;
//  - Specialist and Gateway are retired: each retired component reports
//    STEREOTYPE_RETIRED once, and no shape rule judges it or its edges.
// ---------------------------------------------------------------------------

interface Issue { code: string; specId?: string; message: string; severity: string }

function createTempProject() {
  invalidateSpecCache();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-logic-process-'));

  const waiDir = path.join(tempDir, '.wai');
  fs.mkdirSync(waiDir);
  fs.writeFileSync(path.join(waiDir, 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0',
    name: 'test-project',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: { noOverlappingOwnership: true, requireOwnedPaths: true, metaAgentTags: ['meta'], enforceReproducibility: true },
  }));

  const specsDir = path.join(waiDir, 'specs');
  for (const d of ['subsystems', 'components', 'interfaces', 'implementations', 'types']) {
    fs.mkdirSync(path.join(specsDir, d), { recursive: true });
  }

  const stamp = "createdAt: '2026-09-15T10:00:00Z'\nupdatedAt: '2026-09-15T10:00:00Z'";
  const writeSpec = (type: string, name: string, content: string) => {
    const filePath = type === 'system'
      ? path.join(specsDir, '.index.yaml')
      : path.join(specsDir, `${type}s`, `${name}.yaml`);
    fs.writeFileSync(filePath, `${content}\n${stamp}\n`);
  };

  writeSpec('system', 'system', 'schemaVersion: 1.0.0\nname: TestSystem\nvision: testing');

  return {
    spec: writeSpec,
    subsystem: (id: string, extra = '') =>
      writeSpec('subsystem', id, `schemaVersion: 1.0.0\nid: ${id}\nname: ${id}\ndescription: d\nparentSystem: TestSystem\n${extra}`),
    component: (id: string, sub: string, type: string, extra = '') =>
      writeSpec('component', id, `schemaVersion: 1.0.0\nid: ${id}\nname: ${id}\ndescription: d\nsubsystem: ${sub}\ncomponentType: ${type}\n${extra}`),
    validate: (): Issue[] => {
      vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
      try {
        return validateSddTree().issues as Issue[];
      } finally {
        invalidateSpecCache();
        vi.restoreAllMocks();
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* win file locks */ }
      }
    },
  };
}

const byCode = (issues: Issue[], code: string) => issues.filter(i => i.code === code);
const on = (issues: Issue[], specId: string, codes: ReadonlySet<string>) =>
  issues.filter(i => i.specId === specId && codes.has(i.code)).map(i => i.code);

/** Every code the stereotype-dependencies and pattern-ownership rules can report. */
const SHAPE_CODES: ReadonlySet<string> = new Set([
  'INVALID_DEPENDENCY_REFERENCE', 'CROSS_TREE_REF_UNRESOLVED', 'SURFACE_REF_AMBIGUOUS',
  'CROSS_SUBSYSTEM_NON_ADAPTER', 'CROSS_SUBSYSTEM_PRIVATE_ACCESS', 'CROSS_SUBSYSTEM_TARGET_NON_PORTAL',
  'ARCHITECTURE_VIOLATION_PORTAL_DEP', 'ARCHITECTURE_VIOLATION_PORTAL_FORBIDDEN_DEP',
  'ARCHITECTURE_VIOLATION_STORE_DEP', 'ARCHITECTURE_VIOLATION_REGISTRY_DEP', 'ARCHITECTURE_VIOLATION_ADAPTER_DEP',
  'ARCHITECTURE_VIOLATION_INDEX_DEP', 'ARCHITECTURE_VIOLATION_VIEW_DEP', 'PORTAL_WRITE_SHORTCUT',
  'DEPENDENCY_CLASS_VIOLATION', 'ARCHITECTURE_VIOLATION_SUPERVISOR_DEP', 'ACTOR_REACHED_WITHOUT_SUPERVISOR',
  'ARCHITECTURE_VIOLATION_QUERY_DEP',
  'EMPTY_PATTERN', 'BLOCK_OWNS_MEMBERS', 'INVALID_OWNED_MEMBER', 'PATTERN_OWNS_PATTERN', 'SHARED_OWNED_MEMBER',
  'REPOSITORY_CONTAINMENT', 'FEATURE_COMPONENT_CONTAINMENT', 'ROUTER_COMPONENT_CONTAINMENT', 'VISIBILITY_VIOLATION',
  'UNOWNED_QUERY', 'DEPENDENCY_CLASS_ON_NON_ORCHESTRATOR',
]);

describe('stereotype-dependencies: an Orchestrator\'s dependencyClass bounds its dependencies', () => {
  it('pure logic depending on a workflow Orchestrator is DEPENDENCY_CLASS_VIOLATION', () => {
    const proj = createTempProject();
    proj.subsystem('pharmacy');
    proj.component('dose-arbiter', 'pharmacy', 'Orchestrator', 'dependencyClass: pure\ndependsOn: [refill-workflow]');
    proj.component('refill-workflow', 'pharmacy', 'Orchestrator');
    const found = byCode(proj.validate(), 'DEPENDENCY_CLASS_VIOLATION');
    expect(found.map(i => i.specId)).toEqual(['dose-arbiter']);
    expect(found[0].severity).toBe('error');
    expect(found[0].message).toContain('dependencyClass pure');
    expect(found[0].message).toContain('Pure logic depends only on pure Orchestrators');
  });

  it('pure logic depending on pure logic stays silent', () => {
    const proj = createTempProject();
    proj.subsystem('pharmacy');
    proj.component('dose-arbiter', 'pharmacy', 'Orchestrator', 'dependencyClass: pure\ndependsOn: [dose-unit-codec]');
    proj.component('dose-unit-codec', 'pharmacy', 'Orchestrator', 'dependencyClass: pure');
    expect(byCode(proj.validate(), 'DEPENDENCY_CLASS_VIOLATION')).toEqual([]);
  });

  it('read logic depending on a Store is DEPENDENCY_CLASS_VIOLATION, with the Repository resolution', () => {
    const proj = createTempProject();
    proj.subsystem('pharmacy');
    proj.component('refill-projector', 'pharmacy', 'Orchestrator', 'dependencyClass: read\ndependsOn: [refill-store]');
    proj.component('refill-store', 'pharmacy', 'Store', 'durability: ram-projection');
    const found = byCode(proj.validate(), 'DEPENDENCY_CLASS_VIOLATION');
    expect(found.map(i => i.specId)).toEqual(['refill-projector']);
    expect(found[0].message).toContain('dependencyClass read');
    expect(found[0].message).toContain('Repository facade');
    expect(found[0].message).toContain('Never resolve this by merging');
  });

  it('read logic may depend on pure and read logic, a Repository, an Index and an Adapter', () => {
    const proj = createTempProject();
    proj.subsystem('pharmacy');
    proj.component('refill-projector', 'pharmacy', 'Orchestrator',
      'dependencyClass: read\ndependsOn: [dose-arbiter, stock-projector, refill-repository, refill-due-index, pharmacy-db-adapter]');
    proj.component('dose-arbiter', 'pharmacy', 'Orchestrator', 'dependencyClass: pure');
    proj.component('stock-projector', 'pharmacy', 'Orchestrator', 'dependencyClass: read');
    proj.component('refill-repository', 'pharmacy', 'Repository', 'owns: [refill-store]');
    proj.component('refill-store', 'pharmacy', 'Store', 'durability: ram-projection');
    proj.component('refill-due-index', 'pharmacy', 'Index');
    proj.component('pharmacy-db-adapter', 'pharmacy', 'Adapter');
    expect(byCode(proj.validate(), 'DEPENDENCY_CLASS_VIOLATION')).toEqual([]);
  });

  it('read logic depending on a workflow or a Query is DEPENDENCY_CLASS_VIOLATION', () => {
    const proj = createTempProject();
    proj.subsystem('pharmacy');
    proj.component('refill-projector', 'pharmacy', 'Orchestrator', 'dependencyClass: read\ndependsOn: [refill-workflow, refill-due-query]');
    proj.component('refill-workflow', 'pharmacy', 'Orchestrator');
    proj.component('refill-due-query', 'pharmacy', 'Query');
    const found = byCode(proj.validate(), 'DEPENDENCY_CLASS_VIOLATION');
    expect(found.map(i => i.specId)).toEqual(['refill-projector', 'refill-projector']);
  });

  const underEachBlock = (dependencyClass: string) => {
    const proj = createTempProject();
    proj.subsystem('pharmacy-web-ui', 'profile: frontend-reactive');
    proj.component('dose-arbiter', 'pharmacy-web-ui', 'Orchestrator', dependencyClass);
    proj.component('dose-plan-store', 'pharmacy-web-ui', 'Store', 'durability: ram-projection\ndependsOn: [dose-arbiter]');
    proj.component('dose-plan-registry', 'pharmacy-web-ui', 'Registry', 'dependsOn: [dose-plan-store, dose-arbiter]');
    proj.component('dose-plan-index', 'pharmacy-web-ui', 'Index', 'dependsOn: [dose-plan-store, dose-arbiter]');
    proj.component('pharmacy-db-adapter', 'pharmacy-web-ui', 'Adapter', 'dependsOn: [dose-arbiter]');
    proj.component('dose-summary-view', 'pharmacy-web-ui', 'View', 'dependsOn: [dose-arbiter]');
    const issues = proj.validate();
    return ['ARCHITECTURE_VIOLATION_STORE_DEP', 'ARCHITECTURE_VIOLATION_REGISTRY_DEP', 'ARCHITECTURE_VIOLATION_INDEX_DEP',
      'ARCHITECTURE_VIOLATION_ADAPTER_DEP', 'ARCHITECTURE_VIOLATION_VIEW_DEP']
      .map(code => `${code}:${byCode(issues, code).map(i => i.specId).join(',')}`);
  };

  it('pure logic is allowed under a Store, a Registry, an Index, an Adapter and a View', () => {
    expect(underEachBlock('dependencyClass: pure')).toEqual([
      'ARCHITECTURE_VIOLATION_STORE_DEP:', 'ARCHITECTURE_VIOLATION_REGISTRY_DEP:', 'ARCHITECTURE_VIOLATION_INDEX_DEP:',
      'ARCHITECTURE_VIOLATION_ADAPTER_DEP:', 'ARCHITECTURE_VIOLATION_VIEW_DEP:',
    ]);
  });

  it('a workflow Orchestrator under the same blocks is refused by each of their rules', () => {
    expect(underEachBlock('')).toEqual([
      'ARCHITECTURE_VIOLATION_STORE_DEP:dose-plan-store', 'ARCHITECTURE_VIOLATION_REGISTRY_DEP:dose-plan-registry',
      'ARCHITECTURE_VIOLATION_INDEX_DEP:dose-plan-index', 'ARCHITECTURE_VIOLATION_ADAPTER_DEP:pharmacy-db-adapter',
      'ARCHITECTURE_VIOLATION_VIEW_DEP:dose-summary-view',
    ]);
  });
});

describe('stereotype-dependencies: the process layer', () => {
  it('a Supervisor depending on a Store is ARCHITECTURE_VIOLATION_SUPERVISOR_DEP', () => {
    const proj = createTempProject();
    proj.subsystem('pharmacy');
    proj.component('dispensing-supervisor', 'pharmacy', 'Supervisor', 'dependsOn: [dispense-queue-store]');
    proj.component('dispense-queue-store', 'pharmacy', 'Store', 'durability: ram-projection');
    const found = byCode(proj.validate(), 'ARCHITECTURE_VIOLATION_SUPERVISOR_DEP');
    expect(found.map(i => i.specId)).toEqual(['dispensing-supervisor']);
    expect(found[0].severity).toBe('error');
    expect(found[0].message).toContain('reaches data only through workflows');
    expect(found[0].message).toContain('Repository');
  });

  it('a Supervisor may depend on Actors, Orchestrators, Adapters and other Supervisors', () => {
    const proj = createTempProject();
    proj.subsystem('pharmacy');
    proj.component('dispensing-supervisor', 'pharmacy', 'Supervisor',
      'dependsOn: [label-printer-actor, dispense-workflow, robot-arm-adapter, printer-supervisor]');
    proj.component('label-printer-actor', 'pharmacy', 'Actor');
    proj.component('dispense-workflow', 'pharmacy', 'Orchestrator');
    proj.component('robot-arm-adapter', 'pharmacy', 'Adapter');
    proj.component('printer-supervisor', 'pharmacy', 'Supervisor', 'dependsOn: [label-printer-actor]');
    const issues = proj.validate();
    expect(byCode(issues, 'ARCHITECTURE_VIOLATION_SUPERVISOR_DEP')).toEqual([]);
    expect(byCode(issues, 'ACTOR_REACHED_WITHOUT_SUPERVISOR')).toEqual([]);
  });

  it('a live Actor reached without any Supervisor is ACTOR_REACHED_WITHOUT_SUPERVISOR', () => {
    const proj = createTempProject();
    proj.subsystem('pharmacy');
    proj.component('refill-workflow', 'pharmacy', 'Orchestrator', 'dependsOn: [label-printer-actor]');
    proj.component('label-printer-actor', 'pharmacy', 'Actor');
    const found = byCode(proj.validate(), 'ACTOR_REACHED_WITHOUT_SUPERVISOR');
    expect(found.map(i => i.specId)).toEqual(['refill-workflow']);
    expect(found[0].severity).toBe('error');
    expect(found[0].message).toContain('no Supervisor depends on "label-printer-actor"');
  });

  it('names the Actor\'s Supervisor when the consumer skips it', () => {
    const proj = createTempProject();
    proj.subsystem('pharmacy');
    proj.component('refill-workflow', 'pharmacy', 'Orchestrator', 'dependsOn: [label-printer-actor]');
    proj.component('label-printer-actor', 'pharmacy', 'Actor');
    proj.component('printer-supervisor', 'pharmacy', 'Supervisor', 'dependsOn: [label-printer-actor]');
    const found = byCode(proj.validate(), 'ACTOR_REACHED_WITHOUT_SUPERVISOR');
    expect(found.map(i => i.specId)).toEqual(['refill-workflow']);
    expect(found[0].message).toContain('"printer-supervisor"');
  });

  it('passes when the consumer also depends on a Supervisor that supervises the Actor', () => {
    const proj = createTempProject();
    proj.subsystem('pharmacy');
    proj.component('refill-workflow', 'pharmacy', 'Orchestrator', 'dependsOn: [label-printer-actor, printer-supervisor]');
    proj.component('label-printer-actor', 'pharmacy', 'Actor');
    proj.component('printer-supervisor', 'pharmacy', 'Supervisor', 'dependsOn: [label-printer-actor]');
    expect(byCode(proj.validate(), 'ACTOR_REACHED_WITHOUT_SUPERVISOR')).toEqual([]);
  });
});

describe('Query: a Repository member for computed reads over its Store', () => {
  it('a Query depending on a workflow Orchestrator is ARCHITECTURE_VIOLATION_QUERY_DEP', () => {
    const proj = createTempProject();
    proj.subsystem('pharmacy');
    proj.component('refill-repository', 'pharmacy', 'Repository', 'owns: [refill-store, refill-due-query]');
    proj.component('refill-store', 'pharmacy', 'Store', 'durability: ram-projection');
    proj.component('refill-due-query', 'pharmacy', 'Query', 'dependsOn: [refill-store, refill-workflow]');
    proj.component('refill-workflow', 'pharmacy', 'Orchestrator');
    const found = byCode(proj.validate(), 'ARCHITECTURE_VIOLATION_QUERY_DEP');
    expect(found.map(i => i.specId)).toEqual(['refill-due-query']);
    expect(found[0].severity).toBe('error');
  });

  it('a Repository-owned Query over its Store, a backend Adapter and pure logic passes', () => {
    const proj = createTempProject();
    proj.subsystem('pharmacy');
    proj.component('refill-repository', 'pharmacy', 'Repository', 'owns: [refill-store, refill-due-query, pharmacy-db-adapter]');
    proj.component('refill-store', 'pharmacy', 'Store', 'durability: ram-projection');
    proj.component('pharmacy-db-adapter', 'pharmacy', 'Adapter');
    proj.component('refill-due-query', 'pharmacy', 'Query', 'dependsOn: [refill-store, pharmacy-db-adapter, due-date-arbiter]');
    proj.component('due-date-arbiter', 'pharmacy', 'Orchestrator', 'dependencyClass: pure');
    const issues = proj.validate();
    expect(byCode(issues, 'ARCHITECTURE_VIOLATION_QUERY_DEP')).toEqual([]);
    expect(byCode(issues, 'UNOWNED_QUERY')).toEqual([]);
    expect(byCode(issues, 'REPOSITORY_CONTAINMENT')).toEqual([]);
  });

  it('a Query outside any Repository is UNOWNED_QUERY', () => {
    const proj = createTempProject();
    proj.subsystem('pharmacy');
    proj.component('refill-due-query', 'pharmacy', 'Query');
    const found = byCode(proj.validate(), 'UNOWNED_QUERY');
    expect(found.map(i => i.specId)).toEqual(['refill-due-query']);
    expect(found[0].severity).toBe('error');
  });

  it('a Portal or an Observer reaching a Query is ARCHITECTURE_VIOLATION_PORTAL_FORBIDDEN_DEP', () => {
    const proj = createTempProject();
    proj.subsystem('pharmacy');
    proj.component('pharmacy-api-portal', 'pharmacy', 'Portal', 'portalType: Custom\ndependsOn: [refill-due-query]');
    proj.component('refill-event-observer', 'pharmacy', 'Observer', 'dependsOn: [refill-due-query]');
    proj.component('refill-due-query', 'pharmacy', 'Query');
    const found = byCode(proj.validate(), 'ARCHITECTURE_VIOLATION_PORTAL_FORBIDDEN_DEP');
    expect(found.map(i => i.specId).sort()).toEqual(['pharmacy-api-portal', 'refill-event-observer']);
  });
});

describe('one finding per edge', () => {
  it('a Portal or Observer target reports ARCHITECTURE_VIOLATION_PORTAL_DEP and nothing more', () => {
    const proj = createTempProject();
    proj.subsystem('pharmacy');
    proj.component('dose-plan-store', 'pharmacy', 'Store', 'durability: ram-projection\ndependsOn: [pharmacy-api-portal]');
    proj.component('dose-arbiter', 'pharmacy', 'Orchestrator', 'dependencyClass: pure\ndependsOn: [refill-event-observer]');
    proj.component('dispensing-supervisor', 'pharmacy', 'Supervisor', 'dependsOn: [pharmacy-api-portal]');
    proj.component('pharmacy-api-portal', 'pharmacy', 'Portal', 'portalType: Custom');
    proj.component('refill-event-observer', 'pharmacy', 'Observer');
    const issues = proj.validate();
    for (const consumer of ['dose-plan-store', 'dose-arbiter', 'dispensing-supervisor']) {
      expect(on(issues, consumer, SHAPE_CODES)).toEqual(['ARCHITECTURE_VIOLATION_PORTAL_DEP']);
    }
  });

  it('a retired component reports STEREOTYPE_RETIRED once, and no shape rule judges it or its edges', () => {
    const proj = createTempProject();
    proj.subsystem('claims');
    proj.component('claims-scoring-specialist', 'claims', 'Specialist', 'dependsOn: [claims-store, claims-portal]');
    proj.component('claims-store', 'claims', 'Store', 'durability: ram-projection\ndependsOn: [claims-scoring-specialist]');
    proj.component('claims-portal', 'claims', 'Portal', 'portalType: Custom');
    proj.component('claims-gateway', 'claims', 'Gateway', 'owns: [claims-intake-workflow]');
    proj.component('claims-intake-workflow', 'claims', 'Orchestrator');
    proj.component('claims-review-workflow', 'claims', 'Orchestrator', 'dependsOn: [claims-gateway, claims-intake-workflow]');
    const issues = proj.validate();

    expect(byCode(issues, 'STEREOTYPE_RETIRED').map(i => i.specId).sort()).toEqual(['claims-gateway', 'claims-scoring-specialist']);
    for (const retired of ['claims-scoring-specialist', 'claims-gateway']) {
      expect(on(issues, retired, SHAPE_CODES)).toEqual([]);
    }
    // Edges INTO a retired component are skipped too, and a retired Gateway
    // records no ownership, so its "member" stays reachable.
    expect(on(issues, 'claims-store', SHAPE_CODES)).toEqual([]);
    expect(on(issues, 'claims-review-workflow', SHAPE_CODES)).toEqual([]);
  });
});

describe('facade-forwarding: only a Repository facade is judged', () => {
  it('a retired Gateway\'s facade method is not judged for forwarding; STEREOTYPE_RETIRED is its one finding', () => {
    const proj = createTempProject();
    proj.subsystem('partners');
    proj.component('partner-gateway', 'partners', 'Gateway', 'owns: [partner-portal]');
    proj.component('partner-portal', 'partners', 'Portal', 'portalType: Custom');
    proj.spec('interface', 'ipartner-gateway', [
      'schemaVersion: 1.0.0', 'id: ipartner-gateway', 'name: IPartnerGateway', 'description: contract', 'component: partner-gateway',
      'methods:',
      '  - name: relay',
      '    description: Relays one partner request inward once it has been checked',
      '    signature: "relay(): void"',
      '    returns: "void"',
    ].join('\n'));
    proj.spec('implementation', 'impl-partner-gateway', [
      'schemaVersion: 1.0.0', 'id: impl-partner-gateway', 'name: ImplPartnerGateway', 'description: impl', 'contract: ipartner-gateway',
      'methods:',
      '  - name: relay',
      '    narrative:',
      '      - { stepNumber: 1, description: Check the partner request before relaying it, type: local }',
      '      - { stepNumber: 2, description: Done, type: return, outcome: relayed }',
    ].join('\n'));
    const issues = proj.validate();
    expect(byCode(issues, 'FACADE_FORWARDING')).toEqual([]);
    expect(byCode(issues, 'STEREOTYPE_RETIRED').map(i => i.specId)).toEqual(['partner-gateway']);
  });
});

describe('pattern-ownership: retired members', () => {
  it('a Repository skips a retired member but still reports a live mistake', () => {
    const proj = createTempProject();
    proj.subsystem('pharmacy');
    proj.component('medication-repository', 'pharmacy', 'Repository', 'owns: [medication-store, interaction-specialist, refill-workflow]');
    proj.component('medication-store', 'pharmacy', 'Store', 'durability: ram-projection');
    proj.component('interaction-specialist', 'pharmacy', 'Specialist');
    proj.component('refill-workflow', 'pharmacy', 'Orchestrator');
    const found = byCode(proj.validate(), 'REPOSITORY_CONTAINMENT');
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('"refill-workflow"');
  });

  it('a FeatureComponent owning a retired member is not judged for containment until it is migrated', () => {
    const proj = createTempProject();
    proj.subsystem('pharmacy-web-ui', 'profile: frontend-reactive');
    proj.component('refill-feature', 'pharmacy-web-ui', 'FeatureComponent', 'owns: [refill-hook, refill-form-view, refill-rules-specialist]');
    proj.component('refill-hook', 'pharmacy-web-ui', 'Orchestrator');
    proj.component('refill-form-view', 'pharmacy-web-ui', 'View');
    proj.component('refill-rules-specialist', 'pharmacy-web-ui', 'Specialist');
    expect(byCode(proj.validate(), 'FEATURE_COMPONENT_CONTAINMENT')).toEqual([]);
  });

  it('the same FeatureComponent owning a live stray member is still judged', () => {
    const proj = createTempProject();
    proj.subsystem('pharmacy-web-ui', 'profile: frontend-reactive');
    proj.component('refill-feature', 'pharmacy-web-ui', 'FeatureComponent', 'owns: [refill-hook, refill-form-view, refill-rules-arbiter]');
    proj.component('refill-hook', 'pharmacy-web-ui', 'Orchestrator');
    proj.component('refill-form-view', 'pharmacy-web-ui', 'View');
    proj.component('refill-rules-arbiter', 'pharmacy-web-ui', 'Orchestrator', 'dependencyClass: pure');
    expect(byCode(proj.validate(), 'FEATURE_COMPONENT_CONTAINMENT').map(i => i.specId)).toEqual(['refill-feature']);
  });
});

describe('logic-declaration: a dependencyClass is an Orchestrator property', () => {
  it('a dependencyClass on a Store is DEPENDENCY_CLASS_ON_NON_ORCHESTRATOR', () => {
    const proj = createTempProject();
    proj.subsystem('pharmacy');
    proj.component('dose-plan-store', 'pharmacy', 'Store', 'durability: ram-projection\ndependencyClass: pure');
    const found = byCode(proj.validate(), 'DEPENDENCY_CLASS_ON_NON_ORCHESTRATOR');
    expect(found.map(i => i.specId)).toEqual(['dose-plan-store']);
    expect(found[0].severity).toBe('error');
    expect(found[0].message).toContain('dependencyClass "pure"');
  });

  it('a dependencyClass on an Orchestrator passes', () => {
    const proj = createTempProject();
    proj.subsystem('pharmacy');
    proj.component('refill-projector', 'pharmacy', 'Orchestrator', 'dependencyClass: read');
    expect(byCode(proj.validate(), 'DEPENDENCY_CLASS_ON_NON_ORCHESTRATOR')).toEqual([]);
  });

  it('a retired Specialist declaring a class reports only STEREOTYPE_RETIRED', () => {
    const proj = createTempProject();
    proj.subsystem('pharmacy');
    proj.component('interaction-specialist', 'pharmacy', 'Specialist', 'dependencyClass: pure');
    const issues = proj.validate();
    expect(byCode(issues, 'DEPENDENCY_CLASS_ON_NON_ORCHESTRATOR')).toEqual([]);
    expect(byCode(issues, 'STEREOTYPE_RETIRED').map(i => i.specId)).toEqual(['interaction-specialist']);
  });
});

describe('retired-stereotypes: STEREOTYPE_RETIRED', () => {
  it('a Specialist is told it is an Orchestrator, retyped by wairon doctor --fix', () => {
    const proj = createTempProject();
    proj.subsystem('pharmacy');
    proj.component('interaction-specialist', 'pharmacy', 'Specialist');
    const found = byCode(proj.validate(), 'STEREOTYPE_RETIRED');
    expect(found.map(i => i.specId)).toEqual(['interaction-specialist']);
    expect(found[0].severity).toBe('error');
    expect(found[0].message).toContain('typed Specialist');
    expect(found[0].message).toContain('an Orchestrator with the dependencyClass');
    expect(found[0].message).toContain('wairon doctor --fix');
  });

  it('a Gateway is given its manual migration to a Portal with the gateway variant', () => {
    const proj = createTempProject();
    proj.subsystem('partners');
    proj.component('partner-gateway', 'partners', 'Gateway', 'owns: [partner-portal]');
    proj.component('partner-portal', 'partners', 'Portal', 'portalType: Custom');
    const found = byCode(proj.validate(), 'STEREOTYPE_RETIRED');
    expect(found.map(i => i.specId)).toEqual(['partner-gateway']);
    expect(found[0].message).toContain('typed Gateway');
    expect(found[0].message).toContain('gateway variant');
    expect(found[0].message).toContain('delete the Gateway spec');
    expect(found[0].message).toContain('sdd_rename_component');
  });

  it('live stereotypes are silent', () => {
    const proj = createTempProject();
    proj.subsystem('pharmacy');
    proj.component('dose-arbiter', 'pharmacy', 'Orchestrator', 'dependencyClass: pure');
    proj.component('pharmacy-api-portal', 'pharmacy', 'Portal', 'portalType: Custom\nvariant: gateway');
    expect(byCode(proj.validate(), 'STEREOTYPE_RETIRED')).toEqual([]);
  });
});

describe('the write boundary refuses what the intrinsic rules report', () => {
  const now = '2026-09-15T10:00:00Z';
  const candidate = (componentType: string, extra: Partial<ComponentSpec> = {}): ComponentSpec => ({
    id: 'dose-plan-store', name: 'Dose plan store', description: 'd', subsystem: 'pharmacy',
    componentType, owns: [], dependsOn: [], status: 'draft', createdAt: now, updatedAt: now, ...extra,
  } as ComponentSpec);

  it('refuses a dependencyClass on a non-Orchestrator', () => {
    const verdict = validateComponentCandidate(candidate('Store', { durability: 'ram-projection', dependencyClass: 'read' }));
    expect(verdict.errors.map(e => e.code)).toEqual(['DEPENDENCY_CLASS_ON_NON_ORCHESTRATOR']);
  });

  it('refuses a retired stereotype', () => {
    const verdict = validateComponentCandidate(candidate('Specialist'));
    expect(verdict.errors.map(e => e.code)).toEqual(['STEREOTYPE_RETIRED']);
  });
});
