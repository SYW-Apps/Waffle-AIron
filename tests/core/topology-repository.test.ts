import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { saveSystemSpec, saveSubsystemSpec, invalidateSpecCache } from '../../src/core/specs.js';
import * as topology from '../../src/core/topology.js';
import * as registry from '../../src/core/domains.js';
import * as store from '../../src/config/loader.js';
import { WaironError } from '../../src/utils/errors.js';
import type { Domain, SubsystemSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// topology_repository — the facade over `domain_registry` and `topology_store`.
//
// It is a forwarder and nothing else, so what these tests can prove is exactly
// two things and they are both worth proving: that every method reaches the
// member that OWNS the work (not the other one, and not a second
// implementation of it), and that the member's own semantics survive the trip.
//
// The semantics that matter here are the two kinds of domain, which the
// registry keeps apart on purpose: a subsystem-bound domain is DERIVED from the
// spec tree on every call and lives in no file, while a free-standing one is a
// decision about the repository's shape and lives in the configuration.
// Conflating them is how a derived domain would get written into a file and
// then drift from the tree it came from — so `addFreeStanding` refuses an id
// either kind already holds, and `removeFreeStanding` cannot reach a derived
// one at all.
// ---------------------------------------------------------------------------

const now = '2026-09-21T10:00:00Z';

const subsystem = (id: string): SubsystemSpec => ({
  id, name: id, description: `subsystem ${id}`, parentSystem: 'topology-facade-system',
  publicInterfaces: [], trustedLinks: [], status: 'draft', createdAt: now, updatedAt: now,
} as SubsystemSpec);

describe('topology_repository forwards to its members and keeps the two kinds of domain apart', () => {
  let proj = '';

  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    vi.restoreAllMocks();
    if (proj) {
      try { fs.rmSync(proj, { recursive: true, force: true }); } catch { /* win locks */ }
      proj = '';
    }
  });

  /** A project with two subsystems (two DERIVED domains) and one free-standing
   *  domain written straight into .wai/topology.yaml — the fixture never goes
   *  through the code under test to set itself up. */
  function buildFixture(): string {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-topology-facade-'));
    fs.mkdirSync(path.join(proj, '.wai', 'specs'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.wai', 'project.yaml'), JSON.stringify({
      schemaVersion: '1.0.0', name: 'topology-facade-system', projectType: 'backend',
      targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
      rules: {}, createdAt: now, updatedAt: now,
    }));
    fs.writeFileSync(path.join(proj, '.wai', 'topology.yaml'), [
      'schemaVersion: 1.0.0',
      'domains:',
      '  - id: tooling',
      '    name: Tooling',
      '    path: tools',
      '    ownedPaths:',
      "      - 'tools/**'",
    ].join('\n') + '\n');
    setProjectRoot(proj);
    saveSystemSpec({
      schemaVersion: '1.0.0', name: 'topology-facade-system',
      vision: 'a topology facade fixture', boundaries: [], globalRequirements: [],
      createdAt: now, updatedAt: now,
    });
    saveSubsystemSpec(subsystem('billing'));
    saveSubsystemSpec(subsystem('shipping'));
    invalidateSpecCache();
    return proj;
  }

  const freeStanding = (id: string): Domain => ({ id, name: id, ownedPaths: [`${id}/**`] });

  // -- 1. the six domain reads and writes reach the REGISTRY -----------------

  it('forwards every domain method to the registry and answers what the registry answered', () => {
    buildFixture();

    // Each spy answers a value nothing else in the fixture produces, so a
    // method wired to the wrong member cannot accidentally look right.
    const sentinel = [freeStanding('sentinel')];
    const resolveSpy = vi.spyOn(registry, 'resolveDomains').mockReturnValue(sentinel);
    const findSpy = vi.spyOn(registry, 'findDomain').mockReturnValue(sentinel[0]);
    const listSpy = vi.spyOn(registry, 'listFreeStandingDomains').mockReturnValue([]);
    const deriveSpy = vi.spyOn(registry, 'deriveSubsystemDomains').mockReturnValue([]);
    const addSpy = vi.spyOn(registry, 'addFreeStandingDomain').mockImplementation(() => {});
    const removeSpy = vi.spyOn(registry, 'removeFreeStandingDomain').mockImplementation(() => {});

    expect(topology.resolve()).toBe(sentinel);
    expect(topology.find('sentinel')).toBe(sentinel[0]);
    expect(topology.listFreeStanding()).toEqual([]);
    expect(topology.deriveFromSubsystems()).toEqual([]);
    topology.addFreeStanding(sentinel[0]);
    topology.removeFreeStanding('sentinel');

    expect(resolveSpy).toHaveBeenCalledTimes(1);
    expect(findSpy).toHaveBeenCalledExactlyOnceWith('sentinel');
    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(deriveSpy).toHaveBeenCalledTimes(1);
    expect(addSpy).toHaveBeenCalledExactlyOnceWith(sentinel[0]);
    expect(removeSpy).toHaveBeenCalledExactlyOnceWith('sentinel');
  });

  // -- 2. the two configuration methods reach the STORE ----------------------

  it('forwards the configuration methods to the store and answers what the store answered', () => {
    buildFixture();

    const held = { schemaVersion: '1.0.0', domains: [freeStanding('from-the-store')] };
    const loadSpy = vi.spyOn(store, 'loadTopologyConfig').mockReturnValue(held);
    const saveSpy = vi.spyOn(store, 'saveTopologyConfig').mockImplementation(() => {});

    expect(topology.loadConfig()).toBe(held);
    topology.saveConfig(held);

    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy).toHaveBeenCalledExactlyOnceWith(held);
  });

  // -- 3. unmocked, the facade answers exactly what each member answers -------

  it('answers, for a real project, what each member answers on its own', () => {
    buildFixture();

    expect(topology.resolve()).toEqual(registry.resolveDomains());
    expect(topology.find('tooling')).toEqual(registry.findDomain('tooling'));
    expect(topology.listFreeStanding()).toEqual(registry.listFreeStandingDomains());
    expect(topology.deriveFromSubsystems()).toEqual(registry.deriveSubsystemDomains());
    expect(topology.loadConfig()).toEqual(store.loadTopologyConfig());

    // And the two kinds are both there, told apart by `boundTo`.
    expect(topology.resolve().map((d) => d.id).sort()).toEqual(['billing', 'shipping', 'tooling']);
    expect(topology.deriveFromSubsystems().map((d) => d.id).sort()).toEqual(['billing', 'shipping']);
    expect(topology.listFreeStanding().map((d) => d.id)).toEqual(['tooling']);
    expect(topology.find('billing')!.boundTo).toBe('billing');
    expect(topology.find('tooling')!.boundTo).toBeUndefined();
  });

  // -- 4. registering: the id space is one, across both kinds ----------------

  it('registers a free-standing domain and persists it to .wai/topology.yaml', () => {
    const root = buildFixture();

    topology.addFreeStanding(freeStanding('docs'));

    expect(topology.listFreeStanding().map((d) => d.id).sort()).toEqual(['docs', 'tooling']);
    const onDisk = fs.readFileSync(path.join(root, '.wai', 'topology.yaml'), 'utf8');
    expect(onDisk).toContain('docs');
  });

  it('refuses an id another free-standing domain already holds', () => {
    buildFixture();

    expect(() => topology.addFreeStanding(freeStanding('tooling'))).toThrow(WaironError);
    // Refused means refused: nothing was appended.
    expect(topology.listFreeStanding().map((d) => d.id)).toEqual(['tooling']);
  });

  it('refuses an id a SUBSYSTEM derives, which lives in no file to collide with', () => {
    buildFixture();

    // The collision the file cannot see: `billing` is derived from the spec
    // tree on every call, so a check that only read .wai/topology.yaml would
    // accept this and leave two domains answering to one id.
    expect(() => topology.addFreeStanding(freeStanding('billing'))).toThrow(/subsystem-derived/);
    expect(topology.listFreeStanding().map((d) => d.id)).toEqual(['tooling']);
    expect(topology.resolve().filter((d) => d.id === 'billing')).toHaveLength(1);
  });

  // -- 5. unregistering: a derived domain is not the writable set ------------

  it('unregisters a free-standing domain and persists the removal', () => {
    const root = buildFixture();

    topology.removeFreeStanding('tooling');

    expect(topology.listFreeStanding()).toEqual([]);
    expect(fs.readFileSync(path.join(root, '.wai', 'topology.yaml'), 'utf8')).not.toContain('tooling');
  });

  it('leaves a DERIVED domain exactly as it was — it is removed by removing its subsystem', () => {
    const root = buildFixture();
    const before = topology.find('billing');
    const configBefore = fs.readFileSync(path.join(root, '.wai', 'topology.yaml'), 'utf8');

    expect(() => topology.removeFreeStanding('billing')).toThrow(/not a free-standing domain/);

    // Unchanged in every way a caller can observe: still resolved, identical,
    // and the configuration file was never rewritten.
    expect(topology.find('billing')).toEqual(before);
    expect(topology.find('billing')!.boundTo).toBe('billing');
    expect(fs.readFileSync(path.join(root, '.wai', 'topology.yaml'), 'utf8')).toBe(configBefore);
  });

  // -- 6. the file, for callers that want the document ----------------------

  it('round-trips the configuration through the store', () => {
    buildFixture();
    const config = topology.loadConfig();

    config.domains.push(freeStanding('docs'));
    topology.saveConfig(config);

    expect(topology.loadConfig().domains.map((d) => d.id).sort()).toEqual(['docs', 'tooling']);
    expect(store.loadTopologyConfig()).toEqual(topology.loadConfig());
  });
});
