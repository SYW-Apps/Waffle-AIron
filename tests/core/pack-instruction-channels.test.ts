import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { loadProjectExtensions, type LoadedInstructionBlock } from '../../src/core/extensions.js';
import { blockReaches } from '../../src/models/pack-instructions.js';
import { buildServerInstructions } from '../../src/core/instructions.js';
import { guideBody } from '../../src/utils/ai-guide.js';
import { composeAgentBrief } from '../../src/core/agent_resolver.js';

// ---------------------------------------------------------------------------
// Pack instruction channels: a block names where it is delivered — the MCP
// server instructions (the default), the generated in-project guide, the live
// agent briefs — and each place applies the same profile scope under the
// profile that governs it.
// ---------------------------------------------------------------------------

function createTempProject(opts: { packs: string[]; projectType?: string }) {
  invalidateSpecCache();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-channels-test-'));
  const waiDir = path.join(tempDir, '.wai');
  fs.mkdirSync(waiDir);
  fs.writeFileSync(path.join(waiDir, 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0',
    name: 'test-project',
    projectType: opts.projectType ?? 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {},
    // Hermetic: no machine-wide packs.
    extensions: { useGlobalPacks: false, packs: opts.packs },
    createdAt: '2026-11-06T10:00:00Z',
    updatedAt: '2026-11-06T10:00:00Z',
  }));
  const specsDir = path.join(waiDir, 'specs');
  for (const d of ['subsystems', 'components', 'interfaces', 'implementations', 'types']) {
    fs.mkdirSync(path.join(specsDir, d), { recursive: true });
  }
  const stamp = "createdAt: '2026-11-06T10:00:00Z'\nupdatedAt: '2026-11-06T10:00:00Z'";
  fs.writeFileSync(path.join(specsDir, '.index.yaml'), `schemaVersion: 1.0.0\nname: TestSystem\nvision: testing\n${stamp}\n`);
  return {
    writeFile: (rel: string, content: string) => {
      const p = path.join(tempDir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    },
    writeSpec: (folder: string, name: string, content: string) => {
      fs.writeFileSync(path.join(specsDir, folder, `${name}.yaml`), `${content}\n${stamp}\n`);
    },
    activate: () => { vi.spyOn(process, 'cwd').mockReturnValue(tempDir); },
    cleanup: () => {
      invalidateSpecCache();
      vi.restoreAllMocks();
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* win file locks */ }
    },
  };
}

const CHANNEL_PACK = `name: channelpack
profiles:
  ledger:
    family: neutral
instructions:
  - text: Server only, as every block was before channels.
  - text: Guide and server.
    channels: [guide, server]
  - text: Guide only.
    channels: [guide]
  - text: Brief for every component.
    channels: [brief]
  - text: Brief only under the ledger profile.
    channels: [brief]
    profile: [ledger]
`;

function block(over: Partial<LoadedInstructionBlock>): LoadedInstructionBlock {
  return { text: 't', pack: 'p', ...over };
}

describe('blockReaches', () => {
  it('a block naming no channels reaches the server only', () => {
    expect(blockReaches(block({}), 'server', null)).toBe(true);
    expect(blockReaches(block({}), 'guide', null)).toBe(false);
    expect(blockReaches(block({}), 'brief', null)).toBe(false);
  });

  it('a block reaches exactly the channels it names', () => {
    const b = block({ channels: ['guide', 'brief'] });
    expect(blockReaches(b, 'server', null)).toBe(false);
    expect(blockReaches(b, 'guide', null)).toBe(true);
    expect(blockReaches(b, 'brief', null)).toBe(true);
  });

  it('a profile-scoped block applies only under a profile it names, and never under an unresolved one', () => {
    const b = block({ channels: ['brief'], profile: ['ledger'] });
    expect(blockReaches(b, 'brief', 'ledger')).toBe(true);
    expect(blockReaches(b, 'brief', 'backend')).toBe(false);
    expect(blockReaches(b, 'brief', null)).toBe(false);
  });
});

describe('pack instruction channels', () => {
  it('loads channels as authored, and refuses a channel that does not exist', () => {
    const proj = createTempProject({ packs: ['.wai/packs/channelpack.yaml', '.wai/packs/bad.yaml'] });
    proj.writeFile('.wai/packs/channelpack.yaml', CHANNEL_PACK);
    proj.writeFile('.wai/packs/bad.yaml', 'name: bad\ninstructions:\n  - text: x\n    channels: [email]\n');
    proj.activate();
    try {
      const ext = loadProjectExtensions();
      const own = ext.instructions.filter((b) => b.pack === 'channelpack');
      expect(own.map((b) => b.channels)).toEqual([undefined, ['guide', 'server'], ['guide'], ['brief'], ['brief']]);
      expect(ext.instructions.some((b) => b.pack === 'bad')).toBe(false);
      expect(ext.errors.length).toBeGreaterThan(0);
    } finally { proj.cleanup(); }
  });

  it('server instructions carry only the blocks that reach the server', () => {
    const proj = createTempProject({ packs: ['.wai/packs/channelpack.yaml'] });
    proj.writeFile('.wai/packs/channelpack.yaml', CHANNEL_PACK);
    proj.activate();
    try {
      const text = buildServerInstructions();
      expect(text).toContain('Server only, as every block was before channels.');
      expect(text).toContain('Guide and server.');
      expect(text).not.toContain('Guide only.');
      expect(text).not.toContain('Brief for every component.');
    } finally { proj.cleanup(); }
  });

  it('the local guide appends the blocks that reach the guide, attributed; the global guide carries none', () => {
    const proj = createTempProject({ packs: ['.wai/packs/channelpack.yaml'] });
    proj.writeFile('.wai/packs/channelpack.yaml', CHANNEL_PACK);
    proj.activate();
    try {
      const local = guideBody('local');
      expect(local).toContain('## From pack "channelpack"');
      expect(local).toContain('Guide and server.');
      expect(local).toContain('Guide only.');
      expect(local).not.toContain('Server only, as every block was before channels.');
      expect(local).not.toContain('Brief for every component.');
      expect(local.indexOf('### Rules')).toBeLessThan(local.indexOf('## From pack "channelpack"'));
      expect(guideBody('global')).not.toContain('## From pack');
    } finally { proj.cleanup(); }
  });

  it('a brief carries the blocks that reach briefs under its component\'s subsystem profile, before the project guidance', () => {
    const proj = createTempProject({ packs: ['.wai/packs/channelpack.yaml'] });
    proj.writeFile('.wai/packs/channelpack.yaml', CHANNEL_PACK);
    const sub = (id: string, profile?: string) => `schemaVersion: 1.0.0\nid: ${id}\nname: ${id}\ndescription: d\nparentSystem: TestSystem${profile ? `\nprofile: ${profile}` : ''}`;
    proj.writeSpec('subsystems', 'books', sub('books', 'ledger'));
    proj.writeSpec('subsystems', 'plain', sub('plain'));
    for (const [id, subsystem] of [['journal', 'books'], ['notes', 'plain']]) {
      proj.writeSpec('components', id, `id: ${id}\nname: ${id}\ndescription: d\nsubsystem: ${subsystem}\ncomponentType: Orchestrator`);
      proj.writeSpec('interfaces', `i${id}`, `id: i${id}\nname: I${id}\ndescription: d\ncomponent: ${id}\nmethods: []`);
      proj.writeSpec('implementations', `${id}_impl`, `id: ${id}_impl\nname: ${id}\ndescription: d\ncontract: i${id}\nsourcePath: src/${id}.ts\nmethods: []`);
    }
    proj.writeFile('.wai/agents/journal.md', 'Project guidance for the journal.');
    proj.activate();
    try {
      const journal = composeAgentBrief('journal').instructions;
      expect(journal).toContain('Brief for every component.');
      expect(journal).toContain('Brief only under the ledger profile.');
      expect(journal).not.toContain('Guide only.');
      expect(journal).not.toContain('Server only, as every block was before channels.');
      expect(journal.indexOf('## From pack "channelpack"')).toBeLessThan(journal.indexOf('## Project guidance'));

      const notes = composeAgentBrief('notes').instructions;
      expect(notes).toContain('Brief for every component.');
      expect(notes).not.toContain('Brief only under the ledger profile.');
    } finally { proj.cleanup(); }
  });
});
