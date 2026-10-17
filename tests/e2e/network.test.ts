import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { parseAllDocuments } from 'yaml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { assertDistBuilt, DIST_CLI, REPO_ROOT, rmrfWithRetry } from './helpers';
import { materializeFixtureProject } from '../rules-matrix/harness';
import { platformFamily, PLATFORM_BINDINGS } from '../helpers/network-family';

// ---------------------------------------------------------------------------
// The derived networking through the BUILT artifact: `wairon network
// flows|policy|diagram|check|why` as a team runs them, and the two read-only
// MCP tools (tools/call sdd_get_network_flows, sdd_explain_flow), over a
// family with a declared network, a gateway, two services and a library.
// ---------------------------------------------------------------------------

interface CliResult { code: number; stdout: string; stderr: string }

function runCli(args: string[], cwd: string): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(process.execPath, [DIST_CLI, ...args], { cwd, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error && typeof (error as unknown as { code?: unknown }).code === 'number' ? (error as unknown as { code: number }).code : error ? 1 : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

describe('e2e wairon network (built CLI and MCP server)', () => {
  let dir = '';
  let client: Client;

  beforeAll(async () => {
    assertDistBuilt();
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-e2e-network-')));
    materializeFixtureProject(dir, platformFamily());
    fs.writeFileSync(path.join(dir, 'bindings.yaml'), PLATFORM_BINDINGS);
    client = new Client({ name: 'wairon-e2e', version: '0.0.1' });
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [DIST_CLI, 'mcp', 'serve'],
      cwd: REPO_ROOT,
      env: { ...getDefaultEnvironment(), WAIRON_PROJECT_DIR: dir },
      stderr: 'ignore',
    }));
  });

  afterAll(async () => {
    try { await client.close(); } catch { /* gone */ }
    await rmrfWithRetry(dir);
  });

  it('network flows prints the matrix as JSON on stdout, CSV to --out', async () => {
    const json = await runCli(['network', 'flows'], dir);
    expect(json.code).toBe(0);
    const flows = JSON.parse(json.stdout) as { to: { component: string; verb: string } }[];
    expect(flows).toHaveLength(7);
    const csv = await runCli(['network', 'flows', '--format', 'csv', '--out', 'flows.csv'], dir);
    expect(csv.code).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'flows.csv'), 'utf8').split('\n')[0]).toBe('"from","to","transport","binding","crosses","via","evidence","gate"');
    expect((await runCli(['network', 'flows', '--format', 'yaml'], dir)).code).toBe(1);
  });

  it('network policy needs --bindings and writes NetworkPolicy documents that parse', async () => {
    const missing = await runCli(['network', 'policy'], dir);
    expect(missing.code).toBe(1);
    expect(missing.stdout + missing.stderr).toMatch(/--bindings <file>/);
    const ok = await runCli(['network', 'policy', '--bindings', 'bindings.yaml'], dir);
    expect(ok.code).toBe(0);
    const objects = parseAllDocuments(ok.stdout).map((d) => d.toJS()).filter(Boolean) as { kind: string }[];
    expect(objects.map((o) => o.kind)).toEqual(['NetworkPolicy', 'NetworkPolicy', 'NetworkPolicy']);
  });

  it('network diagram prints a Mermaid flowchart', async () => {
    const r = await runCli(['network', 'diagram'], dir);
    expect(r.code).toBe(0);
    expect(r.stdout.startsWith('flowchart LR')).toBe(true);
  });

  it('network check exits 1 on an unexpected flow and 0 when everything observed is designed', async () => {
    fs.writeFileSync(path.join(dir, 'bad.csv'), 'source,destination\norders,edge\n');
    const bad = await runCli(['network', 'check', '--observed', 'bad.csv', '--bindings', 'bindings.yaml'], dir);
    expect(bad.code).toBe(1);
    expect(bad.stdout).toMatch(/Unexpected flows \(1\)/);
    fs.writeFileSync(path.join(dir, 'good.json'), JSON.stringify([{ source: 'outside', destination: 'edge', method: 'GET', path: '/api/orders' }]));
    const good = await runCli(['network', 'check', '--observed', 'good.json', '--bindings', 'bindings.yaml', '--format', 'json'], dir);
    expect(good.code).toBe(0);
    expect(JSON.parse(good.stdout).unexpected).toEqual([]);
  });

  it('network why explains an allowed flow and exits 1 when nothing allows it', async () => {
    const yes = await runCli(['network', 'why', 'orders', 'billing::billing_api.charge'], dir);
    expect(yes.code).toBe(0);
    expect(yes.stdout).toMatch(/through gateway billing::billing_api/);
    expect((await runCli(['network', 'why', 'outside', 'orders::orders_api'], dir)).code).toBe(1);
  });

  it('serves sdd_get_network_flows and sdd_explain_flow as structured reads', async () => {
    const flows = await client.callTool({ name: 'sdd_get_network_flows', arguments: { to: 'billing' } }) as { isError?: boolean; structuredContent?: { flows: unknown[] } };
    expect(flows.isError).not.toBe(true);
    expect(flows.structuredContent!.flows).toHaveLength(3);
    const why = await client.callTool({ name: 'sdd_explain_flow', arguments: { from: 'orders_client', to: 'orders::orders_api.create' } }) as { structuredContent?: { allowed: boolean } };
    expect(why.structuredContent!.allowed).toBe(true);
  });
});
