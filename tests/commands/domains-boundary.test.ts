import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { saveSystemSpec, saveSubsystemSpec, invalidateSpecCache } from '../../src/core/specs.js';
import * as adapter from '../../src/commands/subsystem.js';
import * as portal from '../../src/core/index.js';
import * as topology from '../../src/core/topology.js';
import { runDomainsList } from '../../src/commands/domains.js';
import type { SubsystemSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// Where `wairon domains` is allowed to reach the topology.
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
// Nothing was broken by it, which is why it survived. Both spellings compile,
// so only the import SITE says which side of the boundary the command is on —
// which is the question the last two tests ask and a type-check cannot.
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

  // -- 1. the four adapter methods the contract names ------------------------

  it('answers, for the same project, exactly what the Portal and the facade answer', () => {
    buildFixture();

    expect(adapter.resolveDomains()).toEqual(portal.resolveDomains());
    expect(adapter.resolveDomains()).toEqual(topology.resolve());
    expect(adapter.resolveDomains().map((d) => d.id)).toEqual(['billing']);
  });

  it('registers and unregisters a free-standing domain the whole chain then agrees on', () => {
    const root = buildFixture();

    adapter.addDomain({ id: 'docs', name: 'Docs', ownedPaths: ['docs/**'] });

    expect(adapter.resolveDomains().map((d) => d.id).sort()).toEqual(['billing', 'docs']);
    expect(topology.listFreeStanding().map((d) => d.id)).toEqual(['docs']);
    expect(fs.existsSync(path.join(root, '.wai', 'topology.yaml'))).toBe(true);

    adapter.removeDomain('docs');

    expect(adapter.resolveDomains().map((d) => d.id)).toEqual(['billing']);
    expect(topology.listFreeStanding()).toEqual([]);
  });

  it('proposes candidates without registering any of them', () => {
    const root = buildFixture();
    fs.mkdirSync(path.join(root, 'packages', 'shipping'), { recursive: true });
    fs.writeFileSync(path.join(root, 'packages', 'shipping', 'package.json'), '{"name":"shipping"}');

    const candidates = adapter.detectDomainCandidates(root);

    expect(candidates.map((c) => c.suggestedId)).toContain('shipping');
    // A proposal is not a registration: the topology is untouched.
    expect(topology.listFreeStanding()).toEqual([]);
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
    expect(source).toContain("from './subsystem.js'");
    expect(source).toContain('  resolveDomains,');
    expect(source).toContain('  addDomain,');
    expect(source).toContain('  removeDomain,');
    expect(source).toContain('  detectDomainCandidates,');
    // The two option shapes the type specs claim this file publishes.
    expect(source).toContain('export interface DomainsScanOptions {');
    expect(source).toContain('export interface DomainsAddOptions {');
  });

  it('is published on the core Portal as stated forwards, not as a star export of the member', () => {
    // The anchored conformance tier reads the export STATEMENT, and a star
    // export of ./domains.js republished the whole raw surface of a member
    // the Portal names four operations of.
    const source = fs.readFileSync(path.join(REPO_ROOT, 'src/core/index.ts'), 'utf8');
    expect(source).not.toContain("export * from './domains.js';");
    expect(source).toContain("import * as topology from './topology.js';");
    expect(source).toContain('export function resolveDomains(): Domain[] {');
    expect(source).toContain('  return topology.resolve();');
    expect(source).toContain('export function addDomain(domain: Domain): void {');
    expect(source).toContain('  topology.addFreeStanding(domain);');
    expect(source).toContain('export function removeDomain(id: string): void {');
    expect(source).toContain('  topology.removeFreeStanding(id);');
  });

  it('keeps the agent resolver on the facade rather than on the store beneath it', () => {
    // agent_resolver's narrative says topology_repository.loadConfig; reading
    // ../config/loader.js directly would reach past the facade into a member.
    const source = fs.readFileSync(path.join(REPO_ROOT, 'src/core/agent_resolver.ts'), 'utf8');
    expect(source).not.toContain("from '../config/loader.js'");
    expect(source).toContain("import * as topology from './topology.js';");
    expect(source).toContain('topology.loadConfig().domains');
  });
});
