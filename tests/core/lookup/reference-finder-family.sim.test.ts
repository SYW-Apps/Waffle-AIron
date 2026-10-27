import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../../src/utils/fs.js';
import { invalidateSpecCache, exportUsage } from '../../../src/core/specs.js';
import { collect } from '../../../src/core/lookup/reference-finder.js';
import { find } from '../../../src/core/lookup/spec-search.js';
import { materializeFixtureProject, type FixtureTree } from '../../rules-matrix/harness';
import { projectYaml } from '../../helpers/conformance-r6-trees';

// Integration sim for reference_finder's export-use path: a real family on disk,
// where a member project uses the bound project's exported Portal through its L0
// export table, and the finder lists that use as a reference from the consumer.
describe('sim: reference_finder.collect across the family', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-lookup-family-')));
  const write = (dir: string, tree: FixtureTree, config: string): void => {
    fs.mkdirSync(dir, { recursive: true });
    materializeFixtureProject(dir, { ...tree, files: { ...(tree.files ?? {}), '.wai/project.yaml': config } });
  };

  write(root, {
    system: { name: 'shop-platform', vision: 'The shop.', targetLanguage: 'TypeScript', publicInterfaces: [{ from: 'edge', component: 'shop_api_portal', as: 'shop-api', audience: 'project' }] },
    subsystems: [{ id: 'edge', description: 'The public API.', publicInterfaces: [{ component: 'shop_api_portal', details: 'The shop API.' }] }],
    components: [{ id: 'shop_api_portal', componentType: 'Portal', transport: 'InProcess', description: 'The shop API.', invokedBy: { kind: 'entry', caller: 'Applications linking the shop' } }],
    interfaces: [{ id: 'ishop_api_portal', component: 'shop_api_portal', methods: [
      { name: 'getPayment', description: 'One payment.', params: [{ name: 'paymentId', type: 'string' }], returns: 'string', effect: 'read' },
      { name: 'listPayments', description: 'All payments.', params: [], returns: 'list<string>', effect: 'read' },
    ] }],
  }, projectYaml('shop-platform', { members: { payments_svc: 'services/payments' } }));

  write(path.join(root, 'services', 'payments'), {
    system: { name: 'payments', vision: 'Payments.', targetLanguage: 'TypeScript' },
    subsystems: [{ id: 'payments', description: 'Payments.' }],
    components: [{ id: 'payment_sync', componentType: 'Orchestrator', description: 'Syncs payments from the shop.', dependsOn: ['shop-platform::shop-api'], invokedBy: { kind: 'runtime', caller: 'The sync timer' } }],
    interfaces: [{ id: 'ipayment_sync', component: 'payment_sync', methods: [{ name: 'sync', description: 'Sync one payment.', params: [{ name: 'paymentId', type: 'string' }], returns: 'void' }] }],
    implementations: [{ id: 'payment_sync_impl', contract: 'ipayment_sync', methods: [{ name: 'sync', narrative: [
      { stepNumber: 1, type: 'call', description: 'Read the payment.', targetComponent: 'shop-platform::shop-api', targetMethod: 'getPayment' },
    ] }] }],
  }, projectYaml('payments_svc', { externals: { 'shop-platform': { project: 'shop-platform', source: { path: '../..' } } } }));

  setProjectRoot(root);
  invalidateSpecCache();
  afterAll(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* windows locks */ }
  });

  it('reads the consumer\'s use of the export the fixture declares', () => {
    expect(exportUsage('payments_svc', '').used.map((u) => u.publicName)).toEqual(['shop-api']);
  });

  it('lists a consumer project\'s use of the exported component, from the spec that uses it', () => {
    const uses = collect('shop_api_portal').references.filter((r) => r.kind === 'export-use');
    expect(uses.length).toBeGreaterThan(0);
    expect(uses.every((r) => r.place.project === 'payments_svc' && r.evidence === 'declared' && !r.inTest)).toBe(true);
    expect(uses.map((r) => r.fromSpec)).toEqual(expect.arrayContaining(['payments_svc::payment_sync_impl']));
  });

  it('lists a method\'s use only where the consumer calls that method', () => {
    const used = collect('shop_api_portal.getPayment').references.filter((r) => r.kind === 'export-use');
    expect(used.map((r) => r.fromSpec)).toEqual(['payments_svc::payment_sync_impl']);
    expect(collect('shop_api_portal.listPayments').references.filter((r) => r.kind === 'export-use')).toEqual([]);
  });

  it("places a member project's spec in that project, under the member key it is reached by", () => {
    const step = collect('shop_api_portal.getPayment').references.find((r) => r.kind === 'call-step');
    expect(step?.place).toMatchObject({ project: 'payments_svc', member: 'payments_svc', component: 'payments_svc::payment_sync' });
    expect(find('payment_sync').matches.find((m) => m.id === 'payments_svc::payment_sync')?.place).toMatchObject({ project: 'payments_svc', member: 'payments_svc' });
    expect(find('shop_api_portal').matches[0].place.project).toBe('shop-platform');
  });

  it('judges the impact as the family, the widest place a reference sits', () => {
    expect(collect('shop_api_portal.getPayment').impact).toBe('family');
  });
});
