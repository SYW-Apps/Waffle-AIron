import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { validateSddTree, type ValidationIssue } from '../../src/core/validation.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { setProjectRoot } from '../../src/utils/fs.js';
import { structuralConformanceRule } from '../../src/core/rules/conformance/structural-conformance.js';

// ---------------------------------------------------------------------------
// Reported misbehaviour in the conformance family, each pinned where it was
// reproduced: integration-conformance counting files that do not exist and
// chained subprojects' child-relative paths, dependency-conformance reporting
// one edge twice, hidden-state ignoring the method-level conformance dial, and
// structural-conformance's UNREALIZED_FINDING summary.
// ---------------------------------------------------------------------------

const TS = '2026-09-15T10:00:00.000Z';

type Spec = Record<string, unknown> & { id: string };

interface Tree {
  systemName?: string;
  subsystems?: Spec[];
  components?: Spec[];
  interfaces?: Spec[];
  implementations?: Spec[];
  files?: Record<string, string>;
}

interface Unit { component: Spec; interface: Spec; implementation: Spec }

/** One component with a one-method contract and its implementation. */
function unit(id: string, opts: {
  subsystem: string;
  type?: string;
  dependencyClass?: 'pure' | 'read';
  dependsOn?: string[];
  owns?: string[];
  method: string;
  sourcePath?: string;
  findings?: { code: string; severity: string; summary: string }[];
  impl?: Record<string, unknown>;
}): Unit {
  return {
    component: {
      id,
      subsystem: opts.subsystem,
      componentType: opts.type ?? 'Orchestrator',
      ...(opts.dependencyClass ? { dependencyClass: opts.dependencyClass } : {}),
      dependsOn: opts.dependsOn ?? [],
      owns: opts.owns ?? [],
    },
    interface: {
      id: `i${id}`,
      component: id,
      methods: [{
        name: opts.method,
        description: `${opts.method} does its one job, carefully and observably.`,
        signature: `${opts.method}(): void`,
        returns: 'void',
        ...(opts.findings ? { findings: opts.findings } : {}),
      }],
    },
    implementation: {
      id: `${id}-impl`,
      contract: `i${id}`,
      ...(opts.sourcePath ? { sourcePath: opts.sourcePath } : {}),
      methods: [{ name: opts.method, detail: 'intent', intent: 'Performs its one job against its inputs; failures surface as thrown errors.' }],
      ...opts.impl,
    },
  };
}

function tree(units: Unit[], rest: Omit<Tree, 'components' | 'interfaces' | 'implementations'>): Tree {
  return {
    ...rest,
    components: units.map(u => u.component),
    interfaces: units.map(u => u.interface),
    implementations: units.map(u => u.implementation),
  };
}

function writeTree(root: string, t: Tree): void {
  const systemName = t.systemName ?? 'Storefront';
  const write = (rel: string, data: unknown): void => {
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, typeof data === 'string' ? data : yaml.dump(data, { noRefs: true, lineWidth: 200 }));
  };
  const stamp = { schemaVersion: '1.0.0', createdAt: TS, updatedAt: TS };
  write('.wai/project.yaml', {
    ...stamp,
    name: systemName.toLowerCase(),
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {},
    extensions: { packs: [], useGlobalPacks: false },
  });
  write('.wai/specs/.index.yaml', { ...stamp, name: systemName, vision: 'A miniature system for one reported rule defect.' });
  for (const s of t.subsystems ?? []) write(`.wai/specs/subsystems/${s.id}.yaml`, { ...stamp, name: s.id, description: 'd', parentSystem: systemName, ...s });
  for (const c of t.components ?? []) write(`.wai/specs/components/${c.id}.yaml`, { ...stamp, name: c.id, description: 'd', ...c });
  for (const i of t.interfaces ?? []) write(`.wai/specs/interfaces/${i.id}.yaml`, { ...stamp, name: i.id, description: 'd', ...i });
  for (const im of t.implementations ?? []) write(`.wai/specs/implementations/${im.id}.yaml`, { ...stamp, name: im.id, description: 'd', ...im });
  for (const [rel, content] of Object.entries(t.files ?? {})) write(rel, content);
}

let roots: string[] = [];

afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* win file locks */ }
  }
  roots = [];
});

/** Validate a tree written at a fresh root; `children` lays down chained subprojects under it. */
function validate(t: Tree, children: Record<string, Tree> = {}): ValidationIssue[] {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-conf-fixes-')));
  roots.push(root);
  writeTree(root, t);
  for (const [rel, child] of Object.entries(children)) writeTree(path.join(root, ...rel.split('/')), child);
  invalidateSpecCache();
  setProjectRoot(root);
  return validateSddTree().issues;
}

const byCode = (issues: ValidationIssue[], code: string): ValidationIssue[] => issues.filter(i => i.code === code);

describe('integration-conformance — a missing own file reports once', () => {
  it('a component whose named file does not exist gets MISSING_SOURCE_FILE, not UNWIRED_INTEGRATION_SIM on top', () => {
    const issues = validate(tree([
      unit('order-orchestrator', {
        subsystem: 'ordering',
        dependsOn: ['pricing-engine'],
        method: 'placeOrder',
        sourcePath: 'src/ordering/order-orchestrator.ts',
        impl: { simPath: 'tests/integration/order.sim.ts' },
      }),
      unit('pricing-engine', { subsystem: 'ordering', type: 'Orchestrator', dependencyClass: 'pure', method: 'priceCart', sourcePath: 'src/ordering/pricing-engine.ts' }),
    ], {
      subsystems: [{ id: 'ordering' }],
      files: {
        'src/ordering/pricing-engine.ts': 'export function priceCart(): void {}\n',
        'tests/integration/order.sim.ts': "import { priceCart } from '../../src/ordering/pricing-engine.js';\npriceCart();\n",
      },
    }));
    expect(byCode(issues, 'MISSING_SOURCE_FILE').map(i => i.specId)).toEqual(['order-orchestrator-impl']);
    expect(byCode(issues, 'UNWIRED_INTEGRATION_SIM')).toEqual([]);
  });

  it("still names the component's existing files the harness does not reach, leaving the missing one to MISSING_SOURCE_FILE", () => {
    const issues = validate(tree([
      unit('order-orchestrator', {
        subsystem: 'ordering',
        dependsOn: ['pricing-engine'],
        method: 'placeOrder',
        sourcePath: 'src/ordering/order-orchestrator.ts',
        impl: {
          simPath: 'tests/integration/order.sim.ts',
          methods: [{
            name: 'placeOrder',
            sourcePath: 'src/ordering/commands/place-order.ts',
            detail: 'intent',
            intent: 'Places the priced order; failures surface as thrown errors.',
          }],
        },
      }),
      unit('pricing-engine', { subsystem: 'ordering', type: 'Orchestrator', dependencyClass: 'pure', method: 'priceCart', sourcePath: 'src/ordering/pricing-engine.ts' }),
    ], {
      subsystems: [{ id: 'ordering' }],
      files: {
        'src/ordering/order-orchestrator.ts': "export const orderingFlow = 'place-order';\n",
        'src/ordering/pricing-engine.ts': 'export function priceCart(): void {}\n',
        'tests/integration/order.sim.ts': "import { priceCart } from '../../src/ordering/pricing-engine.js';\npriceCart();\n",
      },
    }));
    const unwired = byCode(issues, 'UNWIRED_INTEGRATION_SIM');
    expect(unwired).toHaveLength(1);
    expect(unwired[0].message).toContain("the component's own module (src/ordering/order-orchestrator.ts)");
    expect(byCode(issues, 'MISSING_SOURCE_FILE').map(i => i.specId)).toEqual(['order-orchestrator-impl']);
  });
});

describe('integration-conformance — chained subprojects', () => {
  it("a dependency realized in a chained subproject is not judged by its child-relative paths resolved at this root", () => {
    const parent = tree([
      unit('checkout-orchestrator', {
        subsystem: 'storefront',
        dependsOn: ['billing::billing-portal'],
        method: 'checkout',
        sourcePath: 'src/checkout/checkout-orchestrator.ts',
        impl: { simPath: 'tests/integration/checkout.sim.ts' },
      }),
    ], {
      subsystems: [{ id: 'storefront' }, { id: 'billing', projectPath: 'packages/billing' }],
      files: {
        'src/checkout/checkout-orchestrator.ts': "import { chargeCard } from '../../packages/billing/src/portal.js';\nexport function checkout(): void { chargeCard(); }\n",
        // The storefront's own module at the path the billing child names relative to ITS root.
        'src/portal.ts': "export const storefrontBanner = 'welcome';\n",
        'tests/integration/checkout.sim.ts': "import { checkout } from '../../src/checkout/checkout-orchestrator.js';\ncheckout();\n",
      },
    });
    const billing = tree([
      unit('billing-portal', { subsystem: 'billing-core', type: 'Portal', method: 'chargeCard', sourcePath: 'src/portal.ts' }),
    ], {
      systemName: 'Billing',
      subsystems: [{ id: 'billing-core' }],
      files: { 'src/portal.ts': 'export function chargeCard(): void {}\n' },
    });
    const issues = validate(parent, { 'packages/billing': billing });
    // The chained child really loaded (its component is judged in this run).
    expect(issues.some(i => (i.specId ?? '').startsWith('billing::'))).toBe(true);
    expect(byCode(issues, 'UNWIRED_INTEGRATION_SIM')).toEqual([]);
  });
});

describe('dependency-conformance — a target both owned and depended on', () => {
  it('reports one UNREALIZED_DEPENDENCY for the edge, naming both relations', () => {
    const issues = validate(tree([
      unit('ledger-repository', {
        subsystem: 'ledger',
        type: 'Repository',
        owns: ['ledger-store'],
        dependsOn: ['ledger-store'],
        method: 'recordEntry',
        sourcePath: 'src/ledger/ledger-repository.ts',
      }),
      unit('ledger-store', { subsystem: 'ledger', type: 'Store', method: 'appendEntry', sourcePath: 'src/ledger/ledger-store.ts' }),
    ], {
      subsystems: [{ id: 'ledger' }],
      files: {
        'src/ledger/ledger-repository.ts': 'export function recordEntry(): void {}\n',
        'src/ledger/ledger-store.ts': 'export function appendEntry(): void {}\n',
      },
    }));
    const found = byCode(issues, 'UNREALIZED_DEPENDENCY').filter(i => i.message.includes('"ledger-store"'));
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('declares dependsOn and owns "ledger-store"');
  });
});

describe('hidden-state — the method-level conformance dial', () => {
  const STATEFUL = "let routeCache: Record<string, string> = {};\nexport function runFlow(id: string): void { routeCache[id] = id; }\n";
  const intent = 'Routes the shipment through the carrier table; failures surface as thrown errors.';

  it('a method dialed off does not make its own source file mapping evidence', () => {
    const issues = validate(tree([
      unit('shipment-flow', {
        subsystem: 'shipping',
        method: 'runFlow',
        sourcePath: 'src/shipping/shipment-flow.ts',
        impl: { methods: [{ name: 'runFlow', sourcePath: 'src/shipping/generated/route-table.ts', conformance: 'off', detail: 'intent', intent }] },
      }),
    ], {
      subsystems: [{ id: 'shipping' }],
      files: {
        'src/shipping/shipment-flow.ts': "export const flowName = 'shipment';\n",
        'src/shipping/generated/route-table.ts': STATEFUL,
      },
    }));
    expect(byCode(issues, 'HIDDEN_STATE')).toEqual([]);
  });

  it('a method dialed on under an implementation dialed off is mapping evidence for its own file', () => {
    const issues = validate(tree([
      unit('shipment-flow', {
        subsystem: 'shipping',
        method: 'runFlow',
        sourcePath: 'src/shipping/shipment-flow.ts',
        impl: {
          conformance: 'off',
          methods: [{ name: 'runFlow', sourcePath: 'src/shipping/shipment-router.ts', conformance: 'declared', detail: 'intent', intent }],
        },
      }),
    ], {
      subsystems: [{ id: 'shipping' }],
      files: {
        'src/shipping/shipment-flow.ts': "export const flowName = 'shipment';\n",
        'src/shipping/shipment-router.ts': STATEFUL,
      },
    }));
    const found = byCode(issues, 'HIDDEN_STATE');
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('"src/shipping/shipment-router.ts"');
  });
});

describe('structural-conformance — what a declared finding code must be among', () => {
  it('at exact grade a property-access name realizes the declared code', () => {
    const issues = validate(tree([
      unit('ledger-auditor', {
        subsystem: 'ledger',
        type: 'Orchestrator',
        dependencyClass: 'pure',
        method: 'auditLedger',
        sourcePath: 'src/ledger/ledger-auditor.ts',
        findings: [{ code: 'LEDGER_IMBALANCED', severity: 'warning', summary: 'Debits and credits of a ledger period differ' }],
      }),
    ], {
      subsystems: [{ id: 'ledger' }],
      files: {
        'src/ledger/ledger-auditor.ts': "import { Codes } from './codes.js';\nexport function auditLedger(report: (code: string) => void): void { report(Codes.LEDGER_IMBALANCED); }\n",
      },
    }));
    expect(byCode(issues, 'UNREALIZED_FINDING')).toEqual([]);
  });

  it('the UNREALIZED_FINDING summary names every anchor the check accepts', () => {
    const summary = structuralConformanceRule.codes.find(c => c.code === 'UNREALIZED_FINDING')!.summary;
    expect(summary).toContain('string literal');
    expect(summary).toContain('property-access name');
  });
});
