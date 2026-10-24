import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WAIRON_MAJOR } from '../../src/config/defaults.js';

// ---------------------------------------------------------------------------
// The type group tools over a real stdio server: sdd_add_group (an upsert),
// sdd_get_spec / sdd_update_spec / sdd_delete_spec on kind group, and
// sdd_rename_spec / sdd_move_spec on kind group — the folder follows each, a
// type joining another group takes its file, and a parent that does not exist,
// lives in another home or would close a loop is refused before anything is
// written.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const WAIRON_CLI = path.join(REPO_ROOT, 'src', 'cli', 'index.ts');
const now = new Date().toISOString();

describe('MCP type group tools', () => {
  let projDir: string;
  let client: Client;

  const raw = async (name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string; structured?: any }> => {
    const result: any = await client.callTool({ name, arguments: args });
    return { isError: !!result.isError, text: result.content?.[0]?.text ?? '', structured: result.structuredContent };
  };
  const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const r = await raw(name, args);
    expect(r.isError, r.text).toBe(false);
    return r.text;
  };
  const types = (...rest: string[]): string => path.join(projDir, '.wai', 'specs', 'types', ...rest);

  beforeAll(async () => {
    projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-mcp-groups-'));
    fs.mkdirSync(path.join(projDir, '.wai', 'specs'), { recursive: true });
    fs.writeFileSync(path.join(projDir, '.wai', 'project.yaml'), [
      "schemaVersion: '1.0.0'", `waironMajor: ${WAIRON_MAJOR}`, 'name: mcp-groups',
      'targets:', '  - type: claude', '    outputDir: .claude/agents', '    enabled: true',
      `createdAt: '${now}'`, `updatedAt: '${now}'`,
    ].join('\n'));
    client = new Client({ name: 'wairon-groups-test', version: '0.0.1' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [TSX_CLI, WAIRON_CLI, 'mcp', 'serve'], cwd: projDir, stderr: 'ignore' }));
    await call('sdd_initialize_system', { name: 'Contracts', vision: 'Shared contracts', targetLanguage: 'typescript' });
  }, 60_000);

  afterAll(async () => {
    try { await client?.close(); } catch { /* already gone */ }
    try { fs.rmSync(projDir, { recursive: true, force: true }); } catch { /* windows file locks */ }
  });

  it('advertises sdd_add_group, with group on the kind of the tools that address a spec by kind', async () => {
    const listed = await client.listTools();
    const byName = Object.fromEntries(listed.tools.map((t: any) => [t.name, t.inputSchema?.properties ?? {}]));
    expect(Object.keys(byName.sdd_add_group)).toEqual(expect.arrayContaining(['id', 'name', 'description', 'parent', 'subsystem', 'dryRun']));
    for (const tool of ['sdd_get_spec', 'sdd_update_spec', 'sdd_delete_spec', 'sdd_rename_spec', 'sdd_move_spec']) {
      expect(byName[tool].kind.enum, tool).toContain('group');
    }
    expect(Object.keys(byName.sdd_move_spec)).toContain('parent');
  });

  it('defines a tree of groups, files a type in the innermost, and reads a group back', async () => {
    await call('sdd_add_group', { id: 'platform', name: 'Platform', description: 'The platform contracts' });
    const out = await raw('sdd_add_group', { id: 'runtime', name: 'Runtime', parent: 'platform' });
    expect(out.isError, out.text).toBe(false);
    expect(out.structured).toMatchObject({ kind: 'group', id: 'runtime', replacedExisting: false });
    await call('sdd_add_group', { id: 'vm', name: 'VM', parent: 'runtime' });
    await call('sdd_add_type', { kind: 'value-object', id: 'heap-snapshot', name: 'HeapSnapshot', group: 'vm', fields: [{ name: 'bytes', type: 'int' }] });
    expect(fs.existsSync(types('platform', 'runtime', 'vm', '.index.yaml'))).toBe(true);
    expect(fs.existsSync(types('platform', 'runtime', 'vm', 'heap-snapshot.yaml'))).toBe(true);
    const got = JSON.parse(await call('sdd_get_spec', { kind: 'group', id: 'vm' }));
    expect(got).toMatchObject({ kind: 'group', id: 'vm', parent: 'runtime' });
    // The kind is inferred when the id names a group alone.
    expect(JSON.parse(await call('sdd_get_spec', { id: 'platform' }))).toMatchObject({ kind: 'group', description: 'The platform contracts' });
    const tree = await call('sdd_validate_tree', {});
    expect(tree).not.toMatch(/TYPE_GROUP|GROUP_/);
  }, 60_000);

  it('re-defining a group is an upsert that reports what the omission cleared', async () => {
    const out = await call('sdd_add_group', { id: 'platform', name: 'Platform v2' });
    expect(out).toContain('re-authored');
    expect(out).toMatch(/CLEARED by omission: description/);
    expect(JSON.parse(await call('sdd_get_spec', { kind: 'group', id: 'platform' })).description).toBeUndefined();
  });

  it('refuses a parent that does not exist, one beneath the group, and a group naming itself — writing nothing', async () => {
    const unknown = await raw('sdd_add_group', { id: 'stray', name: 'Stray', parent: 'ghost' });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toMatch(/GROUP_PARENT_UNKNOWN/);
    expect(fs.existsSync(types('stray'))).toBe(false);
    const loop = await raw('sdd_add_group', { id: 'platform', name: 'Platform', parent: 'vm' });
    expect(loop.isError).toBe(true);
    expect(loop.text).toMatch(/GROUP_CYCLE/);
    const self = await raw('sdd_update_spec', { kind: 'group', id: 'vm', delta: { parent: 'vm' } });
    expect(self.isError).toBe(true);
    expect(self.text).toMatch(/GROUP_CYCLE/);
  });

  it('refuses a parent in another home', async () => {
    await call('sdd_add_subsystem', { id: 'billing', name: 'Billing', description: 'Billing' });
    const r = await raw('sdd_add_group', { id: 'invoices', name: 'Invoices', parent: 'platform', subsystem: 'billing' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/GROUP_PARENT_CROSS_HOME/);
    const unknownHome = await raw('sdd_add_group', { id: 'invoices', name: 'Invoices', subsystem: 'nowhere' });
    expect(unknownHome.isError).toBe(true);
  });

  it('a type updated into another group takes its file along', async () => {
    await call('sdd_add_group', { id: 'wire', name: 'Wire' });
    await call('sdd_update_spec', { kind: 'type', id: 'heap-snapshot', delta: { group: 'wire' } });
    expect(fs.existsSync(types('wire', 'heap-snapshot.yaml'))).toBe(true);
    expect(fs.existsSync(types('platform', 'runtime', 'vm', 'heap-snapshot.yaml'))).toBe(false);
    await call('sdd_update_spec', { kind: 'type', id: 'heap-snapshot', delta: { group: 'vm' } });
    expect(fs.existsSync(types('platform', 'runtime', 'vm', 'heap-snapshot.yaml'))).toBe(true);
  });

  it('moves a group under a new parent (dry run first) with its folder, and refuses a loop', async () => {
    const dry = JSON.parse(await call('sdd_move_spec', { kind: 'group', id: 'runtime', parent: 'wire', dryRun: true }));
    expect(dry.dryRun).toBe(true);
    expect(dry.moved.map((m: any) => `${m.kind}:${m.id}`)).toEqual(['group:runtime', 'group:vm', 'type:heap-snapshot']);
    expect(fs.existsSync(types('platform', 'runtime'))).toBe(true);
    await call('sdd_move_spec', { kind: 'group', id: 'runtime', parent: 'wire' });
    expect(fs.existsSync(types('wire', 'runtime', 'vm', 'heap-snapshot.yaml'))).toBe(true);
    expect(fs.existsSync(types('platform', 'runtime'))).toBe(false);
    expect(JSON.parse(await call('sdd_get_spec', { kind: 'group', id: 'runtime' })).parent).toBe('wire');
    const loop = await raw('sdd_move_spec', { kind: 'group', id: 'wire', parent: 'vm' });
    expect(loop.isError).toBe(true);
    expect(loop.text).toMatch(/GROUP_CYCLE/);
  }, 60_000);

  it('renames a group: folder, types and child groups follow; refuses a taken id', async () => {
    const renamed = JSON.parse(await call('sdd_rename_spec', { kind: 'group', id: 'wire', newId: 'transport' }));
    expect(renamed.renamed).toEqual([{ kind: 'group', from: 'wire', to: 'transport' }]);
    expect(renamed.rewritten).toEqual(['runtime']);
    expect(fs.existsSync(types('transport', 'runtime', 'vm', 'heap-snapshot.yaml'))).toBe(true);
    expect(JSON.parse(await call('sdd_get_spec', { kind: 'group', id: 'runtime' })).parent).toBe('transport');
    expect(JSON.parse(await call('sdd_get_spec', { kind: 'type', id: 'heap-snapshot' })).group).toBe('vm');
    const taken = await raw('sdd_rename_spec', { kind: 'group', id: 'transport', newId: 'platform' });
    expect(taken.isError).toBe(true);
    expect(taken.text).toMatch(/id-taken/);
  }, 60_000);

  it('deletes a group only when nothing names it, unless forced', async () => {
    const refused = await raw('sdd_delete_spec', { kind: 'group', id: 'vm' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/heap-snapshot/);
    await call('sdd_update_spec', { kind: 'type', id: 'heap-snapshot', delta: { group: 'platform' } });
    await call('sdd_delete_spec', { kind: 'group', id: 'vm' });
    expect(fs.existsSync(types('transport', 'runtime', 'vm'))).toBe(false);
    const parentRefused = await raw('sdd_delete_spec', { kind: 'group', id: 'transport' });
    expect(parentRefused.isError).toBe(true);
    expect(parentRefused.text).toMatch(/runtime/);
  }, 60_000);
});
