import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { loadProjectExtensions } from '../../src/core/extensions.js';
import { buildServerInstructions } from '../../src/core/instructions.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { createScopedServer } from '../../src/server/adapters.js';

// ---------------------------------------------------------------------------
// MCP server instructions — the entrypoint wairon pushes to a connecting agent.
//
// Three seams:
//   1. wairon's OWN briefing: it is composed at all, names the bound project's
//      governing profile, and points at the skills rather than restating them.
//   2. The pack channel: a pack's `instructions` block is appended under an
//      attributed heading, in pack load order, honouring profile scoping.
//   3. The protocol surface: the REAL factory (and the hosted scoped factory
//      that reuses it) delivers the text on `initialize`, where a client injects
//      it into the agent's system prompt.
// ---------------------------------------------------------------------------

function createTempProject(opts: { packs?: string[]; projectType?: string } = {}) {
  invalidateSpecCache();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-instr-test-'));

  const waiDir = path.join(tempDir, '.wai');
  fs.mkdirSync(waiDir);
  fs.writeFileSync(path.join(waiDir, 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0',
    name: 'test-project',
    projectType: opts.projectType ?? 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {},
    // Hermetic: globally installed packs (~/.wairon/packs) are auto-loaded for
    // every project on the machine, so a developer with a pack installed would
    // otherwise see foreign instruction blocks and skills in these assertions.
    extensions: { useGlobalPacks: false, ...(opts.packs?.length ? { packs: opts.packs } : {}) },
    createdAt: '2026-07-03T10:00:00Z',
    updatedAt: '2026-07-03T10:00:00Z',
  }));

  const specsDir = path.join(waiDir, 'specs');
  for (const d of ['subsystems', 'components', 'interfaces', 'implementations', 'types']) {
    fs.mkdirSync(path.join(specsDir, d), { recursive: true });
  }
  fs.writeFileSync(path.join(specsDir, '.index.yaml'),
    "schemaVersion: 1.0.0\nname: TestSystem\nvision: testing\ncreatedAt: '2026-07-03T10:00:00Z'\nupdatedAt: '2026-07-03T10:00:00Z'\n");

  return {
    writeFile: (rel: string, content: string) => {
      const p = path.join(tempDir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    },
    activate: () => { vi.spyOn(process, 'cwd').mockReturnValue(tempDir); },
    cleanup: () => {
      invalidateSpecCache();
      vi.restoreAllMocks();
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* win file locks */ }
    },
  };
}

async function instructionsOverProtocol(server: ReturnType<typeof createMcpServer>): Promise<string | undefined> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'instructions-test', version: '0.0.1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client.getInstructions();
}

describe('wairon instructions (the wairon-owned default)', () => {
  it('teaches the SDD model: the tree shape, the authoring order, and the tools', () => {
    const text = buildServerInstructions();
    // The L0→L5 shape — an agent that never read a skill still learns the levels.
    for (const level of ['L0 System', 'L1 Subsystem', 'L2 Component', 'L3 Interface', 'L4 Implementation', 'L5 Narrative']) {
      expect(text).toContain(level);
    }
    // Authoring order + the gate, by tool name.
    expect(text).toContain('sdd_initialize_system');
    expect(text).toContain('sdd_add_subsystem');
    expect(text).toContain('sdd_validate_tree');
    // The tool schemas are the field reference — not this text.
    expect(text).toMatch(/self-describing/i);
  });

  it('directs the agent to read sdd-architect BEFORE authoring, by resource uri', () => {
    const text = buildServerInstructions();
    expect(text).toContain('wairon-skill://sdd-architect');
    expect(text).toMatch(/before you design anything/i);
    // Every published skill is reachable, so the pointer list cannot go stale
    // against the skills the server actually serves.
    for (const id of ['sdd-architect', 'sdd-auditor', 'sdd-implement', 'sdd-narrative']) {
      expect(text).toContain(`wairon-skill://${id}`);
    }
  });

  it('names the governing profile of the BOUND project', () => {
    const proj = createTempProject({ projectType: 'frontend-reactive' });
    proj.activate();
    try {
      expect(buildServerInstructions()).toContain('`frontend-reactive`');
    } finally { proj.cleanup(); }
  });

  it('stays a map, not a copy of the skills — pointer-heavy and bounded', () => {
    // Hermetic on purpose: pack skills and pack blocks legitimately add length,
    // so the ceiling is measured against wairon's own briefing.
    const proj = createTempProject();
    proj.activate();
    try {
      // A briefing loaded into every session's system prompt must stay small;
      // the depth lives in the skill documents this points at.
      expect(buildServerInstructions().length).toBeLessThan(6000);
    } finally { proj.cleanup(); }
  });
});

const PACK_WITH_INSTRUCTIONS = `name: appenser
version: 1.2.0
instructions: >-
  Specs in this project stay target-agnostic. Make.com mechanics (method
  selector, JSON argument envelope, Router branches, blueprint patches) never
  enter a spec.
`;

const SCOPED_PACK = `name: scopedpack
profiles:
  make-automation:
    family: neutral
instructions:
  - text: Applies only under the make-automation profile.
    profile: [make-automation]
  - text: Applies to every project this pack governs.
`;

describe('pack-contributed instructions (the pack channel)', () => {
  it('loads a scalar instructions block with pack provenance', () => {
    const proj = createTempProject({ packs: ['.wai/packs/appenser.yaml'] });
    proj.writeFile('.wai/packs/appenser.yaml', PACK_WITH_INSTRUCTIONS);
    proj.activate();
    try {
      const ext = loadProjectExtensions();
      expect(ext.instructions).toHaveLength(1);
      expect(ext.instructions[0].pack).toBe('appenser');
      expect(ext.instructions[0].text).toContain('target-agnostic');
      expect(ext.instructions[0].profile).toBeUndefined();
    } finally { proj.cleanup(); }
  });

  it('appends the block to wairon\'s own text under an attributed heading', () => {
    const proj = createTempProject({ packs: ['.wai/packs/appenser.yaml'] });
    proj.writeFile('.wai/packs/appenser.yaml', PACK_WITH_INSTRUCTIONS);
    proj.activate();
    try {
      const text = buildServerInstructions();
      expect(text).toContain('## From pack "appenser"');
      expect(text).toContain('target-agnostic');
      // Appended AFTER wairon's own briefing — the pack adjusts the default, it
      // does not replace or precede it.
      expect(text.indexOf('# wairon — Spec-Driven Development')).toBeLessThan(text.indexOf('## From pack "appenser"'));
      // And the pack is reported as governing this project.
      expect(text).toContain('`appenser`');
    } finally { proj.cleanup(); }
  });

  it('honours profile scoping: withholds a block whose profile is not governing', () => {
    const proj = createTempProject({ packs: ['.wai/packs/scoped.yaml'], projectType: 'backend' });
    proj.writeFile('.wai/packs/scoped.yaml', SCOPED_PACK);
    proj.activate();
    try {
      const text = buildServerInstructions();
      expect(text).not.toContain('Applies only under the make-automation profile.');
      expect(text).toContain('Applies to every project this pack governs.');
    } finally { proj.cleanup(); }
  });

  it('includes a scoped block once its profile IS governing', () => {
    const proj = createTempProject({ packs: ['.wai/packs/scoped.yaml'], projectType: 'make-automation' });
    proj.writeFile('.wai/packs/scoped.yaml', SCOPED_PACK);
    proj.activate();
    try {
      const text = buildServerInstructions();
      expect(text).toContain('Applies only under the make-automation profile.');
      expect(text).toContain('Applies to every project this pack governs.');
    } finally { proj.cleanup(); }
  });

  it('appends multiple packs in LOAD order (project.yaml order is precedence)', () => {
    const proj = createTempProject({ packs: ['.wai/packs/first.yaml', '.wai/packs/second.yaml'] });
    proj.writeFile('.wai/packs/first.yaml', 'name: first\ninstructions: First pack delta.\n');
    proj.writeFile('.wai/packs/second.yaml', 'name: second\ninstructions: Second pack delta.\n');
    proj.activate();
    try {
      const text = buildServerInstructions();
      expect(text.indexOf('## From pack "first"')).toBeLessThan(text.indexOf('## From pack "second"'));
    } finally { proj.cleanup(); }
  });

  it('reports no packs and appends nothing when none are declared', () => {
    const proj = createTempProject();
    proj.activate();
    try {
      const text = buildServerInstructions();
      expect(text).not.toContain('## From pack');
      expect(text).toMatch(/None — only wairon's built-in doctrine applies\./);
    } finally { proj.cleanup(); }
  });
});

describe('instructions over the MCP protocol', () => {
  it('the real stdio factory delivers instructions on initialize', async () => {
    const instructions = await instructionsOverProtocol(createMcpServer());
    expect(instructions).toBeTruthy();
    expect(instructions).toContain('wairon-skill://sdd-architect');
  });

  it('the hosted scoped factory delivers them too', async () => {
    const instructions = await instructionsOverProtocol(createScopedServer());
    expect(instructions).toBeTruthy();
    expect(instructions).toContain('Spec-Driven Development');
  });
});
