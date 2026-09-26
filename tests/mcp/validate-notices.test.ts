import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// ---------------------------------------------------------------------------
// sdd_validate_tree reports notices as their own list.
//
// A project that sets a code to `notice` must see that finding under
// `notices` — never under `warnings`, where an agent would read it as
// something to fix before CI passes — and a tree whose only findings are
// notices is valid. Driven through the real stdio server, so the SDK client
// also checks the structured content against the tool's declared schema (a
// schema whose severity enum lacked `notice` would refuse the answer).
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const WAIRON_CLI = path.join(REPO_ROOT, 'src', 'cli', 'index.ts');

const now = new Date().toISOString();

describe('sdd_validate_tree and the notice severity', () => {
  let projDir: string;
  let client: Client;

  const call = async (name: string, args: Record<string, unknown>): Promise<any> => {
    const result: any = await client.callTool({ name, arguments: args });
    expect(result.isError ?? false, `tool failed: ${JSON.stringify(result.content)}`).toBe(false);
    return result;
  };

  beforeAll(async () => {
    projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-mcp-notice-'));
    fs.mkdirSync(path.join(projDir, '.wai', 'specs'), { recursive: true });
    fs.writeFileSync(path.join(projDir, '.wai', 'project.yaml'), [
      "schemaVersion: '1.0.0'",
      'name: mcp-notices',
      'targets:',
      '  - type: claude',
      '    outputDir: .claude/agents',
      '    enabled: true',
      'rules:',
      '  sddRuleSeverity:',
      '    DRAFT_SUBSYSTEM_WARNING: notice',
      `createdAt: '${now}'`,
      `updatedAt: '${now}'`,
    ].join('\n'));

    client = new Client({ name: 'wairon-notice-test', version: '0.0.1' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [TSX_CLI, WAIRON_CLI, 'mcp', 'serve'],
      cwd: projDir,
      stderr: 'ignore',
    });
    await client.connect(transport);

    await call('sdd_initialize_system', { name: 'NoticeSystem', vision: 'reports notices apart', targetLanguage: 'typescript' });
    // A draft subsystem and nothing else: its only finding is DRAFT_SUBSYSTEM_WARNING.
    await call('sdd_add_subsystem', { id: 'shop', name: 'Shop', description: 'The shop bounded context' });
  }, 90_000);

  afterAll(async () => {
    try { await client?.close(); } catch { /* already gone */ }
    try { fs.rmSync(projDir, { recursive: true, force: true }); } catch { /* windows file locks */ }
  });

  it('lists the notice under notices, not warnings, and stays valid', async () => {
    const result = await call('sdd_validate_tree', {});
    const report = result.structuredContent;
    expect(Array.isArray(report.notices)).toBe(true);
    const notice = report.notices.find((n: any) => n.code === 'DRAFT_SUBSYSTEM_WARNING');
    expect(notice?.severity).toBe('notice');
    expect(notice?.specId).toBe('shop');
    expect(report.warnings.some((w: any) => w.code === 'DRAFT_SUBSYSTEM_WARNING')).toBe(false);
    expect(report.errors.some((e: any) => e.code === 'DRAFT_SUBSYSTEM_WARNING')).toBe(false);
    for (const n of report.notices) expect(n.severity).toBe('notice');
    expect(report.valid).toBe(true);
    // The text block carries the same three lists.
    expect(JSON.parse(result.content[0].text)).toEqual(report);
  }, 60_000);
});
