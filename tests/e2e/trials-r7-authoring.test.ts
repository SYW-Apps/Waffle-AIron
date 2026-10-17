import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DIST_CLI, REPO_ROOT, callTool } from './helpers';
import { createTrialSandbox, transcript, writeFile, readFile, type TrialSandbox } from './trials-helpers';
import type { FixtureTree } from '../rules-matrix/harness';

// ---------------------------------------------------------------------------
// Round-7 user trials (dev.111) — the authoring tools.
//
// The tinkerer drove sdd_update_spec with an `id` and a `subsystem` in the
// delta (a duplicated spec; a moved folder with every reference left behind,
// both "1 change") and sdd_delete_spec on a subsystem, a component and a type
// (only the index file went, everything under it orphaned, "Successfully
// deleted"). Solo-app, platform and the tinkerer found a reorder answered "No
// change", a dry run promising writes the write refused, a Portal -> Store
// dependsOn and a duplicate route written without a word, and a parameter
// renamed back to its retired name accepted. Each journey replays the probe
// against the BUILT server and CLI.
// ---------------------------------------------------------------------------

const OUTSIDE_CALLER = 'Analytics dashboards and partner scripts, over HTTP';

/** A link shortener: links (a Repository owning a Store, a workflow) and analytics (a Portal, a standalone Store, a type). */
function linkTree(): FixtureTree {
  return {
    system: { name: 'Shortener', vision: 'Shortens links and counts their hits.', targetLanguage: 'typescript', globalRequirements: ['first', 'second', 'third'] },
    subsystems: [
      { id: 'links', description: 'Short links.', status: 'complete' },
      { id: 'analytics', description: 'Hit counting.', status: 'complete' },
    ],
    components: [
      { id: 'link_store', subsystem: 'links', componentType: 'Store', durability: 'ram-projection', status: 'complete' },
      { id: 'link_repository', subsystem: 'links', componentType: 'Repository', owns: ['link_store'], status: 'complete' },
      { id: 'link_workflow', subsystem: 'links', componentType: 'Orchestrator', dependsOn: ['link_repository'], status: 'complete' },
      { id: 'hit_store', subsystem: 'analytics', componentType: 'Store', durability: 'ram-projection', status: 'complete' },
      { id: 'stats_portal', subsystem: 'analytics', componentType: 'Portal', transport: 'HTTP', invokedBy: { kind: 'entry', caller: OUTSIDE_CALLER }, dependsOn: [], status: 'complete' },
    ],
    interfaces: [
      { id: 'ilink_repository', component: 'link_repository', methods: [{ name: 'find', params: [{ name: 'code', type: 'string', previousNames: ['shortCode'] }], returns: 'string' }] },
      { id: 'istats_portal', component: 'stats_portal', methods: [
        { name: 'statsFor', params: [{ name: 'code', type: 'string' }], returns: 'hit_stats', endpoint: { transport: 'HTTP', method: 'GET', path: '/stats/{code}' } },
        { name: 'topLinks', params: [], returns: 'list<hit_stats>', endpoint: { transport: 'HTTP', method: 'GET', path: '/top' } },
      ] },
    ],
    implementations: [
      { id: 'link_repository_impl', contract: 'ilink_repository', technologies: ['postgres', 'redis'], methods: [{ name: 'find', narrative: [] }] },
    ],
    types: [{ id: 'hit_stats', kind: 'value-object', subsystem: 'analytics', fields: [{ name: 'hits', type: 'int' }] }],
  };
}

/** An MCP client on the built server, bound to an existing sandbox project. */
async function mcpAt(dir: string): Promise<Client> {
  const client = new Client({ name: 'wairon-e2e-r7-authoring', version: '0.0.1' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [DIST_CLI, 'mcp', 'serve'],
    cwd: REPO_ROOT,
    env: { ...getDefaultEnvironment(), WAIRON_PROJECT_DIR: dir },
    stderr: 'ignore',
  }));
  return client;
}

/** Every file under the project's specs folder, relative and sorted. */
function specFiles(dir: string): string[] {
  const root = path.join(dir, '.wai', 'specs');
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(path.relative(root, p).split(path.sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
}

let sb: TrialSandbox;
beforeAll(() => { sb = createTrialSandbox('r7authoring'); });
afterAll(async () => { await sb?.cleanup(); });

describe('journey: a delta never changes which spec it is or where it lives (tinkerer-r7 N1, MAJOR)', () => {
  let dir: string;
  let client: Client;
  beforeAll(async () => { dir = sb.materialize('updlab', linkTree()); client = await mcpAt(dir); }, 120_000);
  afterAll(async () => { try { await client?.close(); } catch { /* gone */ } });

  it('an id in the delta is refused, naming the rename tool, and no twin is written — the dry run refused alike', async () => {
    const before = specFiles(dir);
    for (const dryRun of [true, false]) {
      const r = await callTool(client, 'sdd_update_spec', { kind: 'component', id: 'stats_portal', delta: { id: 'renamed_by_update' }, dryRun });
      expect(r.ok, r.text).toBe(false);
      expect(r.text).toMatch(/sdd_rename_component/);
    }
    expect(specFiles(dir)).toEqual(before);
  });

  it('a subsystem in the delta is refused, naming sdd_move_spec (r8: the owed tool exists)', async () => {
    const before = specFiles(dir);
    const r = await callTool(client, 'sdd_update_spec', { kind: 'component', id: 'stats_portal', delta: { subsystem: 'links' } });
    expect(r.ok, r.text).toBe(false);
    expect(r.text).toMatch(/"subsystem" is where the component lives.*sdd_move_spec/s);
    expect(specFiles(dir)).toEqual(before);
  });
});

describe('journey: deleting a container takes its subtree, and is refused while others reference it (tinkerer-r7 N2, MAJOR)', () => {
  let dir: string;
  let client: Client;
  beforeAll(async () => { dir = sb.materialize('newlab', linkTree()); client = await mcpAt(dir); }, 120_000);
  afterAll(async () => { try { await client?.close(); } catch { /* gone */ } });

  it('a type two contracts use is refused, naming both, and nothing is removed', async () => {
    const before = specFiles(dir);
    const r = await callTool(client, 'sdd_delete_spec', { kind: 'type', id: 'hit_stats' });
    expect(r.ok, r.text).toBe(false);
    expect(r.text).toMatch(/interface "istats_portal" \(methods\.statsFor\)/);
    expect(r.text).toMatch(/force: true/);
    expect(specFiles(dir)).toEqual(before);
  });

  it('a dry run of the links subsystem lists every spec it would take and every reference left, and removes nothing', async () => {
    const before = specFiles(dir);
    const r = await callTool(client, 'sdd_delete_spec', { kind: 'subsystem', id: 'links', dryRun: true });
    expect(r.ok, r.text).toBe(true);
    expect(r.text).toMatch(/DRY RUN/);
    for (const id of ['link_store', 'link_repository', 'ilink_repository', 'link_repository_impl', 'link_workflow']) expect(r.text).toContain(`"${id}"`);
    const structured = (r.raw as { structuredContent?: { removed: unknown[]; references: unknown[] } }).structuredContent;
    expect(structured?.removed).toHaveLength(6);
    expect(structured?.references).toEqual([]);
    expect(specFiles(dir)).toEqual(before);
  });

  it('a component goes with its contract, implementation and owned members once its referrer is edited', async () => {
    const refused = await callTool(client, 'sdd_delete_spec', { kind: 'component', id: 'link_repository' });
    expect(refused.ok).toBe(false);
    expect(refused.text).toMatch(/component "link_workflow" \(dependsOn\) -> component "link_repository"/);
    const edit = await callTool(client, 'sdd_update_spec', { kind: 'component', id: 'link_workflow', delta: { dependsOn: [{ value: 'link_repository', action: 'delete' }] } });
    expect(edit.ok, edit.text).toBe(true);
    const r = await callTool(client, 'sdd_delete_spec', { kind: 'component', id: 'link_repository' });
    expect(r.ok, r.text).toBe(true);
    expect(r.text).toMatch(/Successfully deleted component spec "link_repository" and 3 specs it contained/);
    expect(specFiles(dir).filter((f) => /link_repository|link_store/.test(f))).toEqual([]);
    const v = await callTool(client, 'sdd_validate_tree', {});
    expect(v.text).not.toMatch(/INVALID_TARGET_COMPONENT_REFERENCE|INVALID_SUBSYSTEM_REFERENCE/);
  });

  it('force deletes a referenced spec and answers what it left dangling', async () => {
    const r = await callTool(client, 'sdd_delete_spec', { kind: 'type', id: 'hit_stats', force: true });
    expect(r.ok, r.text).toBe(true);
    expect(r.text).toMatch(/LEFT DANGLING/);
    expect(specFiles(dir).some((f) => f.includes('hit_stats'))).toBe(false);
  });
});

describe('journey: list edits say what they did, and a dry run is refused exactly when the write is (solo-app/platform/tinkerer r7)', () => {
  let dir: string;
  let client: Client;
  beforeAll(async () => { dir = sb.materialize('listlab', linkTree()); client = await mcpAt(dir); }, 120_000);
  afterAll(async () => { try { await client?.close(); } catch { /* gone */ } });

  it('restating the requirements in another order reorders them and says so', async () => {
    const r = await callTool(client, 'sdd_update_spec', { kind: 'system', id: 'system', delta: { globalRequirements: ['third', 'second', 'first'] } });
    expect(r.ok, r.text).toBe(true);
    expect(r.text).toMatch(/globalRequirements reordered/);
    expect(readFile(dir, '.wai/specs/.index.yaml').indexOf('third')).toBeLessThan(readFile(dir, '.wai/specs/.index.yaml').indexOf('first'));
  });

  it('a mixed edit is reported value by value', async () => {
    const r = await callTool(client, 'sdd_update_spec', { kind: 'system', id: 'system', delta: { globalRequirements: ['fourth', { value: 'second', action: 'delete' }] } });
    expect(r.ok, r.text).toBe(true);
    expect(r.text).toMatch(/globalRequirements removed[^\n]*second/);
    expect(r.text).toMatch(/globalRequirements added[^\n]*fourth/);
    expect(r.text).not.toMatch(/globalRequirements set/);
  });

  it('an object in the technologies list is refused by the dry run as by the write', async () => {
    const delta = { technologies: [{ name: 'redis', role: 'store', version: '7' }] };
    const dry = await callTool(client, 'sdd_update_spec', { kind: 'implementation', id: 'link_repository_impl', delta, dryRun: true });
    const write = await callTool(client, 'sdd_update_spec', { kind: 'implementation', id: 'link_repository_impl', delta });
    expect(dry.ok).toBe(false);
    expect(write.ok).toBe(false);
    expect(dry.text).toBe(write.text);
  });

  it('an unset of dependsOn reports the clearing and no contradicting NO EFFECT', async () => {
    const r = await callTool(client, 'sdd_update_spec', { kind: 'component', id: 'link_workflow', delta: { unset: ['dependsOn'] }, dryRun: true });
    expect(r.ok, r.text).toBe(true);
    expect(r.text).toMatch(/dependsOn would be cleared/);
    expect(r.text).not.toMatch(/NO EFFECT/);
  });
});

describe('journey: the write gate reports the design errors a write introduces (solo-app r7, platform r7)', () => {
  let dir: string;
  let client: Client;
  beforeAll(async () => { dir = sb.materialize('gatelab', linkTree()); client = await mcpAt(dir); }, 120_000);
  afterAll(async () => { try { await client?.close(); } catch { /* gone */ } });

  it('a Portal -> Store dependsOn is refused, dry run included', async () => {
    for (const dryRun of [true, false]) {
      const r = await callTool(client, 'sdd_update_spec', { kind: 'component', id: 'stats_portal', delta: { dependsOn: ['hit_store'] }, dryRun });
      expect(r.ok, r.text).toBe(false);
      expect(r.text).toMatch(/ARCHITECTURE_VIOLATION_PORTAL_FORBIDDEN_DEP/);
    }
  });

  it('sdd_set_endpoints refuses a route another method already binds', async () => {
    const r = await callTool(client, 'sdd_set_endpoints', { interface: 'istats_portal', endpoints: [{ method: 'topLinks', transport: 'HTTP', httpMethod: 'GET', path: '/stats/{other}' }] });
    expect(r.ok, r.text).toBe(false);
    expect(r.text).toMatch(/ENDPOINT_ROUTE_DUPLICATE/);
  });
});

describe('journey: the smaller authoring items (tinkerer r7, solo-app r7)', () => {
  let dir: string;
  let client: Client;
  beforeAll(async () => { dir = sb.materialize('smalllab', linkTree()); client = await mcpAt(dir); }, 120_000);
  afterAll(async () => { try { await client?.close(); } catch { /* gone */ } });

  it('sdd_add_component takes a variant, so a gateway Portal is one call', async () => {
    const r = await callTool(client, 'sdd_add_component', { id: 'edge_portal', name: 'Edge', description: 'Authenticates and forwards.', subsystem: 'analytics', componentType: 'Portal', transport: 'HTTP', variant: 'gateway', dependsOn: [] });
    expect(r.ok, r.text).toBe(true);
    expect(readFile(dir, '.wai/specs/components/edge_portal.yaml')).toMatch(/variant: gateway/);
  });

  it('the sdd_update_spec description is served whole and short', async () => {
    const tools = (await client.listTools()).tools;
    const update = tools.find((t) => t.name === 'sdd_update_spec')!;
    const delta = (update.inputSchema.properties as Record<string, { description?: string }>).delta.description ?? '';
    expect(update.description!.length).toBeLessThan(1500);
    expect(delta.length).toBeLessThan(2500);
    expect(delta.trimEnd()).toMatch(/read that list\.$/);
  });

  it('a parameter renamed back to the name it had is refused (name-retired)', async () => {
    const r = await callTool(client, 'sdd_rename_param', { id: 'link_repository', method: 'find', param: 'code', newName: 'shortCode', dryRun: true });
    expect(r.ok, r.text).toBe(false);
    expect(r.text).toMatch(/name-retired/);
  });

  it('member attach takes a sibling written with ../, as member add does', async () => {
    const sibling = sb.materialize('legacy-sibling', { system: { name: 'Legacy', vision: 'An older project kept as it is.' } });
    writeFile(sibling, '.wai/project.yaml', `id: legacy\n${readFile(sibling, '.wai/project.yaml')}`);
    const rel = path.relative(dir, sibling).split(path.sep).join('/');
    expect(rel.startsWith('../')).toBe(true);
    const r = await sb.run(['member', 'attach', 'legacy', rel, '--report'], dir);
    expect(r.all, transcript(r)).not.toMatch(/not-contained/);
    expect(r.all, transcript(r)).toMatch(/members: legacy/);
  });
});
