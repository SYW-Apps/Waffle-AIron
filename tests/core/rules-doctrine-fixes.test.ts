import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { validateSddTree } from '../../src/core/validation.js';
import { invalidateSpecCache } from '../../src/core/specs.js';

// ---------------------------------------------------------------------------
// Doctrine rule fixes: behaviour reported while narrating the pattern and
// dependency rules and portal-endpoints, each pinned by a test that
// failed before its fix.
// ---------------------------------------------------------------------------

interface Issue { code: string; specId?: string; message: string; severity: string; draftContext?: boolean }

function createTempProject() {
  invalidateSpecCache();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-doctrine-fixes-'));

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
    subsystem: (id: string, extra = '') =>
      writeSpec('subsystem', id, `schemaVersion: 1.0.0\nid: ${id}\nname: ${id}\ndescription: d\nparentSystem: TestSystem\n${extra}`),
    component: (id: string, sub: string, type: string, extra = '') =>
      writeSpec('component', id, `schemaVersion: 1.0.0\nid: ${id}\nname: ${id}\ndescription: d\nsubsystem: ${sub}\ncomponentType: ${type}\n${extra}`),
    contract: (compId: string, methods: { name: string; effect?: string; endpoint?: boolean }[], extra = '') =>
      writeSpec('interface', `i${compId}`, [
        'schemaVersion: 1.0.0',
        `id: i${compId}`,
        `name: I${compId}`,
        'description: contract',
        `component: ${compId}`,
        ...(extra ? [extra] : []),
        'methods:',
        ...methods.map(m => [
          `  - name: ${m.name}`,
          `    description: ${m.name} does its one thing, carefully and observably`,
          `    signature: "${m.name}(): void"`,
          '    returns: "void"',
          ...(m.effect ? [`    effect: ${m.effect}`] : []),
          ...(m.endpoint ? ['    endpoint:', '      transport: HTTP', '      method: POST', `      path: /${m.name}`] : []),
        ].join('\n')),
      ].join('\n')),
    impl: (compId: string, body: string) =>
      writeSpec('implementation', `impl-${compId}`, `schemaVersion: 1.0.0\nid: impl-${compId}\nname: Impl${compId}\ndescription: impl\ncontract: i${compId}\n${body}`),
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

describe('pattern-membership: only a pattern\'s owns makes it an owner', () => {
  it('a building block owning a Store does not hide that Store from UNOWNED_STORE', () => {
    const proj = createTempProject();
    proj.subsystem('pharmacy');
    proj.component('dose-orchestrator', 'pharmacy', 'Orchestrator', 'owns: [dose-plan-store]');
    proj.component('dose-plan-store', 'pharmacy', 'Store', 'durability: ram-projection');
    const issues = proj.validate();
    expect(byCode(issues, 'BLOCK_OWNS_MEMBERS').map(i => i.specId)).toEqual(['dose-orchestrator']);
    expect(byCode(issues, 'UNOWNED_STORE').map(i => i.specId)).toEqual(['dose-plan-store']);
  });

  it('a building block owning a Registry does not exempt it from REGISTRY_WITHOUT_STORE', () => {
    const proj = createTempProject();
    proj.subsystem('intake');
    proj.component('consent-orchestrator', 'intake', 'Orchestrator', 'owns: [consent-registry]');
    proj.component('consent-registry', 'intake', 'Registry');
    const issues = proj.validate();
    expect(byCode(issues, 'REGISTRY_WITHOUT_STORE').map(i => i.specId)).toEqual(['consent-registry']);
  });

  it('depending on a block-claimed member is no VISIBILITY_VIOLATION naming the block a pattern', () => {
    const proj = createTempProject();
    proj.subsystem('pharmacy');
    proj.component('dose-orchestrator', 'pharmacy', 'Orchestrator', 'owns: [dose-plan-store]');
    proj.component('refill-orchestrator', 'pharmacy', 'Orchestrator', 'dependsOn: [dose-plan-store]');
    proj.component('dose-plan-store', 'pharmacy', 'Store', 'durability: ram-projection');
    const issues = proj.validate();
    expect(byCode(issues, 'VISIBILITY_VIOLATION')).toEqual([]);
  });

  it('a building block claiming a pattern\'s member is BLOCK_OWNS_MEMBERS, not a second owner', () => {
    const proj = createTempProject();
    proj.subsystem('pharmacy');
    proj.component('medication-repository', 'pharmacy', 'Repository', 'owns: [medication-store]');
    proj.component('dose-orchestrator', 'pharmacy', 'Orchestrator', 'owns: [medication-store]');
    proj.component('refill-orchestrator', 'pharmacy', 'Orchestrator', 'dependsOn: [medication-store]');
    proj.component('medication-store', 'pharmacy', 'Store', 'durability: ram-projection');
    const issues = proj.validate();
    expect(byCode(issues, 'SHARED_OWNED_MEMBER')).toEqual([]);
    expect(byCode(issues, 'BLOCK_OWNS_MEMBERS').map(i => i.specId)).toEqual(['dose-orchestrator']);
    const visibility = byCode(issues, 'VISIBILITY_VIOLATION');
    expect(visibility.map(i => i.specId)).toEqual(['refill-orchestrator']);
    expect(visibility[0].message).toContain('pattern "medication-repository"');
  });
});

describe('pattern-membership: PATTERN_OWNS_PATTERN names a pattern owner', () => {
  it('a building block owning a pattern reports BLOCK_OWNS_MEMBERS only', () => {
    const proj = createTempProject();
    proj.subsystem('pharmacy');
    proj.component('dispensing-orchestrator', 'pharmacy', 'Orchestrator', 'owns: [medication-repository]');
    proj.component('medication-repository', 'pharmacy', 'Repository', 'owns: [medication-store]');
    proj.component('medication-store', 'pharmacy', 'Store', 'durability: ram-projection');
    const issues = proj.validate();
    expect(byCode(issues, 'PATTERN_OWNS_PATTERN')).toEqual([]);
    expect(byCode(issues, 'BLOCK_OWNS_MEMBERS').map(i => i.specId)).toEqual(['dispensing-orchestrator']);
  });

  it.each(['FeatureComponent', 'RouterComponent', 'Repository'])('a Repository owning a %s is reported, naming its owner a pattern', (innerType) => {
    const proj = createTempProject();
    proj.subsystem('pharmacy');
    proj.component('pharmacy-repository', 'pharmacy', 'Repository', 'owns: [medication-store, refill-slice]');
    proj.component('medication-store', 'pharmacy', 'Store', 'durability: ram-projection');
    proj.component('refill-slice', 'pharmacy', innerType, 'owns: [refill-store]');
    proj.component('refill-store', 'pharmacy', 'Store', 'durability: ram-projection');
    const found = byCode(proj.validate(), 'PATTERN_OWNS_PATTERN');
    expect(found.map(i => i.specId)).toEqual(['pharmacy-repository']);
    expect(found[0].message.startsWith('Pattern "pharmacy-repository"')).toBe(true);
  });

  it('the inner pattern gets no owner, so depending on it is no VISIBILITY_VIOLATION', () => {
    const proj = createTempProject();
    proj.subsystem('pharmacy');
    proj.component('pharmacy-repository', 'pharmacy', 'Repository', 'owns: [medication-store, refill-repository]');
    proj.component('medication-store', 'pharmacy', 'Store', 'durability: ram-projection');
    proj.component('refill-repository', 'pharmacy', 'Repository', 'owns: [refill-store]');
    proj.component('refill-store', 'pharmacy', 'Store', 'durability: ram-projection');
    proj.component('refill-orchestrator', 'pharmacy', 'Orchestrator', 'dependsOn: [refill-repository]');
    const issues = proj.validate();
    expect(byCode(issues, 'PATTERN_OWNS_PATTERN').map(i => i.specId)).toEqual(['pharmacy-repository']);
    expect(byCode(issues, 'VISIBILITY_VIOLATION')).toEqual([]);
  });

  it('two patterns side by side own no pattern', () => {
    const proj = createTempProject();
    proj.subsystem('pharmacy');
    proj.component('pharmacy-repository', 'pharmacy', 'Repository', 'owns: [medication-store]');
    proj.component('medication-store', 'pharmacy', 'Store', 'durability: ram-projection');
    proj.component('refill-repository', 'pharmacy', 'Repository', 'owns: [refill-store]');
    proj.component('refill-store', 'pharmacy', 'Store', 'durability: ram-projection');
    expect(byCode(proj.validate(), 'PATTERN_OWNS_PATTERN')).toEqual([]);
  });
});

describe('pattern-containment: a RouterComponent owns exactly one Portal', () => {
  const router = (owns: string) => {
    const proj = createTempProject();
    proj.subsystem('pharmacy-web-ui', 'profile: frontend-reactive');
    proj.component('pharmacy-shell-router', 'pharmacy-web-ui', 'RouterComponent', `owns: [${owns}]`);
    proj.component('patient-shell-portal', 'pharmacy-web-ui', 'Portal', 'portalType: Custom');
    proj.component('staff-shell-portal', 'pharmacy-web-ui', 'Portal', 'portalType: Custom');
    proj.component('refill-request-view', 'pharmacy-web-ui', 'View');
    return byCode(proj.validate(), 'ROUTER_COMPONENT_CONTAINMENT');
  };

  it('flags a RouterComponent owning two Portal facades', () => {
    const found = router('patient-shell-portal, staff-shell-portal, refill-request-view');
    expect(found.map(i => i.specId)).toEqual(['pharmacy-shell-router']);
    expect(found[0].message).toContain('exactly one Portal');
  });

  it('stays silent for one Portal facade plus a routed child', () => {
    expect(router('patient-shell-portal, refill-request-view')).toEqual([]);
  });
});

describe('pattern-membership: SHARED_OWNED_MEMBER names the first owner', () => {
  it('with three owners, each later claimant is reported against the first', () => {
    const proj = createTempProject();
    proj.subsystem('pharmacy');
    proj.component('medication-repository', 'pharmacy', 'Repository', 'owns: [medication-store]');
    proj.component('inventory-repository', 'pharmacy', 'Repository', 'owns: [medication-store]');
    proj.component('dispensing-repository', 'pharmacy', 'Repository', 'owns: [medication-store]');
    proj.component('medication-store', 'pharmacy', 'Store', 'durability: ram-projection');
    const found = byCode(proj.validate(), 'SHARED_OWNED_MEMBER');
    expect(found).toHaveLength(2);
    const pairs = found.map(i => {
      const match = /owned by both "([^"]+)" and "([^"]+)"/.exec(i.message);
      expect(match).not.toBeNull();
      return { first: match![1], claimant: match![2], anchor: i.specId };
    });
    // Each finding anchors on its claimant; both name the same first owner,
    // which claimed the member before anyone else and is never itself reported.
    for (const p of pairs) expect(p.anchor).toBe(p.claimant);
    expect(pairs[0].first).toBe(pairs[1].first);
    expect(pairs.map(p => p.claimant)).not.toContain(pairs[0].first);
  });
});

describe('portal-write-shortcut: PORTAL_WRITE_SHORTCUT judges dispatch-table routes', () => {
  function bookingTree(binding: { component: string; method: string }, narrative?: string[]) {
    const proj = createTempProject();
    proj.subsystem('scheduling');
    proj.component('booking-portal', 'scheduling', 'Portal', [
      'portalType: Custom',
      'dependsOn: [appointment-repository, booking-orchestrator]',
      'dispatch:',
      '  - capability: appointment.book',
      `    component: ${binding.component}`,
      `    method: ${binding.method}`,
    ].join('\n'));
    proj.component('booking-orchestrator', 'scheduling', 'Orchestrator', 'dependsOn: [appointment-repository]');
    proj.component('appointment-store', 'scheduling', 'Store', 'durability: ram-projection');
    proj.component('appointment-registry', 'scheduling', 'Registry', 'dependsOn: [appointment-store]');
    proj.component('appointment-index', 'scheduling', 'Index', 'dependsOn: [appointment-store]');
    proj.component('appointment-repository', 'scheduling', 'Repository', 'owns: [appointment-store, appointment-registry, appointment-index]');
    proj.contract('appointment-repository', [{ name: 'findAppointment', effect: 'read' }, { name: 'saveAppointment', effect: 'write' }]);
    proj.contract('booking-orchestrator', [{ name: 'bookAppointment' }]);
    proj.contract('booking-portal', [{ name: 'handle' }]);
    if (narrative) proj.impl('booking-portal', ['methods:', '  - name: handle', '    narrative:', ...narrative].join('\n'));
    return byCode(proj.validate(), 'PORTAL_WRITE_SHORTCUT');
  }

  it('a dispatch binding routed to a write-effect facade method is the shortcut', () => {
    const found = bookingTree({ component: 'appointment-repository', method: 'saveAppointment' });
    expect(found).toHaveLength(1);
    expect(found[0].specId).toBe('booking-portal');
    expect(found[0].severity).toBe('error');
    expect(found[0].message).toContain('appointment.book');
    expect(found[0].message).toContain('appointment-repository.saveAppointment');
    expect(found[0].message).toContain('READS only');
  });

  it('a dispatch binding routed to a read-effect facade method passes', () => {
    expect(bookingTree({ component: 'appointment-repository', method: 'findAppointment' })).toEqual([]);
  });

  it('a dispatch binding routed to the workflow Orchestrator passes', () => {
    expect(bookingTree({ component: 'booking-orchestrator', method: 'bookAppointment' })).toEqual([]);
  });

  it('a dispatch step through the Portal\'s own table is reported once, at the binding that routes it', () => {
    const found = bookingTree({ component: 'appointment-repository', method: 'saveAppointment' }, [
      '      - { stepNumber: 1, description: Route the booking capability through the table, type: dispatch, targetComponent: booking-portal, capability: appointment.book }',
      '      - { stepNumber: 2, description: Done, type: return, outcome: booked }',
    ]);
    expect(found.map(i => i.specId)).toEqual(['booking-portal']);
  });
});

describe('subsystem-boundary-dependencies: CROSS_SUBSYSTEM_TARGET_NON_PORTAL names the crossing component', () => {
  function billingPublishesItsOrchestrator(crosser: { id: string; type: string }) {
    const proj = createTempProject();
    proj.subsystem('front', 'trustedLinks:\n  - subsystem: billing\n    reason: in-process modular monolith - no network seam wanted between these two');
    proj.subsystem('billing', 'publicInterfaces:\n  - type: REST\n    details: /api/billing\n    component: billing-orchestrator');
    proj.component('billing-orchestrator', 'billing', 'Orchestrator');
    proj.component(crosser.id, 'front', crosser.type, 'dependsOn: [billing-orchestrator]');
    return byCode(proj.validate(), 'CROSS_SUBSYSTEM_TARGET_NON_PORTAL');
  }

  it('a trustedLink-licensed Orchestrator is not called a client Adapter', () => {
    const found = billingPublishesItsOrchestrator({ id: 'checkout-orchestrator', type: 'Orchestrator' });
    expect(found).toHaveLength(1);
    expect(found[0].message).not.toContain('Adapter');
    expect(found[0].message).toContain('Orchestrator "checkout-orchestrator"');
  });

  it('an Adapter is still named the client Adapter it is', () => {
    const found = billingPublishesItsOrchestrator({ id: 'billing-client-adapter', type: 'Adapter' });
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('client Adapter "billing-client-adapter"');
  });
});

describe('portal-endpoints: the non-Portal endpoint ban reports like the Portal-side codes', () => {
  it('anchors ARCHITECTURE_VIOLATION_NON_PORTAL_ENDPOINT on the interface that declares the endpoint', () => {
    const proj = createTempProject();
    proj.subsystem('claims');
    proj.component('claims-scoring-arbiter', 'claims', 'Orchestrator', 'dependencyClass: pure');
    proj.contract('claims-scoring-arbiter', [{ name: 'scoreClaim', endpoint: true }]);
    const found = byCode(proj.validate(), 'ARCHITECTURE_VIOLATION_NON_PORTAL_ENDPOINT');
    expect(found.map(i => i.specId)).toEqual(['iclaims-scoring-arbiter']);
    expect(found[0].draftContext).toBeUndefined();
  });

  it('carries a draft interface into the finding\'s draft context', () => {
    const proj = createTempProject();
    proj.subsystem('claims');
    proj.component('claims-scoring-arbiter', 'claims', 'Orchestrator', 'dependencyClass: pure');
    proj.contract('claims-scoring-arbiter', [{ name: 'scoreClaim', endpoint: true }], 'status: draft');
    const found = byCode(proj.validate(), 'ARCHITECTURE_VIOLATION_NON_PORTAL_ENDPOINT');
    expect(found).toHaveLength(1);
    expect(found[0].draftContext).toBe(true);
  });
});
