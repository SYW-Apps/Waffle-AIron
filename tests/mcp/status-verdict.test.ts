import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { getStatusReport } from '../../src/core/status.js';
import { captureApprovedSpecs } from '../../src/core/approval.js';
import { writeLockRecord } from '../../src/core/lockfile.js';
import { computeGateStateId } from '../../src/core/validation.js';

// ---------------------------------------------------------------------------
// sdd_get_status carries the approval verdict.
//
// This tool is what an AI agent reads to decide whether it may write code
// against these specs, so a tree that has drifted from its approval is the
// single most important thing the answer can carry — and silence reads exactly
// like being current. The verdict spent a wave as a PRIVATE helper inside
// `wairon status`: the terminal named the specs that had moved while this tool,
// the one an agent reads, said nothing at all. No test failed, because the
// status tests all ran on temp projects with no lock record, where the verdict
// was empty whatever the code did.
//
// The other half of the claim matters as much. The verdict is COMPOSED beside
// the completeness report, never folded into it: project_status is specced as a
// read over the spec loader alone, so teaching it the approval would be exactly
// the coupling the spec refuses — and every presenter would inherit it.
// ---------------------------------------------------------------------------

const stamp = "createdAt: '2026-09-20T10:00:00Z'\nupdatedAt: '2026-09-20T10:00:00Z'";

function createTempProject() {
  invalidateSpecCache();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-verdict-'));

  const waiDir = path.join(tempDir, '.wai');
  fs.mkdirSync(waiDir);
  fs.writeFileSync(path.join(waiDir, 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0',
    name: 'verdict-project',
    projectType: 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {},
    createdAt: '2026-09-20T10:00:00Z',
    updatedAt: '2026-09-20T10:00:00Z',
  }));

  const specsDir = path.join(waiDir, 'specs');
  for (const d of ['subsystems', 'components', 'interfaces', 'implementations', 'types']) {
    fs.mkdirSync(path.join(specsDir, d), { recursive: true });
  }

  const writeSpec = (type: string, name: string, content: string): string => {
    const filePath = type === 'system'
      ? path.join(specsDir, '.index.yaml')
      : path.join(specsDir, `${type}s`, `${name}.yaml`);
    fs.writeFileSync(filePath, `${content}\n${stamp}\n`);
    return filePath;
  };

  writeSpec('system', 'system', 'schemaVersion: 1.0.0\nname: VerdictSystem\nvision: testing the verdict');
  writeSpec('subsystem', 'alpha', 'schemaVersion: 1.0.0\nid: alpha\nname: Alpha\ndescription: Alpha bounded context\nparentSystem: VerdictSystem');
  const workerPath = writeSpec('component', 'worker', 'schemaVersion: 1.0.0\nid: worker\nname: Worker\ndescription: a worker component\nsubsystem: alpha\ncomponentType: Orchestrator\ndependencyClass: pure');

  return { tempDir, workerPath };
}

/** Write the lock record a `wairon lock --yes` would leave behind. */
function approve(): void {
  writeLockRecord({
    stateId: computeGateStateId(),
    lockedAt: '2026-09-20T11:00:00Z',
    lockedBy: { id: 'tester <t@example.com>', source: 'git' },
    validatorVersion: 'test',
    validationResult: { valid: true, errors: 0, warnings: 0 },
    status: 'ready',
    specs: captureApprovedSpecs(),
    children: {},
  });
}

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'status-verdict-test', version: '0.0.1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('sdd_get_status answers with the lock verdict', () => {
  let proj: ReturnType<typeof createTempProject>;
  const clients: Client[] = [];

  beforeEach(() => {
    proj = createTempProject();
    vi.spyOn(process, 'cwd').mockReturnValue(proj.tempDir);
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) {
      try { await c.close(); } catch { /* already gone */ }
    }
    invalidateSpecCache();
    vi.restoreAllMocks();
    try { fs.rmSync(proj.tempDir, { recursive: true, force: true }); } catch { /* win file locks */ }
  });

  const status = async (): Promise<string> => {
    const client = await connect(createMcpServer());
    clients.push(client);
    const result = await client.callTool({ name: 'sdd_get_status', arguments: {} });
    expect(result.isError ?? false, JSON.stringify(result.content)).toBe(false);
    return (result.content as { type: string; text: string }[])[0].text;
  };

  it('reports the drift when the approved tree has since moved', async () => {
    approve();
    invalidateSpecCache();

    // One spec edited after the approval — the case the whole feature exists
    // for, and the one this tool used to answer with silence.
    fs.writeFileSync(
      proj.workerPath,
      fs.readFileSync(proj.workerPath, 'utf8').replace('a worker component', 'an edited worker component'),
    );
    invalidateSpecCache();

    const text = await status();
    expect(text).toMatch(/1 spec changed since approval/);
    expect(text).toMatch(/worker/);
    expect(text).toContain('tester <t@example.com>');
    // Still the completeness dashboard it always was — the verdict is added,
    // not substituted.
    expect(text).toContain('alpha');
  }, 30_000);

  it('confirms an approved tree that has not moved', async () => {
    approve();
    invalidateSpecCache();

    const text = await status();
    expect(text).toContain('no spec has changed since');
  }, 30_000);

  it('stays quiet about a project nobody has approved', async () => {
    const text = await status();
    expect(text).not.toMatch(/since approval/);
    expect(text).not.toMatch(/Approved:/);
    // The dashboard itself is unaffected by the silence.
    expect(text).toContain('alpha');
  }, 30_000);

  it('composes the verdict BESIDE the completeness report, never inside it', async () => {
    approve();
    invalidateSpecCache();
    fs.writeFileSync(
      proj.workerPath,
      fs.readFileSync(proj.workerPath, 'utf8').replace('a worker component', 'an edited worker component'),
    );
    invalidateSpecCache();

    // The report is a read over the spec loader alone: it counts completeness
    // and knows nothing about approval. Each presenter composes the two.
    const report = getStatusReport({}).text;
    expect(report).not.toMatch(/since approval/);
    expect(report).toContain('alpha');

    const text = await status();
    expect(text).toContain(report);
    expect(text).toMatch(/1 spec changed since approval/);
  }, 30_000);

  it('keeps the completeness report free of the approval modules', () => {
    // The one assertion a type-check cannot make: both spellings compile, so
    // only the import SITE says whether the coupling is back. project_status
    // reaching the approval would put the drift line inside the report and
    // hand it to every presenter whether or not it asked.
    const source = fs.readFileSync(
      path.join(path.resolve(__dirname, '..', '..'), 'src/core/status.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/from '\.\/(approval|lockfile)\.js'/);
    expect(source).not.toMatch(/approvalVerdict|approvalRecord|diffAgainstApproval|movedChildren/);
  });
});
