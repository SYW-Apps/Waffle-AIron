import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { saveSystemSpec, saveSubsystemSpec, invalidateSpecCache } from '../../src/core/specs.js';
import * as adapter from '../../src/commands/adapters/core.js';
import * as portal from '../../src/core/index.js';
import * as generator from '../../src/exporters/generate.js';
import { runGenerate } from '../../src/commands/generate.js';
import type { SubsystemSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// Where `wairon generate` is allowed to reach the generator.
//
// The command imported generateAll and resolveExpectedOutputPaths straight out
// of ../exporters/generate.js — sdd_cli reaching into an sdd_core module, while
// core_portal.generateAll / .resolveExpectedOutputPaths existed for exactly
// this. It is the fifth time that reach has been found in two days:
// movedChildren, diffSize and settledSpecPaths out of ./approval.js, and the
// four core modules `wairon diagram` built its artifacts out of, were the
// first four.
//
// Nothing was broken by it, which is why it survived: an import that works is
// invisible until something asks where the boundary is. These tests ask, and
// the last one asks the question a type-check cannot — both spellings compile,
// so only the import SITE says which side of the boundary the command is on.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const now = '2026-09-20T10:00:00Z';

const subsystem = (id: string): SubsystemSpec => ({
  id, name: id, description: `subsystem ${id}`, parentSystem: 'gen-boundary-system',
  publicInterfaces: [], trustedLinks: [], status: 'draft', createdAt: now, updatedAt: now,
} as SubsystemSpec);

describe('wairon generate reaches the generator through cli_core_adapter, not through sdd_core modules', () => {
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

  /** A two-subsystem project with agent files materialized: a full generate
   *  writes system-architect.md, dom-a-owner.md and dom-b-owner.md. */
  function buildFixture(): string {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-generate-boundary-'));
    fs.mkdirSync(path.join(proj, '.wai', 'specs'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.wai', 'project.yaml'), JSON.stringify({
      schemaVersion: '1.0.0', name: 'gen-boundary-system', projectType: 'backend',
      targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
      rules: { materializeAgentFiles: true }, createdAt: now, updatedAt: now,
    }));
    setProjectRoot(proj);
    saveSystemSpec({
      schemaVersion: '1.0.0', name: 'gen-boundary-system',
      vision: 'a generation-boundary fixture', boundaries: [], globalRequirements: [],
      createdAt: now, updatedAt: now,
    });
    saveSubsystemSpec(subsystem('dom-a'));
    saveSubsystemSpec(subsystem('dom-b'));
    invalidateSpecCache();
    return proj;
  }

  // -- 1. the two adapter methods the contract names -------------------------

  it('writes every agent for every configured target, and answers one summary per agent', () => {
    const root = buildFixture();
    const agents = adapter.resolveAgentTopology();
    const config = adapter.loadProjectConfig()!;
    expect(agents.length).toBeGreaterThan(0);

    const summaries = adapter.generateAll(agents, config);

    expect(summaries.map((s) => s.agent.id).sort())
      .toEqual(['dom-a-owner', 'dom-b-owner', 'system-architect']);
    for (const summary of summaries) {
      expect(summary.results.length).toBe(1); // one configured target
      expect(fs.existsSync(summary.results[0].outputPath)).toBe(true);
    }
    const agentsDir = path.join(root, '.claude', 'agents');
    expect(fs.readdirSync(agentsDir).sort())
      .toEqual(['dom-a-owner.md', 'dom-b-owner.md', 'system-architect.md']);
  });

  it('answers where a run WOULD write without writing any of it', () => {
    const root = buildFixture();
    const agents = adapter.resolveAgentTopology();
    const config = adapter.loadProjectConfig()!;

    const expected = adapter.resolveExpectedOutputPaths(agents, config);

    expect(expected).toEqual(new Set([
      path.resolve(root, '.claude', 'agents', 'system-architect.md'),
      path.resolve(root, '.claude', 'agents', 'dom-a-owner.md'),
      path.resolve(root, '.claude', 'agents', 'dom-b-owner.md'),
    ]));
    // Enumerating is not rendering: nothing was written to answer it.
    expect(fs.existsSync(path.join(root, '.claude', 'agents'))).toBe(false);
  });

  it('forwards to core_portal, which republishes the generator by identity', () => {
    const root = buildFixture();
    const agents = adapter.resolveAgentTopology();
    const config = adapter.loadProjectConfig()!;

    // A 1:1 forward: the adapter, the Portal and the generator must answer the
    // same set for the same topology. Anything else is a second implementation
    // to drift.
    expect(adapter.resolveExpectedOutputPaths(agents, config))
      .toEqual(portal.resolveExpectedOutputPaths(agents, config));
    expect(adapter.resolveExpectedOutputPaths(agents, config))
      .toEqual(generator.resolveExpectedOutputPaths(agents, config, root));

    // The Portal's half is a re-export, so it is the same function object —
    // the anchored conformance tier reads that line, and so does this.
    expect(portal.generateAll).toBe(generator.generateAll);
    expect(portal.resolveExpectedOutputPaths).toBe(generator.resolveExpectedOutputPaths);

    // The adapter's half is a wrapper, so identity is the wrong question there;
    // what it owes is the same answer, and the agents it was handed back.
    const summaries = adapter.generateAll(agents, config, { dryRun: true });
    expect(summaries.map((s) => s.agent.id))
      .toEqual(portal.generateAll(agents, config, { dryRun: true }).map((s) => s.agent.id));
  });

  // -- 2. the command reaches generation THROUGH it --------------------------

  it('writes, for a configured target, exactly the files the adapter says the run owns', async () => {
    const root = buildFixture();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const agents = adapter.resolveAgentTopology();
    const config = adapter.loadProjectConfig()!;
    const expected = adapter.resolveExpectedOutputPaths(agents, config);

    await runGenerate({ recurse: false });

    const agentsDir = path.join(root, '.claude', 'agents');
    const written = new Set(
      fs.readdirSync(agentsDir).map((name) => path.resolve(agentsDir, name)),
    );
    expect(written).toEqual(expected);
    // The bodies are the live brief composition, as before the import moved.
    const body = fs.readFileSync(path.join(agentsDir, 'dom-a-owner.md'), 'utf8');
    expect(body).toContain('dom-a');
    expect(body).not.toContain('{{agentId}}');
  });

  // -- 3. the import site, which no type-check can assert --------------------

  it('is the only way the command reaches sdd_core — it names no exporters module', () => {
    // `../exporters/generate.js` and `./subsystem.js` both compile, so only the
    // import site says which side of the boundary the command is on. Literal
    // lines, not patterns: an escaped regex has quietly matched nothing here
    // three times.
    const source = fs.readFileSync(path.join(REPO_ROOT, 'src/commands/generate.ts'), 'utf8');
    expect(source).not.toContain("from '../exporters/generate.js'");
    expect(source).toContain("from './adapters/core.js'");
    expect(source).toContain('  generateAll,');
    expect(source).toContain('  resolveExpectedOutputPaths,');
  });

  it('is published on the core Portal as a stated re-export, not a star export', () => {
    // The anchored conformance tier reads the export STATEMENT: a name that
    // arrives through `export * from` is not a claim the Portal makes.
    const source = fs.readFileSync(path.join(REPO_ROOT, 'src/core/index.ts'), 'utf8');
    expect(source).toContain(
      "export { generateAll, resolveExpectedOutputPaths } from '../exporters/generate.js';",
    );
  });
});
