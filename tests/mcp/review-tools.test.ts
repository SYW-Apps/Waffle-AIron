import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { setProjectRoot } from '../../src/utils/fs.js';
import { saveSystemSpec, saveSpec, saveComponentSpec, invalidateSpecCache } from '../../src/core/specs.js';
import { createMcpServer, awaitReview } from '../../src/mcp/server.js';
import * as portal from '../../src/core/index.js';
import { WAIRON_MAJOR } from '../../src/config/defaults.js';
import type { SubsystemSpec, ComponentSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// sdd_request_review / sdd_await_review: the agent asks, the human decides.
// Driven through the real server factory over an in-memory transport.
// ---------------------------------------------------------------------------

const now = '2026-09-11T10:00:00Z';

function project(brokenDependency = false): string {
  invalidateSpecCache();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-review-tools-'));
  fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(root, '.wai', 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0', waironMajor: WAIRON_MAJOR, name: 'rt-sys', projectType: 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {}, createdAt: now, updatedAt: now,
  }));
  setProjectRoot(root);
  saveSystemSpec({
    schemaVersion: '1.0.0', name: 'rt-sys', vision: 'a review tools fixture',
    boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now,
  });
  saveSpec('subsystem', {
    id: 'dom', name: 'dom', description: 'the domain', parentSystem: 'rt-sys',
    publicInterfaces: [], trustedLinks: [], status: 'draft', createdAt: now, updatedAt: now,
  } as SubsystemSpec);
  saveComponentSpec({
    id: 'worker', name: 'Worker', description: 'a worker component', subsystem: 'dom',
    componentType: 'Orchestrator', dependsOn: brokenDependency ? ['no_such_component'] : [], owns: [],
    status: 'draft', createdAt: now, updatedAt: now,
  } as ComponentSpec);
  invalidateSpecCache();
  return root;
}

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'review-test', version: '0.0.1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function textOf(result: unknown): string {
  return ((result as { content: { text: string }[] }).content[0]).text;
}

describe('review tools', () => {
  let root: string;

  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    try { if (root) fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows keeps handles a moment */ }
  });

  it('advertises both tools', async () => {
    root = project();
    const client = await connect(createMcpServer());
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain('sdd_request_review');
      expect(names).toContain('sdd_await_review');
    } finally { await client.close(); }
  });

  it('refuses while the design has errors and records nothing', async () => {
    root = project(true);
    const client = await connect(createMcpServer());
    try {
      const result = await client.callTool({ name: 'sdd_request_review', arguments: { kind: 'review', note: 'x' } });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('nothing was recorded');
      expect(portal.pendingReviews()).toHaveLength(0);
    } finally { await client.close(); }
  });

  it('records a request and says no dev server runs', async () => {
    root = project();
    const client = await connect(createMcpServer());
    try {
      const result = await client.callTool({ name: 'sdd_request_review', arguments: { kind: 'review', note: 'look at worker' } });
      expect(result.isError ?? false).toBe(false);
      expect(textOf(result)).toContain('wairon dev');
      expect(textOf(result)).toContain('sdd_await_review');
      const pending = portal.pendingReviews();
      expect(pending).toHaveLength(1);
      expect(pending[0].note).toBe('look at worker');
    } finally { await client.close(); }
  });

  it('names the dev page when a dev server announces itself', async () => {
    root = project();
    portal.announceDevServer('http://127.0.0.1:4200', process.pid);
    const client = await connect(createMcpServer());
    try {
      const result = await client.callTool({ name: 'sdd_request_review', arguments: { kind: 'lock', note: 'approve' } });
      expect(textOf(result)).toContain('http://127.0.0.1:4200');
    } finally { await client.close(); }
  });

  it('refuses a subsystem on a review request', async () => {
    root = project();
    const client = await connect(createMcpServer());
    try {
      const result = await client.callTool({ name: 'sdd_request_review', arguments: { kind: 'review', note: 'x', subsystem: 'dom' } });
      expect(result.isError).toBe(true);
    } finally { await client.close(); }
  });

  it('awaits: answers the decision with its comment and notes', async () => {
    root = project();
    const { request } = portal.requestReview('review', 'look');
    setTimeout(() => {
      portal.decideReview(request.id, 'changes_requested', 'too wide', [{ specId: 'worker', note: 'split it' }]);
    }, 100);
    const answer = await awaitReview(request.id, 10, {}, { pollMs: 30, progressMs: 1000 });
    expect(answer.isError ?? false).toBe(false);
    const text = textOf(answer);
    expect(text).toContain('changes_requested');
    expect(text).toContain('Comment: too wide');
    expect(text).toContain('Note on worker: split it');
  });

  it('awaits: answers pending when the timeout passes, sending progress on the token', async () => {
    root = project();
    const { request } = portal.requestReview('review', 'look');
    const sent: unknown[] = [];
    const answer = await awaitReview(
      request.id,
      1,
      { _meta: { progressToken: 'tok' }, sendNotification: async (n) => { sent.push(n); } },
      { pollMs: 50, progressMs: 100 },
    );
    expect(textOf(answer)).toContain('still pending');
    expect(sent.length).toBeGreaterThan(0);
    expect((sent[0] as { method: string }).method).toBe('notifications/progress');
    expect((sent[0] as { params: { progressToken: string } }).params.progressToken).toBe('tok');
  });

  it('awaits: an unknown id is an error', async () => {
    root = project();
    const answer = await awaitReview('missing', 1, {}, { pollMs: 10, progressMs: 100 });
    expect(answer.isError).toBe(true);
  });
});
