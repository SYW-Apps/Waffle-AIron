import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { saveSystemSpec, saveSubsystemSpec, invalidateSpecCache } from '../../src/core/specs.js';
import * as projector from '../../src/core/domain_projector.js';
import * as curator from '../../src/core/domain_curator.js';
import * as topology from '../../src/core/topology.js';
import * as registry from '../../src/core/domains.js';
import * as store from '../../src/config/loader.js';
import { WaironError } from '../../src/utils/errors.js';
import type { Domain, SubsystemSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// The two components that sit ABOVE the topology Repository, and why they are
// not in it.
//
// `domain_projector` answers what domains exist, and that spans two sources at
// once: the subsystems the spec tree declares, and the free-standing domains
// the configuration registers. `domain_curator` registers one and takes one
// back out, and the check a registration needs — refusing an id the spec tree
// already answers to — needs both of those sources too.
//
// Combining two sources is workflow. A Store, Registry or Index may reach its
// own store, a backend Adapter or pure logic, so neither of these could live
// inside `topology_repository`: while `resolveDomains` lived in ./domains.ts,
// the Registry imported ./specs.js, and that import is the finding.
//
// What these tests hold to account is the split itself. Each half of the id
// check is caught where it can actually be SEEN, the two refusals say different
// things to the caller, and a refusal writes nothing.
// ---------------------------------------------------------------------------

const now = '2026-09-21T10:00:00Z';

const subsystem = (id: string): SubsystemSpec => ({
  id, name: id, description: `subsystem ${id}`, parentSystem: 'domain-workflow-system',
  publicInterfaces: [], trustedLinks: [], status: 'draft', createdAt: now, updatedAt: now,
} as SubsystemSpec);

describe('domain_projector and domain_curator span the two sources the Repository may not', () => {
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

  /** Two subsystems (two DERIVED domains) and, unless `withConfig` is false,
   *  one free-standing domain written straight into .wai/topology.yaml — the
   *  fixture never goes through the code under test to set itself up. */
  function buildFixture(withConfig = true): string {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-domain-workflow-'));
    fs.mkdirSync(path.join(proj, '.wai', 'specs'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.wai', 'project.yaml'), JSON.stringify({
      schemaVersion: '1.0.0', name: 'domain-workflow-system', projectType: 'backend',
      targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
      rules: {}, createdAt: now, updatedAt: now,
    }));
    if (withConfig) {
      fs.writeFileSync(path.join(proj, '.wai', 'topology.yaml'), [
        'schemaVersion: 1.0.0',
        'domains:',
        '  - id: tooling',
        '    name: Tooling',
        '    path: tools',
        '    ownedPaths:',
        "      - 'tools/**'",
      ].join('\n') + '\n');
    }
    setProjectRoot(proj);
    saveSystemSpec({
      schemaVersion: '1.0.0', name: 'domain-workflow-system',
      vision: 'a domain workflow fixture', boundaries: [], globalRequirements: [],
      createdAt: now, updatedAt: now,
    });
    saveSubsystemSpec(subsystem('billing'));
    saveSubsystemSpec(subsystem('shipping'));
    invalidateSpecCache();
    return proj;
  }

  const freeStanding = (id: string): Domain => ({ id, name: id, ownedPaths: [`${id}/**`] });
  const registeredIds = (): string[] => store.loadTopologyConfig().domains.map((d) => d.id).sort();

  // -- 1. the projector: both sources, told apart by `boundTo` ---------------

  it('answers both kinds as one list, each still saying where it came from', () => {
    buildFixture();

    expect(projector.resolveDomains().map((d) => d.id).sort())
      .toEqual(['billing', 'shipping', 'tooling']);
    expect(projector.deriveSubsystemDomains().map((d) => d.id).sort())
      .toEqual(['billing', 'shipping']);

    const derived = projector.resolveDomains().find((d) => d.id === 'billing')!;
    const registered = projector.resolveDomains().find((d) => d.id === 'tooling')!;
    expect(derived.boundTo).toBe('billing');
    expect(registered.boundTo).toBeUndefined();
  });

  it('owns the subsystem spec path for every domain it derives', () => {
    buildFixture();

    const derived = projector.deriveSubsystemDomains().find((d) => d.id === 'shipping')!;
    expect(derived.ownedPaths.length).toBeGreaterThan(0);
    expect(derived.ownedPaths.some((p) => p.includes('shipping'))).toBe(true);
  });

  it('still derives the spec-tree half when the project has no configuration at all', () => {
    // An uninitialized topology is a legitimate state, not a failure: the
    // derived half comes from the spec tree and does not need the file to
    // exist. A projector that read the configuration first and gave up would
    // answer nothing for every project that has not registered a domain yet.
    const root = buildFixture(false);
    expect(fs.existsSync(path.join(root, '.wai', 'topology.yaml'))).toBe(false);

    expect(projector.resolveDomains().map((d) => d.id).sort()).toEqual(['billing', 'shipping']);
    expect(projector.deriveSubsystemDomains().map((d) => d.id).sort()).toEqual(['billing', 'shipping']);
  });

  it('reads the registered half through the facade, not the store beneath it', () => {
    buildFixture();

    // The narrative says topology_repository.loadConfig. Reaching
    // ../config/loader.js directly would put the projector past the facade and
    // into one of its members — the same crossing, one component further out.
    const facadeSpy = vi.spyOn(topology, 'loadConfig');

    projector.resolveDomains();

    expect(facadeSpy).toHaveBeenCalledTimes(1);
  });

  // -- 2. the curator: one id space, two places it can already be taken ------

  it('registers a domain nothing answers to, and persists it through the facade', () => {
    const root = buildFixture();

    curator.registerDomain(freeStanding('docs'));

    expect(registeredIds()).toEqual(['docs', 'tooling']);
    expect(fs.readFileSync(path.join(root, '.wai', 'topology.yaml'), 'utf8')).toContain('docs');
    expect(projector.resolveDomains().map((d) => d.id).sort())
      .toEqual(['billing', 'docs', 'shipping', 'tooling']);
  });

  it('refuses an id a SUBSYSTEM derives — the collision the file cannot see', () => {
    buildFixture();

    // `billing` lives in no file, so a check reading only .wai/topology.yaml
    // accepts it and leaves two domains answering to one id. That is the whole
    // reason this check is here and not in the Registry.
    expect(() => curator.registerDomain(freeStanding('billing'))).toThrow(WaironError);
    expect(() => curator.registerDomain(freeStanding('billing'))).toThrow(/subsystem-derived/);

    expect(registeredIds()).toEqual(['tooling']);
    expect(projector.resolveDomains().filter((d) => d.id === 'billing')).toHaveLength(1);
  });

  it('refuses an id already REGISTERED, and says a different thing about it', () => {
    buildFixture();

    expect(() => curator.registerDomain(freeStanding('tooling'))).toThrow(WaironError);
    expect(() => curator.registerDomain(freeStanding('tooling')))
      .toThrow(/already exists in \.wai\/topology\.yaml/);

    expect(registeredIds()).toEqual(['tooling']);
  });

  it('tells the two refusals apart, because they ask the caller to fix different things', () => {
    buildFixture();

    const derivedClash = message(() => curator.registerDomain(freeStanding('billing')));
    const registeredClash = message(() => curator.registerDomain(freeStanding('tooling')));

    // One says the spec tree already answers to the id, the other says the
    // configuration does. A caller that cannot tell them apart does not know
    // which file to open.
    expect(derivedClash).not.toBe(registeredClash);
    expect(derivedClash).toContain('subsystem-derived');
    expect(registeredClash).toContain('.wai/topology.yaml');
  });

  it('never reaches the write when it refuses', () => {
    buildFixture();

    const writeSpy = vi.spyOn(registry, 'addFreeStandingDomain');

    expect(() => curator.registerDomain(freeStanding('billing'))).toThrow(WaironError);

    // A refusal that still called the registry would be a refusal the caller
    // could not trust — and the registry cannot see this clash to stop it.
    expect(writeSpy).not.toHaveBeenCalled();
  });

  // -- 3. the curator: unregistering is the repository's refusal, forwarded ---

  it('unregisters a free-standing domain and persists the removal', () => {
    const root = buildFixture();

    curator.unregisterDomain('tooling');

    expect(registeredIds()).toEqual([]);
    expect(fs.readFileSync(path.join(root, '.wai', 'topology.yaml'), 'utf8')).not.toContain('tooling');
  });

  it('lets the repository refuse a DERIVED id rather than answering "removed"', () => {
    const root = buildFixture();
    const configBefore = fs.readFileSync(path.join(root, '.wai', 'topology.yaml'), 'utf8');

    expect(() => curator.unregisterDomain('billing')).toThrow(/not a free-standing domain/);

    expect(projector.resolveDomains().find((d) => d.id === 'billing')!.boundTo).toBe('billing');
    expect(fs.readFileSync(path.join(root, '.wai', 'topology.yaml'), 'utf8')).toBe(configBefore);
  });

  function message(run: () => void): string {
    try {
      run();
    } catch (err: unknown) {
      return err instanceof Error ? err.message : String(err);
    }
    throw new Error('expected a refusal, got none');
  }
});
