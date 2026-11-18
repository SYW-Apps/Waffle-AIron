import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { loadProjectExtensions } from '../../src/core/extensions.js';
import { buildServerInstructions } from '../../src/core/instructions.js';
import { composeAgentBrief } from '../../src/core/agent_resolver.js';
import { guideBody } from '../../src/utils/ai-guide.js';
import { resolvePractices } from '../../src/models/practices.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { WAIRON_MAJOR } from '../../src/config/defaults.js';

// ---------------------------------------------------------------------------
// Practices: declared by packs, selected per scope in project.yaml, picked per
// session with sdd_use_practices, and delivered through the guide, the
// briefs and the server instructions.
// ---------------------------------------------------------------------------

const PACK = `name: craft
practices:
  - id: test-first
    description: Write the failing test before the code.
    guidance: Write a failing test for each method before implementing it.
  - id: lean-scope
    description: Build only what has a caller.
    guidance: Build nothing without a caller.
  - id: security-review
    description: Review for security before approval.
    guidance: Check every input boundary for validation and authorization.
`;

function createTempProject(practices?: Record<string, unknown>, packs: string[] = ['.wai/packs/craft.yaml']) {
  invalidateSpecCache();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-practices-test-'));
  const waiDir = path.join(tempDir, '.wai');
  fs.mkdirSync(waiDir);
  fs.writeFileSync(path.join(waiDir, 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0',
    name: 'test-project',
    waironMajor: WAIRON_MAJOR,
    projectType: 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {},
    extensions: { useGlobalPacks: false, packs },
    ...(practices ? { practices } : {}),
    createdAt: '2026-11-06T10:00:00Z',
    updatedAt: '2026-11-06T10:00:00Z',
  }));
  const specsDir = path.join(waiDir, 'specs');
  for (const d of ['subsystems', 'components', 'interfaces', 'implementations', 'types']) {
    fs.mkdirSync(path.join(specsDir, d), { recursive: true });
  }
  const stamp = "createdAt: '2026-11-06T10:00:00Z'\nupdatedAt: '2026-11-06T10:00:00Z'";
  const writeSpec = (folder: string, name: string, content: string) => {
    fs.writeFileSync(path.join(specsDir, folder, `${name}.yaml`), `${content}\n${stamp}\n`);
  };
  fs.writeFileSync(path.join(specsDir, '.index.yaml'), `schemaVersion: 1.0.0\nname: TestSystem\nvision: testing\n${stamp}\n`);
  writeSpec('subsystems', 'payments', 'schemaVersion: 1.0.0\nid: payments\nname: payments\ndescription: d\nparentSystem: TestSystem');
  for (const id of ['ledger', 'checkout']) {
    writeSpec('components', id, `id: ${id}\nname: ${id}\ndescription: d\nsubsystem: payments\ncomponentType: Orchestrator`);
    writeSpec('interfaces', `i${id}`, `id: i${id}\nname: I${id}\ndescription: d\ncomponent: ${id}\nmethods: []`);
    writeSpec('implementations', `${id}_impl`, `id: ${id}_impl\nname: ${id}\ndescription: d\ncontract: i${id}\nsourcePath: src/${id}.ts\nmethods: []`);
  }
  const writeFile = (rel: string, content: string) => {
    const p = path.join(tempDir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  writeFile('.wai/packs/craft.yaml', PACK);
  return {
    writeFile,
    activate: () => { vi.spyOn(process, 'cwd').mockReturnValue(tempDir); },
    cleanup: () => {
      invalidateSpecCache();
      vi.restoreAllMocks();
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* win file locks */ }
    },
  };
}

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'practices-test', version: '0.0.1' });
  await Promise.all([createMcpServer().connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function textOf(result: unknown): string {
  return ((result as { content: { type: string; text: string }[] }).content ?? []).map((c) => c.text).join('\n');
}

describe('resolvePractices', () => {
  it('applies project, subsystem, component, role and session in order; an id adds once and `!id` drops', () => {
    const selection = {
      use: ['lean-scope', 'test-first'],
      subsystems: { payments: ['security-review'] },
      components: { ledger: ['!lean-scope'] },
      roles: { reviewer: ['!test-first'] },
    };
    expect(resolvePractices(selection)).toEqual(['lean-scope', 'test-first']);
    expect(resolvePractices(selection, { subsystem: 'payments', component: 'ledger' })).toEqual(['test-first', 'security-review']);
    expect(resolvePractices(selection, { subsystem: 'payments', component: 'ledger', role: 'reviewer' })).toEqual(['security-review']);
    expect(resolvePractices(selection, { session: ['lean-scope', 'test-first'] })).toEqual(['lean-scope', 'test-first']);
    expect(resolvePractices(undefined, { session: ['!lean-scope', 'test-first'] })).toEqual(['test-first']);
  });
});

describe('practices loading', () => {
  it('a practice id a later pack declares again is left out and reported', () => {
    const proj = createTempProject(undefined, ['.wai/packs/craft.yaml', '.wai/packs/other.yaml']);
    proj.writeFile('.wai/packs/other.yaml', 'name: other\npractices:\n  - id: test-first\n    description: d\n    guidance: g\n');
    proj.activate();
    try {
      const ext = loadProjectExtensions();
      expect(ext.practices.filter((p) => p.id === 'test-first').map((p) => p.pack)).toEqual(['craft']);
      expect(ext.errors.some((e) => e.includes('"test-first"') && e.includes('craft'))).toBe(true);
    } finally { proj.cleanup(); }
  });
});

describe('practices delivery', () => {
  const selection = {
    use: ['lean-scope'],
    subsystems: { payments: ['security-review'] },
    components: { ledger: ['!lean-scope', 'test-first'] },
  };

  it('the local guide carries the project\'s own practices; the global guide none', () => {
    const proj = createTempProject(selection);
    proj.activate();
    try {
      const local = guideBody('local');
      expect(local).toContain('## Practice "lean-scope" (pack "craft")');
      expect(local).toContain('Build nothing without a caller.');
      expect(local).not.toContain('Practice "security-review"');
      expect(guideBody('global')).not.toContain('## Practice');
    } finally { proj.cleanup(); }
  });

  it('a brief carries the practices in force for its subsystem and component, in order, before the project guidance', () => {
    const proj = createTempProject(selection);
    proj.writeFile('.wai/agents/ledger.md', 'Ledger guidance.');
    proj.activate();
    try {
      const ledger = composeAgentBrief('ledger').instructions;
      expect(ledger).not.toContain('Practice "lean-scope"');
      expect(ledger.indexOf('Practice "security-review"')).toBeGreaterThan(-1);
      expect(ledger.indexOf('Practice "security-review"')).toBeLessThan(ledger.indexOf('Practice "test-first"'));
      expect(ledger.indexOf('Practice "test-first"')).toBeLessThan(ledger.indexOf('## Project guidance'));

      const checkout = composeAgentBrief('checkout').instructions;
      expect(checkout).toContain('Practice "lean-scope"');
      expect(checkout).toContain('Practice "security-review"');
      expect(checkout).not.toContain('Practice "test-first"');
    } finally { proj.cleanup(); }
  });

  it('a brief carries the session\'s picks after the project\'s selection', () => {
    const proj = createTempProject(selection);
    proj.activate();
    try {
      const brief = composeAgentBrief('checkout', ['!security-review', 'test-first']).instructions;
      expect(brief).toContain('Practice "lean-scope"');
      expect(brief).not.toContain('Practice "security-review"');
      expect(brief).toContain('Practice "test-first"');
    } finally { proj.cleanup(); }
  });

  it('the server instructions name the project\'s practices and the session tool only when packs declare practices', () => {
    const proj = createTempProject(selection);
    proj.activate();
    try {
      const text = buildServerInstructions();
      expect(text).toContain('## Practices');
      expect(text).toContain('`lean-scope`');
      expect(text).toContain('sdd_use_practices');
    } finally { proj.cleanup(); }
    const bare = createTempProject(undefined, []);
    bare.activate();
    try {
      expect(buildServerInstructions()).not.toContain('## Practices');
    } finally { bare.cleanup(); }
  });
});

describe('sdd_use_practices', () => {
  it('lists, adds and drops for the session; later briefs carry the picks; project.yaml is untouched', async () => {
    const proj = createTempProject({ use: ['lean-scope'] });
    proj.activate();
    try {
      const client = await connect();
      const listed = JSON.parse(textOf(await client.callTool({ name: 'sdd_use_practices', arguments: {} })));
      expect(listed.available.map((p: { id: string }) => p.id)).toEqual(['test-first', 'lean-scope', 'security-review']);
      expect(listed.project).toEqual(['lean-scope']);
      expect(listed.inForce).toEqual(['lean-scope']);
      expect(listed.remembered).toBe(true);

      const picked = JSON.parse(textOf(await client.callTool({ name: 'sdd_use_practices', arguments: { add: ['test-first'], drop: ['lean-scope'] } })));
      expect(picked.session).toEqual(['test-first', '!lean-scope']);
      expect(picked.inForce).toEqual(['test-first']);
      expect(picked.guidance).toContain('## Practice "test-first" (pack "craft")');

      const brief = textOf(await client.callTool({ name: 'sdd_get_agent_brief', arguments: { agentId: 'checkout' } }));
      expect(brief).toContain('Practice \\"test-first\\"');
      expect(brief).not.toContain('Practice \\"lean-scope\\"');
    } finally { proj.cleanup(); }
  });

  it('refuses a practice no loaded pack declares and changes nothing', async () => {
    const proj = createTempProject();
    proj.activate();
    try {
      const client = await connect();
      const refused = await client.callTool({ name: 'sdd_use_practices', arguments: { add: ['pair-programming'] } });
      expect((refused as { isError?: boolean }).isError).toBe(true);
      expect(textOf(refused)).toContain('"pair-programming"');
      const after = JSON.parse(textOf(await client.callTool({ name: 'sdd_use_practices', arguments: {} })));
      expect(after.session).toEqual([]);
    } finally { proj.cleanup(); }
  });
});
