import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  ResourceListChangedNotificationSchema,
  PromptListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { createScopedServer } from '../../src/server/adapters.js';
import { invalidateSpecCache } from '../../src/core/specs.js';

// ---------------------------------------------------------------------------
// Dynamic agent briefs over MCP:
//   - sdd_get_agent_brief tool (live brief for one resolved agent)
//   - unified resources/list: wairon-skill:// entries PLUS one live
//     wairon-agent:// entry per agent in the CURRENT topology
//   - resources/read scheme routing (wairon-agent:// renders the brief as md)
//   - truthful capabilities: stdio declares resources/prompts listChanged and
//     ACTUALLY EMITS after successful spec writes; the stateless hosted
//     per-request server declares neither and never emits.
// ---------------------------------------------------------------------------

const SKILL_IDS = ['sdd-architect', 'sdd-auditor', 'sdd-delegate', 'sdd-implement', 'sdd-narrative'];

function createTempProject() {
  invalidateSpecCache();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-briefmcp-'));

  const waiDir = path.join(tempDir, '.wai');
  fs.mkdirSync(waiDir);
  fs.writeFileSync(path.join(waiDir, 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0',
    name: 'brief-mcp-project',
    projectType: 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {},
    createdAt: '2026-08-08T10:00:00Z',
    updatedAt: '2026-08-08T10:00:00Z',
  }));

  const specsDir = path.join(waiDir, 'specs');
  for (const d of ['subsystems', 'components', 'interfaces', 'implementations', 'types']) {
    fs.mkdirSync(path.join(specsDir, d), { recursive: true });
  }

  const stamp = "createdAt: '2026-08-08T10:00:00Z'\nupdatedAt: '2026-08-08T10:00:00Z'";
  const writeSpec = (type: string, name: string, content: string) => {
    const filePath = type === 'system'
      ? path.join(specsDir, '.index.yaml')
      : path.join(specsDir, `${type}s`, `${name}.yaml`);
    fs.writeFileSync(filePath, `${content}\n${stamp}\n`);
  };

  writeSpec('system', 'system', 'schemaVersion: 1.0.0\nname: BriefSystem\nvision: testing briefs');
  writeSpec('subsystem', 'alpha', 'schemaVersion: 1.0.0\nid: alpha\nname: Alpha\ndescription: Alpha bounded context\nparentSystem: BriefSystem');

  return {
    writeSpec,
    activate: () => { vi.spyOn(process, 'cwd').mockReturnValue(tempDir); },
    cleanup: () => {
      invalidateSpecCache();
      vi.restoreAllMocks();
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* win file locks */ }
    },
  };
}

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'agent-briefs-test', version: '0.0.1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/** Poll until cond() holds or the timeout elapses (notifications are async). */
async function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<boolean> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 10));
  }
  return true;
}

// Isolate the global template/variant tiers so a developer's ~/.wairon
// overrides cannot leak into the rendered-instructions assertions.
let isolatedGlobalDir: string;
let proj: ReturnType<typeof createTempProject>;
const clients: Client[] = [];

beforeEach(() => {
  isolatedGlobalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-briefmcp-global-'));
  process.env.WAIRON_TEMPLATES_DIR = isolatedGlobalDir;
  process.env.WAIRON_VARIANTS_DIR = isolatedGlobalDir;
  proj = createTempProject();
  proj.activate();
});

afterEach(async () => {
  for (const c of clients.splice(0)) {
    try { await c.close(); } catch { /* already gone */ }
  }
  proj.cleanup();
  delete process.env.WAIRON_TEMPLATES_DIR;
  delete process.env.WAIRON_VARIANTS_DIR;
  try { fs.rmSync(isolatedGlobalDir, { recursive: true, force: true }); } catch { /* win */ }
});

async function connectTracked(server: McpServer): Promise<Client> {
  const client = await connect(server);
  clients.push(client);
  return client;
}

function unwrap(result: { content?: unknown; isError?: boolean }): string {
  return (result.content as { type: string; text: string }[])[0].text;
}

describe('sdd_get_agent_brief tool', () => {
  it('returns the full live brief for a resolved agent', async () => {
    const client = await connectTracked(createMcpServer());
    const result = await client.callTool({ name: 'sdd_get_agent_brief', arguments: { agentId: 'alpha-owner' } });
    expect(result.isError).toBeFalsy();

    const brief = JSON.parse(unwrap(result));
    expect(brief.agentId).toBe('alpha-owner');
    expect(brief.name).toBe('Alpha Owner');
    expect(brief.template).toBe('domain-owner');
    expect(brief.domainRoot).toBe('alpha');
    expect(brief.ownedPaths).toContain('.wai/specs/subsystems/alpha.yaml');
    // Instructions are RENDERED — placeholders substituted, scope folded in.
    expect(brief.instructions).toContain('**Alpha Owner**');
    expect(brief.instructions).toContain('.wai/specs/subsystems/alpha.yaml');
    expect(brief.instructions).not.toContain('{{ownedPaths}}');
  });

  it('an unknown agent id surfaces a tool error naming the known ids', async () => {
    const client = await connectTracked(createMcpServer());
    const result = await client.callTool({ name: 'sdd_get_agent_brief', arguments: { agentId: 'nope' } });
    expect(result.isError).toBe(true);
    expect(unwrap(result)).toMatch(/Known agent ids: system-architect, alpha-owner/);
  });
});

describe('unified resources/list (skills + live agent briefs)', () => {
  for (const [label, factory] of [
    ['stdio server', () => createMcpServer()],
    ['hosted scoped server', () => createScopedServer()],
  ] as const) {
    it(`lists the five skills AND one wairon-agent:// entry per topology agent on the ${label}`, async () => {
      const client = await connectTracked(factory());
      const { resources } = await client.listResources();

      const skillUris = resources.filter((r) => r.uri.startsWith('wairon-skill://')).map((r) => r.uri).sort();
      expect(skillUris).toEqual(SKILL_IDS.map((id) => `wairon-skill://${id}`));

      const agentUris = resources.filter((r) => r.uri.startsWith('wairon-agent://')).map((r) => r.uri).sort();
      expect(agentUris).toEqual(['wairon-agent://alpha-owner', 'wairon-agent://system-architect']);

      const alpha = resources.find((r) => r.uri === 'wairon-agent://alpha-owner');
      expect(alpha?.name).toBe('Alpha Owner');
      expect(alpha?.description).toBeTruthy();
      expect(alpha?.mimeType).toBe('text/markdown');
    });
  }

  it('is recomputed per list call — a spec change is visible on the next list, no restart', async () => {
    const client = await connectTracked(createMcpServer());
    proj.writeSpec('subsystem', 'beta', 'schemaVersion: 1.0.0\nid: beta\nname: Beta\ndescription: Beta bounded context\nparentSystem: BriefSystem');
    invalidateSpecCache();

    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain('wairon-agent://beta-owner');
  });
});

describe('resources/read of a wairon-agent:// uri', () => {
  it('renders the live brief as markdown: header fields + rendered instructions', async () => {
    const client = await connectTracked(createMcpServer());
    const result = await client.readResource({ uri: 'wairon-agent://alpha-owner' });
    expect(result.contents).toHaveLength(1);
    const [content] = result.contents;
    expect(content.uri).toBe('wairon-agent://alpha-owner');
    expect(content.mimeType).toBe('text/markdown');

    const md = content.text as string;
    expect(md).toContain('# Agent brief: alpha-owner');
    expect(md).toContain('- **Template**: domain-owner');
    expect(md).toContain('- **Domain root**: alpha');
    expect(md).toContain('- **Owned paths**: ');
    expect(md).toContain('.wai/specs/subsystems/alpha.yaml');
    expect(md).toContain('## Instructions');
    // The rendered instruction body, not the raw template.
    expect(md).toContain('**Alpha Owner**');
    expect(md).not.toContain('{{ownedPaths}}');
  });

  it('rejects an unknown agent uri with the known-ids message', async () => {
    const client = await connectTracked(createMcpServer());
    await expect(client.readResource({ uri: 'wairon-agent://ghost' })).rejects.toThrow(/Known agent ids/);
  });

  it('leaves the wairon-skill:// read surface untouched', async () => {
    const client = await connectTracked(createMcpServer());
    const result = await client.readResource({ uri: 'wairon-skill://sdd-delegate' });
    expect(result.contents[0].mimeType).toBe('text/markdown');
    expect(result.contents[0].text).toContain('# Skill: sdd-delegate');
  });
});

describe('truthful capabilities', () => {
  it('the stdio server declares resources.listChanged and prompts.listChanged', async () => {
    const client = await connectTracked(createMcpServer());
    const caps = client.getServerCapabilities();
    expect(caps?.resources?.listChanged).toBe(true);
    expect(caps?.prompts?.listChanged).toBe(true);
  });

  it('the stateless hosted scoped server declares NO listChanged (correct-on-poll)', async () => {
    const client = await connectTracked(createScopedServer());
    const caps = client.getServerCapabilities();
    expect(caps?.resources).toBeDefined();
    expect(caps?.prompts).toBeDefined();
    expect(caps?.resources?.listChanged).toBeUndefined();
    expect(caps?.prompts?.listChanged).toBeUndefined();
  });
});

describe('list-changed notifications after spec writes', () => {
  function countNotifications(client: Client): { resources: () => number; prompts: () => number } {
    let resourceCount = 0;
    let promptCount = 0;
    client.setNotificationHandler(ResourceListChangedNotificationSchema, () => { resourceCount += 1; });
    client.setNotificationHandler(PromptListChangedNotificationSchema, () => { promptCount += 1; });
    return { resources: () => resourceCount, prompts: () => promptCount };
  }

  it('a successful write over the connected stdio pair emits resources + prompts list_changed', async () => {
    const client = await connectTracked(createMcpServer());
    const counts = countNotifications(client);

    const result = await client.callTool({
      name: 'sdd_add_component',
      arguments: {
        id: 'alpha-specialist', name: 'Alpha Specialist', description: 'd',
        subsystem: 'alpha', componentType: 'Specialist',
      },
    });
    expect(result.isError).toBeFalsy();

    expect(await waitFor(() => counts.resources() >= 1 && counts.prompts() >= 1)).toBe(true);
  });

  it('a FAILED write emits nothing', async () => {
    const client = await connectTracked(createMcpServer());
    const counts = countNotifications(client);

    const result = await client.callTool({
      name: 'sdd_add_component',
      arguments: { id: 'x', name: 'X', description: 'd', subsystem: 'no-such-subsystem', componentType: 'Specialist' },
    });
    expect(result.isError).toBe(true);

    await new Promise((r) => setTimeout(r, 50));
    expect(counts.resources()).toBe(0);
    expect(counts.prompts()).toBe(0);
  });

  it('a data-plane READ (sdd_get_agent_brief) emits nothing', async () => {
    const client = await connectTracked(createMcpServer());
    const counts = countNotifications(client);

    const result = await client.callTool({ name: 'sdd_get_agent_brief', arguments: { agentId: 'alpha-owner' } });
    expect(result.isError).toBeFalsy();

    await new Promise((r) => setTimeout(r, 50));
    expect(counts.resources()).toBe(0);
    expect(counts.prompts()).toBe(0);
  });

  it('the hosted scoped server never emits, even after a successful write', async () => {
    const client = await connectTracked(createScopedServer());
    const counts = countNotifications(client);

    const result = await client.callTool({
      name: 'sdd_add_component',
      arguments: {
        id: 'alpha-hosted', name: 'Alpha Hosted', description: 'd',
        subsystem: 'alpha', componentType: 'Specialist',
      },
    });
    expect(result.isError).toBeFalsy();

    await new Promise((r) => setTimeout(r, 50));
    expect(counts.resources()).toBe(0);
    expect(counts.prompts()).toBe(0);
  });
});
