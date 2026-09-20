import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { saveSystemSpec, saveSubsystemSpec, invalidateSpecCache } from '../../src/core/specs.js';
import * as adapter from '../../src/commands/subsystem.js';
import * as portal from '../../src/core/index.js';
import * as projector from '../../src/core/domain_projector.js';
import * as curator from '../../src/core/domain_curator.js';
import * as topology from '../../src/core/topology.js';
import * as registry from '../../src/core/domains.js';
import { runDomainsList } from '../../src/commands/domains.js';
import type { SubsystemSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// Where `wairon domains` is allowed to reach the topology, and what the Portal
// is allowed to reach on the way.
//
// The command imported resolveDomains, addFreeStandingDomain,
// removeFreeStandingDomain and findDomain straight out of ../core/domains.js,
// and detectDomainCandidates out of ../core/detection.js — sdd_cli reaching
// into two sdd_core modules while core_portal already named all four
// operations on its contract. It is the sixth time that reach has been found:
// movedChildren, diffSize and settledSpecPaths out of ./approval.js, the four
// core modules `wairon diagram` built its artifacts out of, and the generator
// `wairon generate` wrote through were the first five.
//
// The Portal's own reach moved with this change. Its READ goes to
// `domain_projector`, which spans the spec tree and the configuration alike,
// and both WRITES go to `domain_curator` — never to the Repository facade,
// because a Portal that reaches a write-effect facade method is the shortcut
// the standard names by code, and because the id check a registration needs
// cannot be made where the write happens.
//
// Nothing was broken by any of it, which is why it survived. Both spellings
// compile, so only the import SITE says which side of a boundary a file is on —
// which is the question the last three tests ask and a type-check cannot.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const now = '2026-09-21T10:00:00Z';

const subsystem = (id: string): SubsystemSpec => ({
  id, name: id, description: `subsystem ${id}`, parentSystem: 'domains-boundary-system',
  publicInterfaces: [], trustedLinks: [], status: 'draft', createdAt: now, updatedAt: now,
} as SubsystemSpec);

describe('wairon domains reaches the topology through cli_core_adapter, not through sdd_core modules', () => {
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

  /** A project with one subsystem (a derived domain) and no configuration file
   *  yet — an uninitialized topology is a legitimate state to read. */
  function buildFixture(): string {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-domains-boundary-'));
    fs.mkdirSync(path.join(proj, '.wai', 'specs'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.wai', 'project.yaml'), JSON.stringify({
      schemaVersion: '1.0.0', name: 'domains-boundary-system', projectType: 'backend',
      targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
      rules: {}, createdAt: now, updatedAt: now,
    }));
    setProjectRoot(proj);
    saveSystemSpec({
      schemaVersion: '1.0.0', name: 'domains-boundary-system',
      vision: 'a domains-boundary fixture', boundaries: [], globalRequirements: [],
      createdAt: now, updatedAt: now,
    });
    saveSubsystemSpec(subsystem('billing'));
    invalidateSpecCache();
    return proj;
  }

  const registeredIds = (): string[] => topology.loadConfig().domains.map((d) => d.id).sort();

  // -- 1. the four adapter methods the contract names ------------------------

  it('answers, for the same project, exactly what the Portal and the projector answer', () => {
    buildFixture();

    expect(adapter.resolveDomains()).toEqual(portal.resolveDomains());
    expect(adapter.resolveDomains()).toEqual(projector.resolveDomains());
    expect(adapter.resolveDomains().map((d) => d.id)).toEqual(['billing']);
  });

  it('registers and unregisters a free-standing domain the whole chain then agrees on', () => {
    const root = buildFixture();

    adapter.addDomain({ id: 'docs', name: 'Docs', ownedPaths: ['docs/**'] });

    expect(adapter.resolveDomains().map((d) => d.id).sort()).toEqual(['billing', 'docs']);
    expect(registeredIds()).toEqual(['docs']);
    expect(fs.existsSync(path.join(root, '.wai', 'topology.yaml'))).toBe(true);

    adapter.removeDomain('docs');

    expect(adapter.resolveDomains().map((d) => d.id)).toEqual(['billing']);
    expect(registeredIds()).toEqual([]);
  });

  it('routes the round trip Portal → curator → facade → registry, every hop', () => {
    const root = buildFixture();

    // Spies that call through: what is being proved is the ROUTE, not the
    // result — the result is proved above. A Portal write that reached the
    // facade directly would still pass every assertion about the file.
    const register = vi.spyOn(curator, 'registerDomain');
    const unregister = vi.spyOn(curator, 'unregisterDomain');
    const facadeAdd = vi.spyOn(topology, 'addFreeStanding');
    const facadeRemove = vi.spyOn(topology, 'removeFreeStanding');
    const registryAdd = vi.spyOn(registry, 'addFreeStandingDomain');
    const registryRemove = vi.spyOn(registry, 'removeFreeStandingDomain');

    const docs = { id: 'docs', name: 'Docs', ownedPaths: ['docs/**'] };
    portal.addDomain(docs);
    portal.removeDomain('docs');

    expect(register).toHaveBeenCalledExactlyOnceWith(docs);
    expect(unregister).toHaveBeenCalledExactlyOnceWith('docs');
    expect(facadeAdd).toHaveBeenCalledExactlyOnceWith(docs);
    expect(facadeRemove).toHaveBeenCalledExactlyOnceWith('docs');
    expect(registryAdd).toHaveBeenCalledExactlyOnceWith(docs);
    expect(registryRemove).toHaveBeenCalledExactlyOnceWith('docs');

    // And it really went all the way to the file at the end of it.
    expect(fs.readFileSync(path.join(root, '.wai', 'topology.yaml'), 'utf8')).not.toContain('docs');
  });

  it('refuses through the Portal what the curator refuses, before anything is written', () => {
    const root = buildFixture();

    // `billing` is derived from the spec tree, so nothing downstream of the
    // curator can see the clash: the Portal's refusal IS the curator's.
    expect(() => portal.addDomain({ id: 'billing', name: 'Billing', ownedPaths: ['billing/**'] }))
      .toThrow(/subsystem-derived/);
    expect(fs.existsSync(path.join(root, '.wai', 'topology.yaml'))).toBe(false);
  });

  it('proposes candidates without registering any of them', () => {
    const root = buildFixture();
    fs.mkdirSync(path.join(root, 'packages', 'shipping'), { recursive: true });
    fs.writeFileSync(path.join(root, 'packages', 'shipping', 'package.json'), '{"name":"shipping"}');

    const candidates = adapter.detectDomainCandidates(root);

    expect(candidates.map((c) => c.suggestedId)).toContain('shipping');
    // A proposal is not a registration: the topology is untouched.
    expect(registeredIds()).toEqual([]);
  });

  // -- 2. the command reaches the topology THROUGH it ------------------------

  it('lists both kinds of domain, marking which one a reader is allowed to remove', async () => {
    buildFixture();
    const printed: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      printed.push(args.map(String).join(' '));
    });

    adapter.addDomain({ id: 'docs', name: 'Docs', ownedPaths: ['docs/**'] });
    await runDomainsList();

    const output = printed.join('\n');
    expect(output).toContain('billing');
    expect(output).toContain('subsystem: billing');
    expect(output).toContain('docs');
    expect(output).toContain('free-standing');
  });

  // -- 3. the import site, which no type-check can assert --------------------

  it('is the only way the command reaches sdd_core — it names no core module', () => {
    // `../core/domains.js` and `./subsystem.js` both compile, so only the
    // import site says which side of the boundary the command is on. Literal
    // lines, not patterns: an escaped regex has quietly matched nothing here
    // four times.
    const source = fs.readFileSync(path.join(REPO_ROOT, 'src/commands/domains.ts'), 'utf8');
    expect(source).not.toContain("from '../core/domains.js'");
    expect(source).not.toContain("from '../core/detection.js'");
    expect(source).not.toContain("from '../core/topology.js'");
    expect(source).not.toContain("from '../core/domain_projector.js'");
    expect(source).not.toContain("from '../core/domain_curator.js'");
    expect(source).toContain("from './subsystem.js'");
    expect(source).toContain('  resolveDomains,');
    expect(source).toContain('  addDomain,');
    expect(source).toContain('  removeDomain,');
    expect(source).toContain('  detectDomainCandidates,');
    // The two option shapes the type specs claim this file publishes.
    expect(source).toContain('export interface DomainsScanOptions {');
    expect(source).toContain('export interface DomainsAddOptions {');
  });

  it('is published on the core Portal as stated forwards to the two Orchestrators', () => {
    // The anchored conformance tier reads the export STATEMENT, and it reads
    // the call SITE: a namespace binding is what lets each site name the
    // contract method it reaches, where an `as` rename compiles to the same
    // thing while telling neither a reader nor the analysis which method that
    // was. The Portal no longer names the facade at all — its writes go to the
    // curator, which is where the id check can actually be made.
    const source = fs.readFileSync(path.join(REPO_ROOT, 'src/core/index.ts'), 'utf8');
    expect(source).not.toContain("export * from './domains.js';");
    expect(source).not.toContain("from './topology.js'");
    expect(source).toContain("import * as projector from './domain_projector.js';");
    expect(source).toContain("import * as curator from './domain_curator.js';");
    expect(source).toContain('export function resolveDomains(): Domain[] {');
    expect(source).toContain('  return projector.resolveDomains();');
    expect(source).toContain('export function addDomain(domain: Domain): void {');
    expect(source).toContain('  curator.registerDomain(domain);');
    expect(source).toContain('export function removeDomain(id: string): void {');
    expect(source).toContain('  curator.unregisterDomain(id);');
  });

  it('keeps the agent resolver on the facade rather than on the store beneath it', () => {
    // agent_resolver's narrative says topology_repository.loadConfig; reading
    // ../config/loader.js directly would reach past the facade into a member.
    const source = fs.readFileSync(path.join(REPO_ROOT, 'src/core/agent_resolver.ts'), 'utf8');
    expect(source).not.toContain("from '../config/loader.js'");
    expect(source).toContain("import * as topology from './topology.js';");
    expect(source).toContain('topology.loadConfig().domains');
  });

  it('keeps the projector on the two published surfaces, not on the store beneath either', () => {
    // The projector is the one place the two sources are joined, and it must
    // reach each through the face that publishes it: the spec tree through
    // ./specs.js, the configuration through ./topology.js. Naming
    // ../config/loader.js here would recreate the very violation this
    // component was split out to fix, one component further out.
    const source = fs.readFileSync(path.join(REPO_ROOT, 'src/core/domain_projector.ts'), 'utf8');
    expect(source).not.toContain("from '../config/loader.js'");
    expect(source).not.toContain("from './domains.js'");
    expect(source).toContain("import * as topology from './topology.js';");
    expect(source).toContain("from './specs.js'");
    expect(source).toContain('topology.loadConfig().domains');
  });
});
