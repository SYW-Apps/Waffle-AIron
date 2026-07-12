import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  listSkillResources,
  readSkillResource,
  listResources,
  readResource,
  SkillResourceNotFoundError,
} from '../../src/core/skills.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { createScopedServer } from '../../src/server/adapters.js';

// ---------------------------------------------------------------------------
// Phase 5c — SDD skills published as read-only MCP resources.
//
// Two seams are covered:
//   1. The pure core surface (specialist + orchestrator/portal folded into
//      src/core/skills.ts): descriptor enumeration, content round-trip, and
//      unknown-id rejection.
//   2. The MCP protocol surface: the REAL factory (createMcpServer) — and the
//      hosted scoped factory (createScopedServer, which reuses it) — driven
//      through an in-memory transport, exactly as a connected agent would.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TEMPLATES_DIR = path.join(REPO_ROOT, 'src', 'templates', 'skills');

// Alphabetical order — the stable publication order the specialist enumerates.
const SKILL_IDS = ['sdd-architect', 'sdd-auditor', 'sdd-implement', 'sdd-narrative'];

async function connectInMemory(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'skill-resources-test', version: '0.0.1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('skills_resource_specialist (core descriptors + content)', () => {
  it('enumerates exactly the four built-in SDD skills with stable uris', () => {
    const descriptors = listSkillResources();
    expect(descriptors.map((d) => d.id)).toEqual(SKILL_IDS);

    for (const d of descriptors) {
      expect(d.resourceUri).toBe(`wairon-skill://${d.id}`);
      expect(d.name.length).toBeGreaterThan(0);
      expect(d.description.length).toBeGreaterThan(0);
      expect(typeof d.version).toBe('string');
      expect((d.version ?? '').length).toBeGreaterThan(0);
      expect(d.defaultForHostedMcp).toBe(true);
    }
  });

  it('round-trips each skill to non-empty markdown matching the packaged template', () => {
    for (const id of SKILL_IDS) {
      const content = readSkillResource(id);
      const packaged = fs.readFileSync(path.join(TEMPLATES_DIR, `${id}.md`), 'utf-8');
      expect(content.length).toBeGreaterThan(0);
      expect(content).toBe(packaged);
      expect(content).toContain(`# Skill: ${id}`);
    }
  });

  it('sources each descriptor description from the packaged template frontmatter', () => {
    for (const d of listSkillResources()) {
      expect(readSkillResource(d.id)).toContain(d.description);
    }
  });
});

describe('skills_resource_orchestrator / skills_portal (validation)', () => {
  it('lists resources by forwarding the specialist descriptors', () => {
    expect(listResources()).toEqual(listSkillResources());
  });

  it('reads a known skill by id', () => {
    expect(readResource('sdd-narrative')).toBe(readSkillResource('sdd-narrative'));
  });

  it('throws SkillResourceNotFoundError for an unknown id before reading', () => {
    expect(() => readResource('does-not-exist')).toThrow(SkillResourceNotFoundError);
    expect(() => readResource('does-not-exist')).toThrow(/does-not-exist/);
  });
});

describe('MCP resources surface (real createMcpServer factory)', () => {
  it('advertises the four SDD skills over resources/list', async () => {
    const client = await connectInMemory(createMcpServer());
    try {
      const { resources } = await client.listResources();
      expect(resources.map((r) => r.uri).sort()).toEqual(
        SKILL_IDS.map((id) => `wairon-skill://${id}`),
      );
      for (const r of resources) {
        expect(r.mimeType).toBe('text/markdown');
        expect(r.name).toBeTruthy();
        expect(r.description).toBeTruthy();
      }
    } finally {
      await client.close();
    }
  });

  it('reads a skill resource by uri, returning its markdown content', async () => {
    const client = await connectInMemory(createMcpServer());
    try {
      const result = await client.readResource({ uri: 'wairon-skill://sdd-architect' });
      expect(result.contents).toHaveLength(1);
      const [content] = result.contents;
      expect(content.uri).toBe('wairon-skill://sdd-architect');
      expect(content.mimeType).toBe('text/markdown');
      expect(content.text).toBe(readSkillResource('sdd-architect'));
    } finally {
      await client.close();
    }
  });

  it('surfaces a not-found error for an unknown resource uri', async () => {
    const client = await connectInMemory(createMcpServer());
    try {
      await expect(client.readResource({ uri: 'wairon-skill://bogus' })).rejects.toThrow(/bogus/);
    } finally {
      await client.close();
    }
  });
});

describe('hosted scoped server shares the same resource registration', () => {
  it('publishes the identical SDD skill resources through createScopedServer', async () => {
    const client = await connectInMemory(createScopedServer());
    try {
      const { resources } = await client.listResources();
      expect(resources.map((r) => r.uri).sort()).toEqual(
        SKILL_IDS.map((id) => `wairon-skill://${id}`),
      );
    } finally {
      await client.close();
    }
  });
});
