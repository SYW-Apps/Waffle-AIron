import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runInV5Reading, setProjectRoot } from '../../src/utils/fs.js';
import { writeYamlFile } from '../../src/utils/yaml.js';
import {
  getLoaderIssues,
  invalidateSpecCache,
  loadComponentSpecs,
  loadComponentSpec,
  loadInterfaceSpecs,
  loadImplementationSpecs,
  loadSubsystemSpec,
  loadSystemSpec,
} from '../../src/core/specs.js';
import { retireGateways } from '../../src/core/stereotype-migration.js';
import * as corePortal from '../../src/core/index.js';

// ---------------------------------------------------------------------------
// core_orchestrator.retireGateways — a Gateway that owns exactly one Portal, and
// whose own methods no other spec's narrative calls, is merged into that Portal:
// the Portal takes the gateway variant, the Gateway's other owned members become
// the Portal's dependencies, every component that depended on the Gateway
// depends on the Portal, every L1 or L0 export naming the Gateway names the
// Portal, and the Gateway's spec, contract and implementation are deleted. Any
// other Gateway is refused, naming why and the hand steps. A plan writes nothing.
// Gateways exist only in the v5 reading, so every case runs in it.
// ---------------------------------------------------------------------------

const now = '2026-10-18T00:00:00.000Z';
const roots: string[] = [];

afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

const component = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id, name: id, description: `the ${id} component`, subsystem: 'edge', componentType: 'Orchestrator', owns: [], dependsOn: [],
  status: 'complete', createdAt: now, updatedAt: now, ...over,
});
const contract = (id: string, comp: string): Record<string, unknown> => ({
  id, name: id, description: 'd', component: comp, status: 'complete', createdAt: now, updatedAt: now,
  methods: [{ name: 'handle', description: 'Handle one request.', signature: 'handle(): void', returns: 'void' }],
});
const implementation = (id: string, contractId: string, narrative: Record<string, unknown>[] = []): Record<string, unknown> => ({
  id, name: id, description: 'd', contract: contractId, status: 'complete', createdAt: now, updatedAt: now,
  methods: [{ name: 'handle', narrative }],
});

interface Fixture {
  root: string;
  /** Write one more spec file under .wai/specs. */
  put(rel: string, doc: Record<string, unknown>): void;
}

/**
 * The edge subsystem as wairon 5 wrote it: an `api-gw` Gateway owning an
 * `api-portal` Portal and a `rate-limiter` Adapter, with its own contract and
 * implementation, an `app-orch` consumer that depends on it, an L1 export and an
 * L0 export that name it.
 */
function edge(over: { gateway?: Record<string, unknown>; portal?: Record<string, unknown>; l1?: Record<string, unknown>[] } = {}): Fixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-gw-')));
  roots.push(root);
  const put = (rel: string, doc: Record<string, unknown>): void => writeYamlFile(path.join(root, '.wai', 'specs', ...rel.split('/')), doc);
  writeYamlFile(path.join(root, '.wai', 'project.yaml'), {
    schemaVersion: '1.0.0', id: 'gw', name: 'gw', targets: [], rules: {}, extensions: { packs: [], useGlobalPacks: false }, createdAt: now, updatedAt: now,
  });
  put('.index.yaml', {
    schemaVersion: '1.0.0', name: 'Edge', vision: 'v', boundaries: [], globalRequirements: [],
    publicInterfaces: [{ as: 'api', from: 'edge', component: 'api-gw', details: 'the api', audience: 'external' }], createdAt: now, updatedAt: now,
  });
  put('edge/.index.yaml', {
    id: 'edge', name: 'edge', description: 'd', parentSystem: 'Edge', trustedLinks: [], status: 'complete', createdAt: now, updatedAt: now,
    publicInterfaces: over.l1 ?? [{ details: 'the api', component: 'api-gw' }],
  });
  put('edge/api-gw/.index.yaml', component('api-gw', { componentType: 'Gateway', owns: ['api-portal', 'rate-limiter'], ...over.gateway }));
  put('edge/api-gw/.interface.yaml', contract('iapi-gw', 'api-gw'));
  put('edge/api-gw/.implementation.yaml', implementation('api-gw-impl', 'iapi-gw'));
  put('edge/api-portal/.index.yaml', component('api-portal', { componentType: 'Portal', portalType: 'HTTP_API', ...over.portal }));
  put('edge/rate-limiter/.index.yaml', component('rate-limiter', { componentType: 'Adapter' }));
  put('edge/app-orch/.index.yaml', component('app-orch', { dependsOn: ['api-gw'] }));
  setProjectRoot(root);
  invalidateSpecCache();
  return { root, put };
}

const ids = (list: { id: string }[]): string[] => list.map((c) => c.id).sort();

describe('retireGateways', () => {
  it('plans the merge of a Gateway that owns one Portal, and writes nothing', () => {
    const { root } = edge();
    const before = fs.readFileSync(path.join(root, '.wai', 'specs', 'edge', 'api-gw', '.index.yaml'), 'utf8');
    const plan = runInV5Reading(() => retireGateways(false));
    expect(plan).toEqual({
      merged: [{ gateway: 'api-gw', portal: 'api-portal', members: ['rate-limiter'], consumers: ['app-orch'], exports: ['edge', 'system'] }],
      refused: [],
      applied: false,
    });
    expect(fs.readFileSync(path.join(root, '.wai', 'specs', 'edge', 'api-gw', '.index.yaml'), 'utf8')).toBe(before);
    runInV5Reading(() => expect(ids(loadComponentSpecs())).toEqual(['api-gw', 'api-portal', 'app-orch', 'rate-limiter']));
  });

  it('merges it: the Portal takes the variant and the members, consumers and exports name the Portal, the Gateway is gone', () => {
    edge();
    const done = runInV5Reading(() => retireGateways(true));
    expect(done.applied).toBe(true);
    expect(done.merged).toHaveLength(1);

    // Read back outside the v5 reading: nothing of the Gateway is left to refuse.
    invalidateSpecCache();
    expect(ids(loadComponentSpecs())).toEqual(['api-portal', 'app-orch', 'rate-limiter']);
    expect(getLoaderIssues().filter((i) => i.severity === 'error').map((i) => i.message)).toEqual([]);
    expect(loadInterfaceSpecs()).toEqual([]);
    expect(loadImplementationSpecs()).toEqual([]);
    // The Portal's own variant and dependencies, and its consumer's, are as the merge left them.
    runInV5Reading(() => {
      const portal = loadComponentSpec('api-portal')!;
      expect(portal.variant).toBe('gateway');
      expect(portal.dependsOn).toEqual(['rate-limiter']);
      expect(loadComponentSpec('app-orch')!.dependsOn).toEqual(['api-portal']);
    });
    expect(loadSubsystemSpec('edge')!.publicInterfaces).toEqual([{ details: 'the api', component: 'api-portal' }]);
    expect(loadSystemSpec()!.publicInterfaces![0]).toMatchObject({ as: 'api', component: 'api-portal' });
    // An applied plan plans empty.
    expect(runInV5Reading(() => retireGateways(false))).toEqual({ merged: [], refused: [], applied: false });
  });

  it('is forwarded 1:1 by the core barrel', () => {
    edge();
    const plan = runInV5Reading(() => retireGateways(false));
    expect(runInV5Reading(() => corePortal.retireGateways(false))).toEqual(plan);
  });

  it('keeps the Portal\'s dependencies and does not duplicate a member it already depends on', () => {
    edge({ portal: { dependsOn: ['rate-limiter', 'app-orch'] } });
    runInV5Reading(() => retireGateways(true));
    runInV5Reading(() => expect(loadComponentSpec('api-portal')!.dependsOn).toEqual(['rate-limiter', 'app-orch']));
  });

  describe('refuses, writing nothing, naming why and the hand steps', () => {
    const refusal = (fixture: Fixture): string => {
      const before = fs.readdirSync(path.join(fixture.root, '.wai', 'specs', 'edge'));
      const plan = runInV5Reading(() => retireGateways(true));
      expect(plan.merged).toEqual([]);
      expect(plan.refused).toHaveLength(1);
      expect(plan.applied).toBe(true);
      expect(fs.readdirSync(path.join(fixture.root, '.wai', 'specs', 'edge'))).toEqual(before);
      runInV5Reading(() => expect(ids(loadComponentSpecs())).toContain('api-gw'));
      return plan.refused[0];
    };

    it('a Gateway that owns no Portal', () => {
      const message = refusal(edge({ gateway: { owns: ['rate-limiter'] } }));
      expect(message).toContain('Gateway "api-gw" cannot be merged into a Portal: it owns no Portal');
      expect(message).toContain('(1) the Portal it owns becomes the front door, with variant: gateway');
      expect(message).toContain('(4) delete the Gateway spec');
    });

    it('a Gateway that owns two Portals', () => {
      const fixture = edge({ gateway: { owns: ['api-portal', 'admin-portal'] } });
      fixture.put('edge/admin-portal/.index.yaml', component('admin-portal', { componentType: 'Portal', transport: 'HTTP' }));
      expect(refusal(fixture)).toContain('it owns 2 Portals (api-portal, admin-portal), and a Gateway merges into exactly one');
    });

    it('a Gateway whose own methods another narrative calls', () => {
      const fixture = edge();
      fixture.put('edge/app-orch/.interface.yaml', contract('iapp-orch', 'app-orch'));
      fixture.put('edge/app-orch/.implementation.yaml', implementation('app-orch-impl', 'iapp-orch', [
        { stepNumber: 1, type: 'call', description: 'Hand the request to the gateway.', targetComponent: 'api-gw', targetMethod: 'handle' },
      ]));
      invalidateSpecCache();
      expect(refusal(fixture)).toContain('its own methods are called by app-orch-impl.handle, and the Portal does not carry them');
    });

    it('a Portal that already has another variant', () => {
      expect(refusal(edge({ portal: { variant: 'tariff' } }))).toContain('the Portal "api-portal" already has the variant "tariff"');
    });

    it('a Gateway an export narrows to the contract of', () => {
      const message = refusal(edge({ l1: [{ details: 'the api', component: 'api-gw', interface: 'iapi-gw' }] }));
      expect(message).toContain('the export of edge narrows to its own contract');
    });

    it('merges the Gateways it can and refuses the rest in one run', () => {
      const fixture = edge();
      fixture.put('edge/odd-gw/.index.yaml', component('odd-gw', { componentType: 'Gateway', owns: [] }));
      const plan = runInV5Reading(() => retireGateways(true));
      expect(plan.merged.map((m) => m.gateway)).toEqual(['api-gw']);
      expect(plan.refused).toHaveLength(1);
      expect(plan.refused[0]).toContain('Gateway "odd-gw" cannot be merged into a Portal: it owns no Portal');
      runInV5Reading(() => expect(ids(loadComponentSpecs())).toEqual(['api-portal', 'app-orch', 'odd-gw', 'rate-limiter']));
    });
  });
});
