import { describe, it, expect } from 'vitest';
import { buildRuleContext, type BuildContextOptions } from '../../src/core/rules/index.js';
import { emptyExtensions } from '../../src/core/extensions.js';
import { RulesConfigSchema } from '../../src/models/project.js';
import type { SurfaceContractEntry, SurfaceSnapshot } from '../../src/models/index.js';
import type { ValidationIssue } from '../../src/core/validation.js';

// ---------------------------------------------------------------------------
// The rule context's shared queries (rule_context): chained-mount and
// cross-tree reference analysis, surface-snapshot resolution, the contract
// method enumeration, the effective rule configs, the builtin type vocabulary,
// and the round-trip findings and known codes the caller gathers.
// ---------------------------------------------------------------------------

const stamp = { createdAt: '2026-09-15T10:00:00Z', updatedAt: '2026-09-15T10:00:00Z' };

const sub = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, name: id, description: 'd', parentSystem: 'S', publicInterfaces: [], trustedLinks: [], status: 'complete', ...stamp, ...extra }) as never;

const method = (name: string) => ({ name, description: 'd', signature: `${name}(): void`, returns: 'void' });

const intf = (id: string, component: string, methodNames: string[]) =>
  ({ id, name: id, description: 'd', component, methods: methodNames.map(method), status: 'complete', ...stamp }) as never;

function context(overrides: Partial<BuildContextOptions> = {}) {
  return buildRuleContext({
    system: { schemaVersion: '1.0.0', name: 'S', vision: 'v', ...stamp } as never,
    subsystems: [],
    components: [],
    interfaces: [],
    implementations: [],
    types: [],
    projectType: 'backend',
    roundTripIssues: [],
    knownIssueCodes: new Set<string>(),
    issues: [],
    ...overrides,
  });
}

describe('rule_context.isInChainedSubproject', () => {
  const ctx = context({
    subsystems: [sub('app'), sub('kid', { projectPath: 'kid' }), sub('kid::inner'), sub('plain::nested'), sub('a'), sub('a::b', { projectPath: 'b' })],
  });

  it('holds for a mount and for anything under it', () => {
    expect(ctx.isInChainedSubproject('kid')).toBe(true);
    expect(ctx.isInChainedSubproject('kid::inner')).toBe(true);
    expect(ctx.isInChainedSubproject('a::b::c')).toBe(true);
  });

  it('does not hold when no prefix of the id is a subsystem with a projectPath', () => {
    expect(ctx.isInChainedSubproject('app')).toBe(false);
    expect(ctx.isInChainedSubproject('a')).toBe(false);
    expect(ctx.isInChainedSubproject('plain::nested')).toBe(false);
    expect(ctx.isInChainedSubproject('unknown')).toBe(false);
  });
});

describe('rule_context.isExternalNamespaceRef', () => {
  const ctx = context({ subsystems: [sub('billing')] });

  it('holds for the explicit ::x and super::x forms', () => {
    expect(ctx.isExternalNamespaceRef('::shared::error-type')).toBe(true);
    expect(ctx.isExternalNamespaceRef('super::sibling')).toBe(true);
  });

  it('holds for a qualified id whose leading segment is not a subsystem of this tree', () => {
    expect(ctx.isExternalNamespaceRef('waffler_core::blueprints-portal')).toBe(true);
  });

  it('does not hold for a bare id, or an id qualified by a subsystem of this tree', () => {
    expect(ctx.isExternalNamespaceRef('invoice-store')).toBe(false);
    expect(ctx.isExternalNamespaceRef('billing::invoice-store')).toBe(false);
  });
});

describe('rule_context.isCollapsedCrossTreeRef', () => {
  const ctx = context({
    subsystems: [sub('kid', { projectPath: 'kid' }), sub('kid::core'), sub('kid::core::grand', { projectPath: 'grand' }), sub('app')],
  });

  it('holds for a reference made inside a mount that is not under the nearest enclosing mount', () => {
    expect(ctx.isCollapsedCrossTreeRef('invoice-portal', 'kid::core')).toBe(true);
    expect(ctx.isCollapsedCrossTreeRef('kid::core::x', 'kid::core::grand')).toBe(true);
  });

  it('does not hold under the nearest mount, for the mount itself, or outside every mount', () => {
    expect(ctx.isCollapsedCrossTreeRef('kid::core::store', 'kid::core')).toBe(false);
    expect(ctx.isCollapsedCrossTreeRef('kid', 'kid::core')).toBe(false);
    expect(ctx.isCollapsedCrossTreeRef('invoice-portal', 'app')).toBe(false);
  });
});

describe('rule_context.resolveSurfaceRef', () => {
  const entry = (component: string, methodNames: string[]): SurfaceContractEntry =>
    ({ id: `i${component}`, name: component, audience: 'instance', type: 'REST', component, methods: methodNames.map(method), details: '' }) as SurfaceContractEntry;
  const snapshot = (projectName: string, interfaces: SurfaceContractEntry[]): SurfaceSnapshot =>
    ({ projectName, origin: 'generated', generatedAt: '2026-09-15T10:00:00Z', interfaces, types: [] });
  const resolvedSnapshot = (resolution: ReturnType<ReturnType<typeof context>['resolveSurfaceRef']>): SurfaceSnapshot | undefined =>
    (resolution.kind === 'resolved' ? resolution.snapshot : undefined);

  it('resolves the local name against backing component names and entry ids', () => {
    const billing = snapshot('Parent::billing', [entry('invoice-portal', ['list'])]);
    const ctx = context({ surfaceSnapshots: [billing] });
    expect(resolvedSnapshot(ctx.resolveSurfaceRef('super::invoice-portal'))).toBe(billing);
    expect(resolvedSnapshot(ctx.resolveSurfaceRef('iinvoice-portal'))).toBe(billing);
  });

  it('consults only the provider the reference names — a sibling by its subsystem id', () => {
    const billing = snapshot('Parent::billing', [entry('portal', ['bill'])]);
    const shipping = snapshot('Parent::shipping', [entry('portal', ['ship'])]);
    const ctx = context({ surfaceSnapshots: [billing, shipping] });
    expect(resolvedSnapshot(ctx.resolveSurfaceRef('super::shipping::portal'))).toBe(shipping);
    expect(resolvedSnapshot(ctx.resolveSurfaceRef('super::Parent::billing::portal'))).toBe(billing);
  });

  it('is ambiguous when snapshots expose the name with different contracts, each provider listed once', () => {
    const ctx = context({
      surfaceSnapshots: [
        snapshot('Parent::billing', [entry('portal', ['bill'])]),
        snapshot('Parent::shipping', [entry('portal', ['ship'])]),
        snapshot('Parent::shipping', [entry('portal', ['ship-v2'])]),
      ],
    });
    expect(ctx.resolveSurfaceRef('super::portal')).toEqual({ kind: 'ambiguous', providers: ['Parent::billing', 'Parent::shipping'] });
  });

  it('resolves to the first match when every matching snapshot carries the same contract', () => {
    const first = snapshot('Parent::billing', [entry('portal', ['list'])]);
    const second = snapshot('Parent::shipping', [entry('portal', ['list'])]);
    const ctx = context({ surfaceSnapshots: [first, second] });
    expect(resolvedSnapshot(ctx.resolveSurfaceRef('super::portal'))).toBe(first);
  });

  it("consults the enclosing mounts' snapshots first, nearest first, and only for references made inside them", () => {
    const root = snapshot('Root', [entry('portal', ['root'])]);
    const kid = snapshot('Kid', [entry('portal', ['kid'])]);
    const grand = snapshot('Grand', [entry('portal', ['grand'])]);
    const ctx = context({
      subsystems: [sub('kid', { projectPath: 'kid' }), sub('kid::core'), sub('kid::core::grand', { projectPath: 'grand' }), sub('app')],
      surfaceSnapshots: [root],
      mountSurfaceSnapshots: [
        { namespace: 'kid', snapshots: [kid] },
        { namespace: 'kid::core::grand', snapshots: [grand] },
      ],
    });
    expect(resolvedSnapshot(ctx.resolveSurfaceRef('super::portal', 'kid::core'))).toBe(kid);
    expect(resolvedSnapshot(ctx.resolveSurfaceRef('super::portal', 'kid::core::grand'))).toBe(grand);
    expect(resolvedSnapshot(ctx.resolveSurfaceRef('super::portal', 'app'))).toBe(root);
    expect(resolvedSnapshot(ctx.resolveSurfaceRef('super::portal'))).toBe(root);
  });

  it('matches a renamed export only by its public name, and an unrenamed or older entry by its component too', () => {
    // An entry projected from an export table records its componentType. Named
    // "invoicing" over invoice-portal, it answers to that name alone.
    const renamed = snapshot('Billing', [{ ...entry('invoice-portal', ['list']), id: 'invoicing', componentType: 'Portal' }]);
    const ctx = context({ surfaceSnapshots: [renamed] });
    expect(resolvedSnapshot(ctx.resolveSurfaceRef('super::invoicing'))).toBe(renamed);
    expect(ctx.resolveSurfaceRef('super::invoice-portal')).toEqual({ kind: 'unresolved' });

    // Its id is just its interface: it carries no public name of its own.
    const narrowed = snapshot('Billing', [{ ...entry('invoice-portal', ['list']), interface: 'iinvoice-portal', componentType: 'Portal' }]);
    expect(resolvedSnapshot(context({ surfaceSnapshots: [narrowed] }).resolveSurfaceRef('super::invoice-portal'))).toBe(narrowed);

    // Written before exports carried a stereotype (a sibling surface): the fallback stands until stage 3.
    const older = snapshot('Billing', [{ ...entry('invoice-portal', ['list']), id: 'invoicing' }]);
    expect(resolvedSnapshot(context({ surfaceSnapshots: [older] }).resolveSurfaceRef('super::invoice-portal'))).toBe(older);
  });

  it('is unresolved when no snapshot covers the reference', () => {
    const ctx = context({ surfaceSnapshots: [snapshot('Parent::billing', [entry('portal', ['list'])])] });
    expect(ctx.resolveSurfaceRef('super::nothing')).toEqual({ kind: 'unresolved' });
    expect(ctx.resolveSurfaceRef('super::other::portal')).toEqual({ kind: 'unresolved' });
    expect(ctx.resolveSurfaceRef('super::')).toEqual({ kind: 'unresolved' });
  });
});

describe('rule_context.interfaceMethodsOf', () => {
  it("lists every contract method across the component's interfaces, in interface order", () => {
    const ctx = context({
      interfaces: [intf('ia', 'comp', ['one', 'two']), intf('ib', 'other', ['x']), intf('ic', 'comp', ['three'])],
    });
    expect(ctx.interfaceMethodsOf('comp').map(m => m.name)).toEqual(['one', 'two', 'three']);
    expect(ctx.interfaceMethodsOf('nobody')).toEqual([]);
  });
});

describe('rule_context rule configs (complexityConfigFor, documentationConfigFor, namingConfigFor)', () => {
  const profile = (rules: Record<string, unknown>) =>
    ({ family: 'neutral', forbiddenStereotypes: [], discouragedStereotypes: [], rules }) as never;

  const extensions = () => {
    const ext = emptyExtensions();
    ext.profiles['pack-profile'] = profile({
      complexity: { maxInterfaceMethods: 3 },
      documentation: { minDescriptionLength: 20 },
      naming: { methods: 'camelCase', stereotypes: { Store: { suffix: 'Store' } } },
    });
    ext.profiles['backend'] = profile({ naming: { components: 'kebab-case' } });
    return ext;
  };

  const rules = RulesConfigSchema.parse({
    complexity: { maxInterfaceMethods: 10, maxMethodParams: 4 },
    documentation: { requireDescriptions: true, minDescriptionLength: 5 },
    naming: { methods: 'PascalCase', types: 'PascalCase', stereotypes: { Store: { prefix: 'S' }, Index: { suffix: 'Index' } } },
  });

  const packed = () => context({
    subsystems: [sub('packed', { profile: 'pack-profile' }), sub('plain'), sub('blank', { profile: '' })],
    rules,
    projectType: 'backend',
    extensions: extensions(),
  });

  it("namingConfigFor bases on the subsystem profile pack's naming but lets the project's own win, merging stereotype patterns key by key", () => {
    const naming = packed().namingConfigFor('packed')!;
    // methods is set by both the pack (camelCase) and the project (PascalCase) — the project wins.
    expect(naming.methods).toBe('PascalCase');
    expect(naming.types).toBe('PascalCase');
    // Store is set by both — the project's own key wins over the pack's entirely.
    expect(naming.stereotypes?.Store).toMatchObject({ prefix: 'S' });
    expect(naming.stereotypes?.Store).not.toHaveProperty('suffix');
    // Index is set only by the project — carried through untouched.
    expect(naming.stereotypes?.Index).toMatchObject({ suffix: 'Index' });
  });

  it("namingConfigFor falls back to the project type's profile for a subsystem with no profile, an empty one, or none named", () => {
    const ctx = packed();
    for (const id of ['plain', 'blank', 'unknown', undefined]) {
      const naming = ctx.namingConfigFor(id)!;
      expect(naming.components).toBe('kebab-case');
      expect(naming.methods).toBe('PascalCase');
      expect(naming.stereotypes?.Store).toMatchObject({ prefix: 'S' });
    }
  });

  it("namingConfigFor answers the project's own config when no governing pack sets naming", () => {
    const ctx = context({ rules, projectType: 'fullstack', extensions: extensions() });
    expect(ctx.namingConfigFor('anything')).toBe(rules.naming);
    expect(context().namingConfigFor('anything')).toBeUndefined();
  });

  it("complexityConfigFor bases on the pack's complexity but the project's own explicit setting wins", () => {
    const ctx = packed();
    // maxInterfaceMethods is set by both (pack: 3, project: 10) — the project wins.
    expect(ctx.complexityConfigFor('packed')).toMatchObject({ maxInterfaceMethods: 10, maxMethodParams: 4 });
    expect(ctx.complexityConfigFor('plain')).toBe(rules.complexity);
  });

  it("documentationConfigFor bases on the pack's documentation but the project's own explicit setting wins", () => {
    const ctx = packed();
    // minDescriptionLength is set by both (pack: 20, project: 5) — the project wins.
    expect(ctx.documentationConfigFor('packed')).toMatchObject({ requireDescriptions: true, minDescriptionLength: 5 });
    expect(ctx.documentationConfigFor('plain')).toBe(rules.documentation);
  });
});

describe('rule_context.isBuiltinType', () => {
  it('matches the builtin vocabulary ignoring case', () => {
    const ctx = context();
    expect(ctx.isBuiltinType('string')).toBe(true);
    expect(ctx.isBuiltinType('Promise')).toBe(true);
    expect(ctx.isBuiltinType('U64')).toBe(true);
    expect(ctx.isBuiltinType('Invoice')).toBe(false);
  });
});

describe('rule_context gathered inputs', () => {
  it('carries the round-trip findings and the known issue codes its caller gathered', () => {
    const roundTripIssues: ValidationIssue[] = [
      { severity: 'error', code: 'ROUNDTRIP_SERIALIZATION', message: 'cannot be re-serialized', specId: 'comp-a' },
    ];
    const knownIssueCodes = new Set(['SOME_CODE']);
    const ctx = context({ roundTripIssues, knownIssueCodes });
    expect(ctx.roundTripIssues).toBe(roundTripIssues);
    expect(ctx.knownIssueCodes).toBe(knownIssueCodes);
  });
});
