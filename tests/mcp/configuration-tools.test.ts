import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WAIRON_MAJOR } from '../../src/config/defaults.js';

// ---------------------------------------------------------------------------
// The project configuration as tools, not hand edits: sdd_update_rules (a
// lowering below a rule's default needs its reason and is reported on every
// run), sdd_carry_findings (the conformance debt register) and
// sdd_configure_project (the project's own settings). Driven through the real
// stdio server.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const WAIRON_CLI = path.join(REPO_ROOT, 'src', 'cli', 'index.ts');
const now = new Date().toISOString();

describe('sdd_update_rules, sdd_carry_findings and sdd_configure_project', () => {
  let projDir: string;
  let client: Client;

  const configOf = (): Record<string, any> => yaml.load(fs.readFileSync(path.join(projDir, '.wai', 'project.yaml'), 'utf-8')) as Record<string, any>;
  const raw = (name: string, args: Record<string, unknown>): Promise<any> => client.callTool({ name, arguments: args });
  const call = async (name: string, args: Record<string, unknown>): Promise<any> => {
    const result: any = await raw(name, args);
    expect(result.isError ?? false, `tool failed: ${JSON.stringify(result.content)}`).toBe(false);
    return result;
  };
  const refusal = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const result: any = await raw(name, args);
    expect(result.isError, `expected a refusal: ${JSON.stringify(result.content)}`).toBe(true);
    return result.content[0].text as string;
  };

  beforeAll(async () => {
    projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-config-tools-'));
    fs.mkdirSync(path.join(projDir, '.wai', 'specs'), { recursive: true });
    fs.writeFileSync(path.join(projDir, '.wai', 'project.yaml'), [
      "schemaVersion: '1.0.0'", `waironMajor: ${WAIRON_MAJOR}`,
      'name: config-tools',
      'targets: []',
      `createdAt: '${now}'`,
      `updatedAt: '${now}'`,
    ].join('\n'));
    client = new Client({ name: 'wairon-config-tools-test', version: '0.0.1' });
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [TSX_CLI, WAIRON_CLI, 'mcp', 'serve'],
      cwd: projDir,
      stderr: 'ignore',
    }));
    await call('sdd_initialize_system', { name: 'Couriers', vision: 'parcel tracking', targetLanguage: 'typescript' });
    await call('sdd_add_subsystem', { id: 'tracking', name: 'Tracking', description: 'The tracking service' });
  }, 90_000);

  afterAll(async () => {
    try { await client?.close(); } catch { /* already gone */ }
    try { fs.rmSync(projDir, { recursive: true, force: true }); } catch { /* windows file locks */ }
  });

  it('advertises the three tools', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['sdd_update_rules', 'sdd_carry_findings', 'sdd_configure_project']));
  });

  it('lowers a rule only with its reason, and every run reports the lowering', async () => {
    const asked = await refusal('sdd_update_rules', { set: { 'sddRuleSeverity.EXCESSIVE_DEPENDENCIES': 'notice' } });
    expect(asked).toMatch(/EXCESSIVE_DEPENDENCIES.*why/s);
    expect(configOf().rules?.sddRuleSeverity?.EXCESSIVE_DEPENDENCIES).toBeUndefined();

    const dry = await call('sdd_update_rules', { set: { 'sddRuleSeverity.EXCESSIVE_DEPENDENCIES': 'notice' }, why: 'Hubs fan out by design.', dryRun: true });
    expect(dry.structuredContent).toMatchObject({ wrote: false, lowered: [{ code: 'EXCESSIVE_DEPENDENCIES', from: 'warning', to: 'notice', why: 'Hubs fan out by design.' }] });
    expect(configOf().rules?.sddRuleSeverity).toBeUndefined();

    const written = await call('sdd_update_rules', { set: { 'sddRuleSeverity.EXCESSIVE_DEPENDENCIES': 'notice' }, why: 'Hubs fan out by design.' });
    expect(written.structuredContent).toMatchObject({ wrote: true });
    expect(configOf().rules.sddRuleSeverity.EXCESSIVE_DEPENDENCIES).toBe('notice');
    expect(configOf().rules.severityReasons.EXCESSIVE_DEPENDENCIES).toBe('Hubs fan out by design.');

    const validated: any = await raw('sdd_validate_tree', {});
    expect(JSON.stringify(validated.content)).toContain('RULE_LOWERED');
    expect(JSON.stringify(validated.content)).toContain('Hubs fan out by design.');

    const restored = await call('sdd_update_rules', { unset: ['sddRuleSeverity.EXCESSIVE_DEPENDENCIES'] });
    expect(restored.structuredContent).toMatchObject({ wrote: true, lowered: [] });
    expect(configOf().rules?.severityReasons).toBeUndefined();
    expect(await refusal('sdd_update_rules', { set: { 'conformance.carried': [] } })).toMatch(/conformance\.carried/);
  }, 60_000);

  it('carries a finding in the debt register, and refuses a code that is not carryable', async () => {
    const refused = await refusal('sdd_carry_findings', {
      action: 'add', kind: 'drift', why: 'Because.', findings: [{ code: 'CIRCULAR_DEPENDENCY', spec: 'tracking_api', at: 'x' }],
    });
    expect(refused).toMatch(/CIRCULAR_DEPENDENCY.*carryable/s);

    const added = await call('sdd_carry_findings', {
      action: 'add', kind: 'undecided', why: 'The call is written, the callee is not yet.', revisit: 'Is the depot its own project?',
      findings: [{ code: 'CALL_STEP_UNREALIZED', spec: 'tracking_impl', at: 'scan', covers: ['1'] }],
    });
    expect(added.structuredContent).toMatchObject({ wrote: true });
    expect(configOf().rules.conformance.carried).toHaveLength(1);

    const removed = await call('sdd_carry_findings', { action: 'remove', group: 0 });
    expect(removed.structuredContent.after).toEqual([]);
    expect(configOf().rules?.conformance?.carried).toBeUndefined();
  }, 60_000);

  it('changes the project\'s own settings and names the approval it moves', async () => {
    const dry = await call('sdd_configure_project', { name: 'courier-tracking', dryRun: true });
    expect(dry.structuredContent).toMatchObject({ wrote: false, approvalMoves: [] });
    expect(configOf().name).toBe('config-tools');

    const written = await call('sdd_configure_project', { name: 'courier-tracking', description: 'Parcel tracking.', composition: { requireApprovedMembers: true } });
    expect(written.structuredContent).toMatchObject({ wrote: true, approvalMoves: ['composition'] });
    expect(configOf()).toMatchObject({ name: 'courier-tracking', description: 'Parcel tracking.', composition: { requireApprovedMembers: true } });
    expect(await refusal('sdd_configure_project', { executionTier: 'turbo' })).toMatch(/execution\.tier/);
  }, 60_000);
});
