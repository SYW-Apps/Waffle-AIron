import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { createScopedServer } from '../../src/server/adapters.js';
import { resolveVariantGuidance, composeVariantGuidance, type VariantDef } from '../../src/core/variants.js';
import { invalidateSpecCache } from '../../src/core/specs.js';

// ---------------------------------------------------------------------------
// FR 7.4 — skills as MCP PROMPTS, and FR 7.5 — variant guidance over MCP.
//
// Resources are pull-only: a client must already know to fetch wairon-skill://…
// Prompts are what makes a skill discoverable to a human driving an agent.
//
// Variant guidance attaches to the component an implementer is holding, but it
// only ever reached GENERATED agent files — so a hosted agent never saw it.
// ---------------------------------------------------------------------------

const created: string[] = [];

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'prompts-test', version: '0.0.1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

afterEach(() => {
  delete process.env.WAIRON_VARIANTS_DIR;
  invalidateSpecCache();
  vi.restoreAllMocks();
  for (const dir of created.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* win file locks */ }
  }
});

describe('skills published as MCP prompts (7.4)', () => {
  it('advertises a prompt per published skill, mirroring the resource set', async () => {
    const client = await connect(createMcpServer());
    const { prompts } = await client.listPrompts();
    const { resources } = await client.listResources();

    // One skill set, two ways in — the two surfaces cannot drift because they are
    // built from the same descriptor list. (resources/list additionally carries
    // live wairon-agent:// brief entries, which have no prompt mirror.)
    const skillResources = resources.filter((r) => r.uri.startsWith('wairon-skill://'));
    expect(prompts.length).toBe(skillResources.length);
    expect(prompts.map((p) => p.name).sort()).toEqual(
      skillResources.map((r) => r.uri.replace('wairon-skill://', '')).sort(),
    );
    for (const id of ['sdd-architect', 'sdd-auditor', 'sdd-delegate', 'sdd-implement', 'sdd-narrative']) {
      expect(prompts.map((p) => p.name)).toContain(id);
    }
  });

  it('carries each skill description, so a client can present it as a command', async () => {
    const client = await connect(createMcpServer());
    const architect = (await client.listPrompts()).prompts.find((p) => p.name === 'sdd-architect');
    expect(architect?.description).toBeTruthy();
    expect(architect?.description).toMatch(/architecture/i);
  });

  it('returns the skill markdown when a prompt is fetched', async () => {
    const client = await connect(createMcpServer());
    const result = await client.getPrompt({ name: 'sdd-architect' });
    expect(result.messages).toHaveLength(1);
    const content = result.messages[0].content as { type: string; text: string };
    expect(content.type).toBe('text');
    expect(content.text).toContain('Skill: sdd-architect');
  });

  it('rejects an unknown prompt name rather than returning something empty', async () => {
    const client = await connect(createMcpServer());
    await expect(client.getPrompt({ name: 'no-such-skill' })).rejects.toThrow();
  });

  it('the hosted scoped server publishes prompts too', async () => {
    const client = await connect(createScopedServer());
    expect((await client.listPrompts()).prompts.length).toBeGreaterThan(0);
  });
});

describe('variant guidance resolution (7.5)', () => {
  const variants = new Map<string, VariantDef>([
    ['publisher', { id: 'publisher', base: 'Specialist', guidance: 'Reuse the shared publisher helper.' }],
  ]);

  it('resolves the variant with its same-variant siblings', () => {
    const all = [
      { id: 'a_pub', variant: 'publisher' },
      { id: 'b_pub', variant: 'publisher' },
      { id: 'c_other', variant: 'other' },
    ];
    const resolved = resolveVariantGuidance(all[0], all, variants);

    expect(resolved).not.toBeNull();
    expect(resolved!.base).toBe('Specialist');
    expect(resolved!.guidance).toContain('shared publisher helper');
    // The siblings travel WITH the guidance — that is the whole payoff of a
    // variant: every component of the kind gets implemented alike.
    expect(resolved!.siblings).toEqual(['b_pub']);
  });

  it('is null for a component with no variant, or an unresolvable one', () => {
    expect(resolveVariantGuidance({ id: 'x' }, [], variants)).toBeNull();
    expect(resolveVariantGuidance({ id: 'x', variant: 'ghost' }, [], variants)).toBeNull();
  });

  it('composes the same guidance the generated agents carry', () => {
    const all = [{ id: 'a_pub', variant: 'publisher' }, { id: 'b_pub', variant: 'publisher' }];
    const block = composeVariantGuidance([all[0]], all, variants);
    expect(block).toContain('## Component variants');
    expect(block).toContain('a_pub');
    expect(block).toContain('shared publisher helper');
    expect(block).toContain('b_pub');
    // Empty when nothing is tagged, so an agent with no variants carries no block.
    expect(composeVariantGuidance([{ id: 'plain' }], [], variants)).toBe('');
  });
});

describe('variant guidance reaches a hosted agent via sdd_get_spec (7.5)', () => {
  /** A project with two same-variant components and a variant registry. */
  function projectWithVariant(): string {
    invalidateSpecCache();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-variantmcp-'));
    created.push(dir);
    const specs = path.join(dir, '.wai', 'specs');
    for (const d of ['subsystems', 'components', 'interfaces', 'implementations', 'types']) {
      fs.mkdirSync(path.join(specs, d), { recursive: true });
    }
    const stamp = "createdAt: '2026-07-03T10:00:00Z'\nupdatedAt: '2026-07-03T10:00:00Z'";
    fs.writeFileSync(path.join(dir, '.wai', 'project.yaml'), JSON.stringify({
      schemaVersion: '1.0.0', name: 'p', projectType: 'backend',
      targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }], rules: {},
      extensions: { useGlobalPacks: false, packs: [] },
      createdAt: '2026-07-03T10:00:00Z', updatedAt: '2026-07-03T10:00:00Z',
    }));
    fs.writeFileSync(path.join(specs, '.index.yaml'), `schemaVersion: 1.0.0\nname: S\nvision: v\n${stamp}\n`);
    fs.writeFileSync(path.join(specs, 'subsystems', 'sub.yaml'),
      `schemaVersion: 1.0.0\nid: sub\nname: Sub\ndescription: d\nparentSystem: S\n${stamp}\n`);
    for (const id of ['a_pub', 'b_pub']) {
      fs.writeFileSync(path.join(specs, 'components', `${id}.yaml`),
        `schemaVersion: 1.0.0\nid: ${id}\nname: ${id}\ndescription: d\nsubsystem: sub\ncomponentType: Specialist\nvariant: publisher\n${stamp}\n`);
    }
    const variantsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-vardir-'));
    created.push(variantsDir);
    fs.writeFileSync(path.join(variantsDir, 'publisher.yaml'),
      'id: publisher\nbase: Specialist\nguidance: Reuse the shared publisher helper; do not reimplement dispatch.\n');
    process.env.WAIRON_VARIANTS_DIR = variantsDir;
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    return dir;
  }

  it('attaches resolved guidance and siblings to a variant-tagged component', async () => {
    projectWithVariant();
    const client = await connect(createMcpServer());
    const result = await client.callTool({ name: 'sdd_get_spec', arguments: { kind: 'component', id: 'a_pub' } });
    const text = (result.content as { type: string; text: string }[])[0].text;
    const spec = JSON.parse(text);

    expect(spec.id).toBe('a_pub');
    expect(spec.variantGuidance.variant).toBe('publisher');
    expect(spec.variantGuidance.base).toBe('Specialist');
    expect(spec.variantGuidance.guidance).toContain('shared publisher helper');
    expect(spec.variantGuidance.siblings).toEqual(['b_pub']);
  });

  it('adds nothing for a component that declares no variant', async () => {
    const dir = projectWithVariant();
    fs.writeFileSync(path.join(dir, '.wai', 'specs', 'components', 'plain.yaml'),
      "schemaVersion: 1.0.0\nid: plain\nname: plain\ndescription: d\nsubsystem: sub\ncomponentType: Specialist\ncreatedAt: '2026-07-03T10:00:00Z'\nupdatedAt: '2026-07-03T10:00:00Z'\n");
    invalidateSpecCache();

    const client = await connect(createMcpServer());
    const result = await client.callTool({ name: 'sdd_get_spec', arguments: { kind: 'component', id: 'plain' } });
    const spec = JSON.parse((result.content as { type: string; text: string }[])[0].text);
    expect(spec.variantGuidance).toBeUndefined();
  });
});
