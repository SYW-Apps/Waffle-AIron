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
// The facade publishes THREE methods now. `resolve`, `find`,
// `listFreeStanding` and `deriveFromSubsystems` left because answering "what
// domains exist" spans the spec tree as well as the configuration — that is
// workflow, and it lives above the facade in `domain_projector`; `saveConfig`
// left because no caller outside the registry ever wanted it. The registry's
// own reach is the finding that moved them: a Registry may touch its own Store,
// a backend Adapter or pure logic, and ./domains.ts was importing ./specs.js.
//
// What is left here is the WRITABLE set and the file. A subsystem-bound domain
// is DERIVED from the spec tree on every call and lives in no file, so
// `removeFreeStanding` cannot reach one at all — and the registry's duplicate
// check now guards only the set it owns, because the other half of that check
// needs a source it is not allowed to read.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const now = '2026-09-21T10:00:00Z';

const subsystem = (id: string): SubsystemSpec => ({
  id, name: id, description: `subsystem ${id}`, parentSystem: 'topology-facade-system',
  publicInterfaces: [], trustedLinks: [], status: 'draft', createdAt: now, updatedAt: now,
} as SubsystemSpec);

describe('topology_repository forwards to its members and keeps the writable set writable', () => {
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
  const registeredIds = (): string[] => topology.loadConfig().domains.map((d) => d.id).sort();

  // -- 1. the two writes reach the REGISTRY ---------------------------------

  it('forwards both writes to the registry, with the argument it was given', () => {
    buildFixture();

    const addSpy = vi.spyOn(registry, 'addFreeStandingDomain').mockImplementation(() => {});
    const removeSpy = vi.spyOn(registry, 'removeFreeStandingDomain').mockImplementation(() => {});

    const docs = freeStanding('docs');
    topology.addFreeStanding(docs);
    topology.removeFreeStanding('tooling');

    expect(addSpy).toHaveBeenCalledExactlyOnceWith(docs);
    expect(removeSpy).toHaveBeenCalledExactlyOnceWith('tooling');
  });

  // -- 2. the configuration read reaches the STORE --------------------------

  it('forwards the configuration read to the store and answers what the store answered', () => {
    buildFixture();

    // A value nothing in the fixture produces, so a method wired to the wrong
    // member cannot accidentally look right.
    const held = { schemaVersion: '1.0.0', domains: [freeStanding('from-the-store')] };
    const loadSpy = vi.spyOn(store, 'loadTopologyConfig').mockReturnValue(held);

    expect(topology.loadConfig()).toBe(held);
    expect(loadSpy).toHaveBeenCalledTimes(1);
  });

  it('publishes those three methods and no others — a surface with no consumer is one somebody keeps true', () => {
    const published = topology as unknown as Record<string, unknown>;

    expect(typeof published.addFreeStanding).toBe('function');
    expect(typeof published.removeFreeStanding).toBe('function');
    expect(typeof published.loadConfig).toBe('function');

    // The four reads moved to `domain_projector`; `saveConfig` had no caller.
    expect(published.resolve).toBeUndefined();
    expect(published.find).toBeUndefined();
    expect(published.listFreeStanding).toBeUndefined();
    expect(published.deriveFromSubsystems).toBeUndefined();
    expect(published.saveConfig).toBeUndefined();
  });

  // -- 3. unmocked, the facade answers exactly what the store answers --------

  it('answers, for a real project, what the store answers on its own', () => {
    buildFixture();

    expect(topology.loadConfig()).toEqual(store.loadTopologyConfig());
    expect(registeredIds()).toEqual(['tooling']);
  });

  // -- 4. registering: the registry guards the set it OWNS -------------------

  it('registers a free-standing domain and persists it to .wai/topology.yaml', () => {
    const root = buildFixture();

    topology.addFreeStanding(freeStanding('docs'));

    expect(registeredIds()).toEqual(['docs', 'tooling']);
    const onDisk = fs.readFileSync(path.join(root, '.wai', 'topology.yaml'), 'utf8');
    expect(onDisk).toContain('docs');
  });

  it('refuses an id another REGISTERED domain already holds, on its own', () => {
    buildFixture();

    // Straight at the registry: no curator, no projector, nothing above it.
    // This is the half of the id check a Store-bound component can actually
    // see, and it has to hold without help.
    expect(() => registry.addFreeStandingDomain(freeStanding('tooling'))).toThrow(WaironError);
    expect(() => registry.addFreeStandingDomain(freeStanding('tooling')))
      .toThrow(/already exists in \.wai\/topology\.yaml/);
    // Refused means refused: nothing was appended.
    expect(registeredIds()).toEqual(['tooling']);
  });

  it('does NOT see a subsystem-derived id — that check needs a source it may not read', () => {
    buildFixture();

    // `billing` is a derived domain, and the registry accepts it, because the
    // spec tree is not a Registry's to read. This is not a hole: `domain_curator`
    // refuses it before the call ever gets here, and the check lives there
    // precisely because it needs both sources at once. Asserting it here is how
    // the split stays deliberate rather than accidental.
    registry.addFreeStandingDomain(freeStanding('billing'));

    expect(registeredIds()).toEqual(['billing', 'tooling']);
  });

  // -- 5. unregistering: a derived domain is not in the writable set ---------

  it('unregisters a free-standing domain and persists the removal', () => {
    const root = buildFixture();

    topology.removeFreeStanding('tooling');

    expect(topology.loadConfig().domains).toEqual([]);
    expect(fs.readFileSync(path.join(root, '.wai', 'topology.yaml'), 'utf8')).not.toContain('tooling');
  });

  it('refuses to remove a DERIVED id, and rewrites nothing when it does', () => {
    const root = buildFixture();
    const configBefore = fs.readFileSync(path.join(root, '.wai', 'topology.yaml'), 'utf8');

    expect(() => registry.removeFreeStandingDomain('billing')).toThrow(/not a free-standing domain/);
    expect(() => topology.removeFreeStanding('billing')).toThrow(WaironError);

    // Unchanged in every way a caller can observe.
    expect(registeredIds()).toEqual(['tooling']);
    expect(fs.readFileSync(path.join(root, '.wai', 'topology.yaml'), 'utf8')).toBe(configBefore);
  });

  // -- 6. the import site, which no type-check can assert --------------------

  it('keeps the registry off the spec tree — ./domains.ts names no ./specs.js', () => {
    // The finding this whole change exists to close: a Registry may reach its
    // own Store, a backend Adapter or pure logic, and ./specs.js is none of the
    // three. Both spellings compile, so only the import SITE says whether the
    // boundary holds. Literal lines, not patterns: an escaped regex has quietly
    // matched nothing here four times.
    const source = fs.readFileSync(path.join(REPO_ROOT, 'src/core/domains.ts'), 'utf8');
    expect(source).not.toContain("from './specs.js'");
    expect(source).not.toContain("from './domain_projector.js'");
    expect(source).toContain("from '../config/loader.js'");
    expect(source).toContain('export function addFreeStandingDomain(domain: Domain): void {');
    expect(source).toContain('export function removeFreeStandingDomain(id: string): void {');
    // The reads left with the import.
    expect(source).not.toContain('export function resolveDomains(');
    expect(source).not.toContain('export function findDomain(');
    expect(source).not.toContain('export function listFreeStandingDomains(');
    expect(source).not.toContain('export function deriveSubsystemDomains(');
  });
});
