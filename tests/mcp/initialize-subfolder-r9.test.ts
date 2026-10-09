/**
 * Round-9 platform top-3: an MCP session opened in an EMPTY subfolder of a
 * project binds upward to it, and sdd_initialize_system there re-authored the
 * PARENT's L0 — name, vision, boundaries, requirements and targetLanguage —
 * while `wairon init -y` in the same folder refuses with the next step. The
 * tool now refuses the same way. This drives a real stdio server launched in
 * that subfolder (no WAIRON_PROJECT_DIR), exactly as a session opened there.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache, loadSystemSpec, saveSpec } from '../../src/core/specs.js';
import { provisionProject } from '../../src/core/provision.js';

const REPO = path.resolve(__dirname, '..', '..');
const TSX = path.join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CLI = path.join(REPO, 'src', 'cli', 'index.ts');

const roots: string[] = [];
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) { try { await c.close(); } catch { /* gone */ } }
  setProjectRoot(null);
  invalidateSpecCache();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

/** A git repository holding the project "shop-platform" (an L0 and one subsystem) and an empty subfolder. */
function platform(): { root: string; sub: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-r9-init-')));
  roots.push(root);
  fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
  setProjectRoot(root);
  invalidateSpecCache();
  provisionProject('shop-platform');
  const now = '2026-10-09T00:00:00.000Z';
  saveSpec('subsystem', { id: 'orders', name: 'orders', description: 'orders', parentSystem: 'shop-platform', publicInterfaces: [], trustedLinks: [], status: 'complete', createdAt: now, updatedAt: now } as never);
  setProjectRoot(null);
  invalidateSpecCache();
  const sub = path.join(root, 'services', 'recommendations');
  fs.mkdirSync(sub, { recursive: true });
  const git = (...args: string[]): void => { execFileSync('git', args, { cwd: root, stdio: 'ignore' }); };
  git('init', '-q');
  return { root, sub };
}

/** A stdio server launched in `cwd`, bound by the binding rule alone. */
async function serveIn(cwd: string): Promise<Client> {
  const env = { ...getDefaultEnvironment() } as Record<string, string>;
  delete env.WAIRON_PROJECT_DIR;
  const client = new Client({ name: 'initialize-subfolder-r9', version: '0.0.1' });
  clients.push(client);
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [TSX, CLI, 'mcp', 'serve'], cwd, env, stderr: 'ignore' }));
  return client;
}

const L0 = { name: 'recommendations', vision: 'Product recommendations.', targetLanguage: 'python' };

describe('item 5 (platform top-3): sdd_initialize_system from a subfolder never re-authors the parent\'s L0', () => {
  it('a session opened in an empty subfolder is refused with the root and the member add step; the parent L0 is untouched', async () => {
    const { root, sub } = platform();
    const before = fs.readFileSync(path.join(root, '.wai', 'specs', '.index.yaml'), 'utf8');
    const client = await serveIn(sub);
    const r = (await client.callTool({ name: 'sdd_initialize_system', arguments: L0 }, undefined, { timeout: 120_000 })) as { isError?: boolean; content: { text: string }[] };
    const text = r.content.map((c) => c.text).join('\n');
    expect(r.isError, text).toBe(true);
    expect(text).toContain(root);
    expect(text).toMatch(/wairon member add recommendations services\/recommendations --project/);
    expect(fs.readFileSync(path.join(root, '.wai', 'specs', '.index.yaml'), 'utf8')).toBe(before);
    setProjectRoot(root);
    invalidateSpecCache();
    expect(loadSystemSpec()?.name).toBe('shop-platform');
  }, 180_000);

  it('a session opened at the root still re-authors its own L0', async () => {
    const { root } = platform();
    const client = await serveIn(root);
    const r = (await client.callTool({ name: 'sdd_initialize_system', arguments: { name: 'shop-platform', vision: 'A better shop.' } }, undefined, { timeout: 120_000 })) as { isError?: boolean; content: { text: string }[] };
    expect(r.isError, r.content.map((c) => c.text).join('\n')).toBeFalsy();
    setProjectRoot(root);
    invalidateSpecCache();
    expect(loadSystemSpec()?.vision).toBe('A better shop.');
  }, 180_000);
});
