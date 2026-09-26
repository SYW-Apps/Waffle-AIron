/**
 * A refusal reads "Error: <sentence>" — once — on every write tool.
 *
 * The handlers catch in two ways: some render the caught error's message, some
 * render `String(e)`, which for an Error already reads "Error: …". #131 fixed
 * the create tools one by one and the prefix stayed doubled everywhere else
 * (`sdd_move_methods` answered "Error: Error: unmovable request …"). The fix is
 * in the ONE renderer every refusal goes through, and this pins it across every
 * spec-write tool, each driven into a refusal it really gives.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { setProjectRoot } from '../../src/utils/fs.js';
import { writeYamlFile } from '../../src/utils/yaml.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { createMcpServer } from '../../src/mcp/server.js';

type ToolResult = { isError?: boolean; content?: { type: string; text?: string }[] };

let root: string | undefined;
let client: Client | undefined;

afterEach(async () => {
  try { await client?.close(); } catch { /* already closed */ }
  client = undefined;
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
  invalidateSpecCache();
});

/**
 * Every spec-write tool with arguments it really refuses — all but two:
 * sdd_initialize_system and sdd_add_type have no refusal a caller can reach
 * past the input schema here (a type naming a subsystem that does not exist is
 * accepted), so they are pinned through the renderer the others share.
 */
const REFUSALS: [string, Record<string, unknown>][] = [
  // A restatement that would lower the stored status.
  ['sdd_add_subsystem', { id: 'shop', name: 'Shop', description: 'the shop', status: 'draft' }],
  ['sdd_add_component', { id: 'c', name: 'C', description: 'd', subsystem: 'nowhere', componentType: 'Orchestrator' }],
  ['sdd_define_interface', { id: 'ic', name: 'IC', description: 'd', component: 'nowhere' }],
  ['sdd_write_narrative', { id: 'c_impl', name: 'C', description: 'd', contract: 'inowhere' }],
  ['sdd_set_public_interfaces', { subsystem: 'nowhere', publicInterfaces: [] }],
  ['sdd_set_subsystem_project_path', { subsystem: 'nowhere', projectPath: 'x' }],
  ['sdd_move_subsystem_project', { subsystem: 'nowhere', newProjectPath: 'x' }],
  ['sdd_externalize_subsystem', { subsystem: 'nowhere', projectPath: 'x' }],
  ['sdd_internalize_subsystem', { subsystem: 'nowhere' }],
  ['sdd_rename_component', { id: 'nowhere', newId: 'somewhere' }],
  ['sdd_rename_method', { id: 'shop_portal', method: 'nothing', newName: 'something' }],
  ['sdd_move_methods', { from: 'shop_portal', to: 'shop_api', methods: ['nothing'] }],
  ['sdd_set_endpoints', { interface: 'inowhere', endpoints: [] }],
  ['sdd_delete_spec', { kind: 'component', id: 'nowhere' }],
  ['sdd_update_spec', { kind: 'component', id: 'nowhere', delta: { description: 'x' } }],
];

describe('a refusal carries one Error: prefix on every write tool', () => {
  it.each(REFUSALS)('%s', async (name, args) => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-error-prefix-')));
    fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
    const now = new Date().toISOString();
    writeYamlFile(path.join(root, '.wai', 'project.yaml'), {
      schemaVersion: '1.0.0', name: 'prefix', targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
      rules: {}, createdAt: now, updatedAt: now,
    });
    setProjectRoot(root);
    invalidateSpecCache();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'error-prefix-test', version: '0.0.1' });
    await Promise.all([createMcpServer({ buildStamp: null }).connect(serverTransport), client.connect(clientTransport)]);
    const call = async (tool: string, a: Record<string, unknown>): Promise<ToolResult> =>
      (await client!.callTool({ name: tool, arguments: a })) as ToolResult;
    const ok = (r: ToolResult): void => expect(r.isError ?? false, r.content?.[0]?.text).toBe(false);
    ok(await call('sdd_initialize_system', { name: 'Shop', vision: 'sells things' }));
    ok(await call('sdd_add_subsystem', { id: 'shop', name: 'Shop', description: 'the shop', status: 'design' }));
    for (const id of ['shop_portal', 'shop_api']) {
      ok(await call('sdd_add_component', { id, name: id, description: 'd', subsystem: 'shop', componentType: 'Portal', portalType: 'HTTP_API' }));
    }
    ok(await call('sdd_define_interface', {
      id: 'ishop_portal', name: 'IShopPortal', description: 'd', component: 'shop_portal',
      methods: [{ name: 'pay', description: 'takes payment', signature: 'pay(): void', returns: 'void' }],
    }));

    const result = await call(name, args);
    const text = result.content?.[0]?.text ?? '';
    expect(result.isError, text).toBe(true);
    expect(text).toMatch(/^Error: \S/);
    expect(text).not.toMatch(/^Error:\s*Error\b/);
  });
});
