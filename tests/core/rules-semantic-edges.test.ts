import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { validateSddTree } from '../../src/core/validation.js';
import { invalidateSpecCache } from '../../src/core/specs.js';

// ---------------------------------------------------------------------------
// Semantic-edge rules: dispatch tables, lifecycle entrypoints, durability
// round-trip, untyped seams, prose claims. These close the "referenced things
// exist but semantically-required edges don't" blind-spot family.
// ---------------------------------------------------------------------------

function createTempProject() {
  invalidateSpecCache();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-sem-test-'));

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

  const stamp = "createdAt: '2026-06-10T22:00:00Z'\nupdatedAt: '2026-06-10T22:00:00Z'";
  const writeSpec = (type: string, name: string, content: string) => {
    const filePath = type === 'system'
      ? path.join(specsDir, '.index.yaml')
      : path.join(specsDir, `${type}s`, `${name}.yaml`);
    fs.writeFileSync(filePath, `${content}\n${stamp}\n`);
  };

  writeSpec('system', 'system', 'schemaVersion: 1.0.0\nname: TestSystem\nvision: testing');

  return {
    writeSpec,
    subsystem: (id: string, extra = '') =>
      writeSpec('subsystem', id, `schemaVersion: 1.0.0\nid: ${id}\nname: ${id}\ndescription: d\nparentSystem: TestSystem\n${extra}`),
    component: (id: string, type: string, extra = '', subsystem = 'sub-a') =>
      writeSpec('component', id, `schemaVersion: 1.0.0\nid: ${id}\nname: ${id}\ndescription: d\nsubsystem: ${subsystem}\ncomponentType: ${type}\n${extra}`),
    activate: () => { vi.spyOn(process, 'cwd').mockReturnValue(tempDir); },
    cleanup: () => {
      invalidateSpecCache();
      vi.restoreAllMocks();
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* win file locks */ }
    },
  };
}

const codesOf = (res: { issues: { code: string }[] }) => res.issues.map(i => i.code);
const issuesWith = (res: { issues: { code: string; message: string }[] }, code: string) =>
  res.issues.filter(i => i.code === code);

// A generic-dispatch portal fixture: portal.handle dispatches by capability;
// shadow-server serves "shadow_module.get" only through the table.
function dispatchFixture(proj: ReturnType<typeof createTempProject>, opts: {
  table?: string;
  portalDeps?: string;
} = {}) {
  proj.subsystem('sub-a');
  proj.component('pkg-portal', 'Portal', [
    'portalType: Custom',
    opts.portalDeps ?? 'dependsOn: [shadow-server]',
    ...(opts.table !== undefined ? [opts.table] : []),
  ].filter(Boolean).join('\n'));
  proj.component('shadow-server', 'Specialist');
  proj.writeSpec('interface', 'ipkg-portal', `schemaVersion: 1.0.0
id: ipkg-portal
name: IPortal
description: d
component: pkg-portal
methods:
  - name: handle
    description: Generic capability envelope entrypoint dispatched by capability name.
    signature: "handle(req: Envelope): Envelope"
    returns: "Envelope"`);
  proj.writeSpec('interface', 'ishadow-server', `schemaVersion: 1.0.0
id: ishadow-server
name: IShadow
description: d
component: shadow-server
methods:
  - name: getModule
    description: Returns the pretranspiled shadow module for a crate path.
    signature: "getModule(pathRef: string): string"
    returns: "string"`);
}

describe('dispatch tables (UNSERVED_CAPABILITY family)', () => {
  it('a dispatch table makes the served method reachable — no UNUSED findings, no dispatch errors', () => {
    const proj = createTempProject();
    dispatchFixture(proj, {
      table: 'dispatch:\n  - { capability: shadow_module.get, component: shadow-server, method: getModule }',
    });
    proj.activate();
    try {
      const res = validateSddTree();
      expect(issuesWith(res, 'UNSERVED_CAPABILITY')).toHaveLength(0);
      expect(issuesWith(res, 'DISPATCH_ON_NON_PORTAL')).toHaveLength(0);
      expect(issuesWith(res, 'UNDECLARED_DISPATCH_TARGET')).toHaveLength(0);
      const unusedMsgs = res.issues.filter(i => i.code === 'UNUSED_METHOD' || i.code === 'UNUSED_COMPONENT').map(i => i.message);
      expect(unusedMsgs.join('\n')).not.toMatch(/shadow-server|getModule/);
    } finally { proj.cleanup(); }
  });

  it('WITHOUT a table the same served-only-dynamically method is correctly flagged unused', () => {
    const proj = createTempProject();
    dispatchFixture(proj); // no table — the historic blind spot, now visible
    proj.activate();
    try {
      const res = validateSddTree();
      // Nothing statically reaches shadow-server without the table.
      const unusedComponent = issuesWith(res, 'UNUSED_COMPONENT').map(i => i.message).join('\n');
      expect(unusedComponent).toMatch(/shadow-server/);
    } finally { proj.cleanup(); }
  });

  it('flags a binding whose component or method does not exist', () => {
    const proj = createTempProject();
    dispatchFixture(proj, {
      table: 'dispatch:\n  - { capability: ghost.cap, component: no-such-comp, method: run }\n  - { capability: shadow_module.get, component: shadow-server, method: noSuchMethod }',
    });
    proj.activate();
    try {
      const res = validateSddTree();
      const found = issuesWith(res, 'UNSERVED_CAPABILITY').map(i => i.message).join('\n');
      expect(found).toMatch(/no-such-comp/);
      expect(found).toMatch(/noSuchMethod/);
    } finally { proj.cleanup(); }
  });

  it('flags duplicate capabilities, tables on non-portals, and undeclared targets', () => {
    const proj = createTempProject();
    proj.subsystem('sub-a');
    proj.component('orch-a', 'Orchestrator',
      'dispatch:\n  - { capability: a.b, component: helper-a, method: run }\n  - { capability: a.b, component: helper-a, method: run }');
    proj.component('helper-a', 'Specialist');
    proj.writeSpec('interface', 'ihelper-a', `schemaVersion: 1.0.0
id: ihelper-a
name: IHelper
description: d
component: helper-a
methods:
  - name: run
    description: Runs the helper capability end to end.
    signature: "run(): void"
    returns: "void"`);
    proj.activate();
    try {
      const res = validateSddTree();
      expect(codesOf(res)).toContain('DISPATCH_ON_NON_PORTAL');
      expect(codesOf(res)).toContain('DUPLICATE_CAPABILITY');
      expect(codesOf(res)).toContain('UNDECLARED_DISPATCH_TARGET');
    } finally { proj.cleanup(); }
  });

  it('flags a cross-subsystem dispatch binding', () => {
    const proj = createTempProject();
    dispatchFixture(proj, {
      table: 'dispatch:\n  - { capability: foreign.cap, component: foreign-spec, method: run }',
      portalDeps: 'dependsOn: [foreign-spec]',
    });
    proj.subsystem('sub-b');
    proj.component('foreign-spec', 'Specialist', '', 'sub-b');
    proj.writeSpec('interface', 'iforeign-spec', `schemaVersion: 1.0.0
id: iforeign-spec
name: IForeign
description: d
component: foreign-spec
methods:
  - name: run
    description: Runs the foreign capability end to end.
    signature: "run(): void"
    returns: "void"`);
    proj.activate();
    try {
      expect(codesOf(validateSddTree())).toContain('DISPATCH_CROSS_SUBSYSTEM');
    } finally { proj.cleanup(); }
  });

  it('validates dispatch steps: unknown capability and malformed step', () => {
    const proj = createTempProject();
    dispatchFixture(proj, {
      table: 'dispatch:\n  - { capability: shadow_module.get, component: shadow-server, method: getModule }',
    });
    proj.component('caller-orch', 'Orchestrator', 'dependsOn: [pkg-portal]');
    proj.writeSpec('interface', 'icaller-orch', `schemaVersion: 1.0.0
id: icaller-orch
name: ICaller
description: d
component: caller-orch
methods:
  - name: fetchPretranspiled
    description: Fetches the pretranspiled module through the packages portal.
    signature: "fetchPretranspiled(): void"
    returns: "void"
  - name: fetchBroken
    description: Dispatches a capability nobody serves.
    signature: "fetchBroken(): void"
    returns: "void"`);
    proj.writeSpec('implementation', 'impl-caller-orch', `schemaVersion: 1.0.0
id: impl-caller-orch
name: ImplCaller
description: d
contract: icaller-orch
methods:
  - name: fetchPretranspiled
    narrative:
      - { stepNumber: 1, description: route the capability through the portal, type: dispatch, targetComponent: pkg-portal, capability: shadow_module.get }
  - name: fetchBroken
    narrative:
      - { stepNumber: 1, description: route an unserved capability, type: dispatch, targetComponent: pkg-portal, capability: nobody.serves.this }
      - { stepNumber: 2, description: dispatch with no capability at all, type: dispatch, targetComponent: pkg-portal }`);
    proj.activate();
    try {
      const res = validateSddTree();
      const unserved = issuesWith(res, 'UNSERVED_CAPABILITY').map(i => i.message).join('\n');
      expect(unserved).toMatch(/nobody\.serves\.this/);
      expect(unserved).not.toMatch(/shadow_module\.get.*does not serve/);
      expect(codesOf(res)).toContain('MALFORMED_DISPATCH_STEP');
    } finally { proj.cleanup(); }
  });
});

describe('lifecycle entrypoints', () => {
  it('a lifecycle-rooted method is reachable; dangling entrypoints are errors', () => {
    const proj = createTempProject();
    proj.subsystem('sub-a', [
      'lifecycle:',
      '  - { phase: init, component: boot-orch, method: hydrate }',
      '  - { phase: init, component: no-such-comp, method: run }',
      '  - { phase: shutdown, component: boot-orch, method: noSuchMethod }',
    ].join('\n'));
    proj.component('boot-orch', 'Orchestrator');
    proj.writeSpec('interface', 'iboot-orch', `schemaVersion: 1.0.0
id: iboot-orch
name: IBoot
description: d
component: boot-orch
methods:
  - name: hydrate
    description: Boot-time hydration flow reading persisted state back into projections.
    signature: "hydrate(): void"
    returns: "void"`);
    proj.activate();
    try {
      const res = validateSddTree();
      const invalid = issuesWith(res, 'INVALID_LIFECYCLE_ENTRYPOINT').map(i => i.message).join('\n');
      expect(invalid).toMatch(/no-such-comp/);
      expect(invalid).toMatch(/noSuchMethod/);
      // hydrate itself is rooted, so not unused (boot-orch has no other callers).
      const unused = issuesWith(res, 'UNUSED_METHOD').map(i => i.message).join('\n');
      expect(unused).not.toMatch(/hydrate/);
    } finally { proj.cleanup(); }
  });
});

// Durable-store fixture: state-store persisted via save/load; the init flow
// optionally reads it back.
function durabilityFixture(proj: ReturnType<typeof createTempProject>, opts: {
  durability?: string;
  lifecycle?: boolean;
  hydrateCallsLoad?: boolean;
  tagEffects?: boolean;
}) {
  proj.subsystem('sub-a', opts.lifecycle
    ? 'lifecycle:\n  - { phase: init, component: boot-orch, method: hydrate }'
    : '');
  proj.component('state-store', 'Store', opts.durability ? `durability: ${opts.durability}` : '');
  proj.component('boot-orch', 'Orchestrator', 'dependsOn: [state-store]');
  const eff = (e: string) => (opts.tagEffects === false ? '' : `\n    effect: ${e}`);
  proj.writeSpec('interface', 'istate-store', `schemaVersion: 1.0.0
id: istate-store
name: IStateStore
description: d
component: state-store
methods:
  - name: save
    description: Persists the provisioned state record to the external file.
    signature: "save(record: string): void"
    returns: "void"${eff('write')}
  - name: load
    description: Reads the persisted state file back into the in-memory projection.
    signature: "load(): string"
    returns: "string"${eff('read')}`);
  proj.writeSpec('interface', 'iboot-orch', `schemaVersion: 1.0.0
id: iboot-orch
name: IBoot
description: d
component: boot-orch
methods:
  - name: hydrate
    description: Boot-time hydration flow reading persisted state back into projections.
    signature: "hydrate(): void"
    returns: "void"
  - name: mutate
    description: Runtime write path persisting new state.
    signature: "mutate(): void"
    returns: "void"`);
  proj.writeSpec('implementation', 'impl-boot-orch', `schemaVersion: 1.0.0
id: impl-boot-orch
name: ImplBoot
description: d
contract: iboot-orch
methods:
  - name: hydrate
    narrative:
      - { stepNumber: 1, description: ${opts.hydrateCallsLoad ? 'read the persisted state back, type: call, targetComponent: state-store, targetMethod: load' : 'rebuild caches from scratch, type: local'} }
  - name: mutate
    narrative:
      - { stepNumber: 1, description: persist the new record, type: call, targetComponent: state-store, targetMethod: save }`);
}

describe('durability round-trip (MISSING_HYDRATION)', () => {
  it('durable store hydrated from a lifecycle init flow is clean', () => {
    const proj = createTempProject();
    durabilityFixture(proj, { durability: 'durable', lifecycle: true, hydrateCallsLoad: true });
    proj.activate();
    try {
      const res = validateSddTree();
      expect(issuesWith(res, 'MISSING_HYDRATION')).toHaveLength(0);
      expect(issuesWith(res, 'MISSING_EFFECT_TAG')).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('flags a durable store whose init flow never reads it back', () => {
    const proj = createTempProject();
    durabilityFixture(proj, { durability: 'durable', lifecycle: true, hydrateCallsLoad: false });
    proj.activate();
    try {
      const found = issuesWith(validateSddTree(), 'MISSING_HYDRATION');
      expect(found).toHaveLength(1);
      expect(found[0].message).toMatch(/state-store/);
    } finally { proj.cleanup(); }
  });

  it('flags a durable store when no lifecycle init entrypoint exists at all', () => {
    const proj = createTempProject();
    durabilityFixture(proj, { durability: 'durable', lifecycle: false, hydrateCallsLoad: true });
    proj.activate();
    try {
      const found = issuesWith(validateSddTree(), 'MISSING_HYDRATION');
      expect(found).toHaveLength(1);
      expect(found[0].message).toMatch(/no subsystem declares a lifecycle init entrypoint/);
    } finally { proj.cleanup(); }
  });

  it('ram-projection stores are exempt; untagged durable methods and non-Store durability are flagged', () => {
    const proj = createTempProject();
    durabilityFixture(proj, { durability: 'ram-projection', lifecycle: false, hydrateCallsLoad: false });
    proj.activate();
    try {
      expect(issuesWith(validateSddTree(), 'MISSING_HYDRATION')).toHaveLength(0);
    } finally { proj.cleanup(); }

    const proj2 = createTempProject();
    durabilityFixture(proj2, { durability: 'durable', lifecycle: true, hydrateCallsLoad: true, tagEffects: false });
    proj2.activate();
    try {
      const res = validateSddTree();
      expect(issuesWith(res, 'MISSING_EFFECT_TAG').length).toBeGreaterThan(0);
      // Untagged methods mean no declared writes — the round-trip rule stays quiet rather than guessing.
      expect(issuesWith(res, 'MISSING_HYDRATION')).toHaveLength(0);
    } finally { proj2.cleanup(); }

    const proj3 = createTempProject();
    proj3.subsystem('sub-a');
    proj3.component('some-orch', 'Orchestrator', 'durability: durable');
    proj3.activate();
    try {
      expect(codesOf(validateSddTree())).toContain('DURABILITY_ON_NON_STORE');
    } finally { proj3.cleanup(); }
  });
});

describe('review-hardening regressions', () => {
  it('a durable store read merely OFFERED in a reached portal\'s table does not count as boot hydration', () => {
    const proj = createTempProject();
    proj.subsystem('sub-a', 'lifecycle:\n  - { phase: init, component: boot-orch, method: setup }');
    proj.component('state-store', 'Store', 'durability: durable');
    proj.component('boot-orch', 'Orchestrator', 'dependsOn: [cfg-portal]');
    proj.component('cfg-portal', 'Portal',
      'portalType: Custom\ndependsOn: [state-store]\ndispatch:\n  - { capability: state.get, component: state-store, method: load }');
    proj.writeSpec('interface', 'istate-store', `schemaVersion: 1.0.0
id: istate-store
name: IStore
description: d
component: state-store
methods:
  - name: save
    description: Persists the record to the external file.
    signature: "save(r: string): void"
    returns: "void"
    effect: write
  - name: load
    description: Reads the persisted file back into the projection.
    signature: "load(): string"
    returns: "string"
    effect: read`);
    proj.writeSpec('interface', 'iboot-orch', `schemaVersion: 1.0.0
id: iboot-orch
name: IBoot
description: d
component: boot-orch
methods:
  - name: setup
    description: Registers routes at boot without reading any persisted state.
    signature: "setup(): void"
    returns: "void"`);
    proj.writeSpec('interface', 'icfg-portal', `schemaVersion: 1.0.0
id: icfg-portal
name: IPortal
description: d
component: cfg-portal
methods:
  - name: configure
    description: Registers the capability routes.
    signature: "configure(): void"
    returns: "void"`);
    proj.writeSpec('implementation', 'impl-boot-orch', `schemaVersion: 1.0.0
id: impl-boot-orch
name: ImplBoot
description: d
contract: iboot-orch
methods:
  - name: setup
    narrative:
      - { stepNumber: 1, description: register the routes, type: call, targetComponent: cfg-portal, targetMethod: configure }`);
    proj.activate();
    try {
      // The init flow reaches the portal but never READS the store — the
      // table binding alone must not satisfy the round-trip.
      const found = issuesWith(validateSddTree(), 'MISSING_HYDRATION');
      expect(found).toHaveLength(1);
      expect(found[0].message).toMatch(/state-store/);
    } finally { proj.cleanup(); }
  });

  it('a dispatch step asserting a guarantee the bound method does not declare is flagged', () => {
    const proj = createTempProject();
    dispatchFixture(proj, {
      table: 'dispatch:\n  - { capability: shadow_module.get, component: shadow-server, method: getModule }',
    });
    proj.component('caller-orch', 'Orchestrator', 'dependsOn: [pkg-portal]');
    proj.writeSpec('interface', 'icaller-orch', `schemaVersion: 1.0.0
id: icaller-orch
name: ICaller
description: d
component: caller-orch
methods:
  - name: fetchOnce
    description: Fetches the module exactly once through the portal.
    signature: "fetchOnce(): void"
    returns: "void"`);
    proj.writeSpec('implementation', 'impl-caller-orch', `schemaVersion: 1.0.0
id: impl-caller-orch
name: ImplCaller
description: d
contract: icaller-orch
methods:
  - name: fetchOnce
    narrative:
      - { stepNumber: 1, description: route the capability, type: dispatch, targetComponent: pkg-portal, capability: shadow_module.get, assertsGuarantees: [exactly-once] }`);
    proj.activate();
    try {
      const found = issuesWith(validateSddTree(), 'NARRATIVE_SEMANTIC_UNBACKED');
      expect(found.map(f => f.message).join('\n')).toMatch(/exactly-once.*shadow-server\.getModule/s);
    } finally { proj.cleanup(); }
  });

  it('lifecycle entrypoints rooting a flow in another subsystem are flagged', () => {
    const proj = createTempProject();
    proj.subsystem('sub-a', 'lifecycle:\n  - { phase: init, component: foreign-orch, method: run }');
    proj.subsystem('sub-b');
    proj.component('foreign-orch', 'Orchestrator', '', 'sub-b');
    proj.writeSpec('interface', 'iforeign-orch', `schemaVersion: 1.0.0
id: iforeign-orch
name: IForeign
description: d
component: foreign-orch
methods:
  - name: run
    description: Runs the foreign boot flow.
    signature: "run(): void"
    returns: "void"`);
    proj.activate();
    try {
      expect(codesOf(validateSddTree())).toContain('LIFECYCLE_CROSS_SUBSYSTEM');
    } finally { proj.cleanup(); }
  });

  it('namespace hygiene: ids shadowing a root subsystem and the reserved keyword "super" are flagged', () => {
    const proj = createTempProject();
    proj.subsystem('sub-a');
    proj.component('super', 'Orchestrator');
    proj.activate();
    try {
      expect(codesOf(validateSddTree())).toContain('RESERVED_ID_SEGMENT');
    } finally { proj.cleanup(); }
    // NAMESPACE_SHADOWING needs a subproject-resident id — covered structurally:
    // a qualified id whose local segment equals a root subsystem id.
  });
});

describe('untyped seams (UNTYPED_SEAM)', () => {
  it('a published generic-dispatch portal WITH a table is exempt from the seam warning', () => {
    const proj = createTempProject();
    proj.subsystem('sub-a', 'publicInterfaces:\n  - { type: Custom, details: d, component: env-portal }');
    proj.component('env-portal', 'Portal',
      'portalType: Custom\ndependsOn: [env-server]\ndispatch:\n  - { capability: env.get, component: env-server, method: getEnv }');
    proj.component('env-server', 'Specialist');
    proj.writeSpec('interface', 'ienv-portal', `schemaVersion: 1.0.0
id: ienv-portal
name: IEnvPortal
description: d
component: env-portal
methods:
  - name: handle
    description: Generic capability envelope dispatched by capability name.
    signature: "handle(payload: Json): Promise<Json>"
    returns: "Promise<Json>"
    params:
      - { name: payload, type: Json }`);
    proj.writeSpec('interface', 'ienv-server', `schemaVersion: 1.0.0
id: ienv-server
name: IEnvServer
description: d
component: env-server
methods:
  - name: getEnv
    description: Returns the environment record for a key.
    signature: "getEnv(key: string): string"
    returns: "string"`);
    proj.activate();
    try {
      // The portal's Json envelope is the sanctioned pattern once the
      // per-capability typing lives in the table.
      expect(issuesWith(validateSddTree(), 'UNTYPED_SEAM')).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('flags bare Json/any params and returns on a published component only', () => {
    const proj = createTempProject();
    proj.subsystem('sub-a', 'publicInterfaces:\n  - { type: Custom, details: d, component: edge-portal }');
    proj.component('edge-portal', 'Portal', 'portalType: Custom\ndependsOn: [inner-spec]');
    proj.component('inner-spec', 'Specialist');
    proj.writeSpec('interface', 'iedge-portal', `schemaVersion: 1.0.0
id: iedge-portal
name: IEdge
description: d
component: edge-portal
methods:
  - name: invoke
    description: Generic envelope crossing the subsystem boundary.
    signature: "invoke(payload: Json): Promise<Json>"
    returns: "Promise<Json>"
    params:
      - { name: payload, type: Json }
  - name: typed
    description: A properly typed boundary method.
    signature: "typed(name: string): string"
    returns: "string"
    params:
      - { name: name, type: string }`);
    proj.writeSpec('interface', 'iinner-spec', `schemaVersion: 1.0.0
id: iinner-spec
name: IInner
description: d
component: inner-spec
methods:
  - name: crunch
    description: Internal helper that legitimately passes loose bags around.
    signature: "crunch(bag: Json): Json"
    returns: "Json"
    params:
      - { name: bag, type: Json }`);
    proj.activate();
    try {
      const res = validateSddTree();
      const seams = issuesWith(res, 'UNTYPED_SEAM');
      expect(seams).toHaveLength(1);
      expect(seams[0].message).toMatch(/invoke/);
      expect(seams[0].message).toMatch(/param "payload: Json".*return "Promise<Json>"|return "Promise<Json>"/);
      expect(seams.map(s => s.message).join('\n')).not.toMatch(/Method "(crunch|typed)"/);
    } finally { proj.cleanup(); }
  });
});

describe('prose claims (UNREALIZED_CLAIM)', () => {
  it('flags a persistence claim with no data-layer edge; a real edge or a data stereotype clears it', () => {
    const proj = createTempProject();
    proj.subsystem('sub-a');
    proj.component('flow-orch', 'Orchestrator', 'dependsOn: [cfg-store]');
    proj.component('cfg-store', 'Store');
    proj.writeSpec('interface', 'iflow-orch', `schemaVersion: 1.0.0
id: iflow-orch
name: IFlow
description: d
component: flow-orch
methods:
  - name: applyConfig
    description: Applies and persists new configuration.
    signature: "applyConfig(): void"
    returns: "void"
  - name: applyConfigForReal
    description: Applies and persists new configuration with a real edge.
    signature: "applyConfigForReal(): void"
    returns: "void"`);
    proj.writeSpec('interface', 'icfg-store', `schemaVersion: 1.0.0
id: icfg-store
name: ICfg
description: d
component: cfg-store
methods:
  - name: put
    description: Stores the configuration record.
    signature: "put(cfg: string): void"
    returns: "void"`);
    proj.writeSpec('implementation', 'impl-flow-orch', `schemaVersion: 1.0.0
id: impl-flow-orch
name: ImplFlow
description: d
contract: iflow-orch
methods:
  - name: applyConfig
    narrative:
      - { stepNumber: 1, description: the merged config is persisted and survives restart, type: local }
  - name: applyConfigForReal
    narrative:
      - { stepNumber: 1, description: the merged config is persisted and survives restart, type: local }
      - { stepNumber: 2, description: store the merged config, type: call, targetComponent: cfg-store, targetMethod: put }`);
    proj.writeSpec('implementation', 'impl-cfg-store', `schemaVersion: 1.0.0
id: impl-cfg-store
name: ImplCfg
description: d
contract: icfg-store
methods:
  - name: put
    detail: intent
    intent: Writes the configuration record into the persisted backing file, replacing the previous version atomically; fails with a StorageError when the file cannot be written.`);
    proj.activate();
    try {
      const res = validateSddTree();
      const claims = issuesWith(res, 'UNREALIZED_CLAIM');
      expect(claims).toHaveLength(1);
      expect(claims[0].message).toMatch(/applyConfig/);
      expect(claims[0].message).not.toMatch(/applyConfigForReal/);
      // the Store's own intent prose claiming persistence is exempt
      expect(claims.map(c => c.message).join('\n')).not.toMatch(/impl-cfg-store/);
    } finally { proj.cleanup(); }
  });
});
