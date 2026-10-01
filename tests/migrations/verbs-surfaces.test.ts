import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { readYamlFile } from '../../src/utils/yaml.js';
import { buildContractFamily, type ContractFamily } from '../helpers/reference-family.js';
import { dirHash, pinAt, widen } from '../helpers/family-verbs.js';

// ---------------------------------------------------------------------------
// Stage 6 wave B — the verbs' two doors, over the contract family.
//
// CLI (a real `wairon` process, home redirected, no terminal on stdin): every
// verb runs runMigration — `--report` prints the plan and writes nothing; with
// no terminal and no --yes it is answered no, writing nothing; `--yes` applies
// it and names the projects to re-lock; a refused plan exits non-zero, writing
// nothing.
//
// MCP (the real server over an in-memory transport): the seven tools are
// published, each with dryRun; dryRun answers the plan and writes nothing; a
// call without it applies; a refusal is a tool error carrying the plan.
// ---------------------------------------------------------------------------

const execFileP = promisify(execFile);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const WAIRON_CLI = path.join(REPO_ROOT, 'src', 'cli', 'index.ts');

/** `wairon …` in a real process with its home redirected; resolves whatever the exit code. */
function cli(cwd: string, home: string, ...args: string[]): Promise<{ stdout: string; code: number }> {
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData'), NO_COLOR: '1', FORCE_COLOR: '0' };
  return execFileP(process.execPath, [TSX_CLI, WAIRON_CLI, ...args], { cwd, env, timeout: 180_000 })
    .then((r) => ({ stdout: r.stdout + r.stderr, code: 0 }))
    .catch((e: Error & { stdout?: string; stderr?: string; code?: number }) => ({ stdout: (e.stdout ?? '') + (e.stderr ?? ''), code: typeof e.code === 'number' ? e.code : 1 }));
}

const configOf = (dir: string): Record<string, unknown> => readYamlFile(path.join(dir, '.wai', 'project.yaml')) as Record<string, unknown>;

describe('stage 6 — the verbs on the CLI (runMigration)', () => {
  const made: ContractFamily[] = [];
  let home = '';
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-verbs-home-'));
  });
  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    for (const f of made.splice(0)) {
      try { f.cleanup(); } catch { /* windows locks */ }
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('--report prints the plan and writes nothing; no terminal and no --yes writes nothing; --yes applies it and names the projects to re-lock', async () => {
    const f = buildContractFamily();
    made.push(f);
    widen(f.ledger);
    pinAt(f.billing);
    const before = dirHash(f.top);

    const report = await cli(f.top, home, 'project', 'rename', 'books-ledger', '--project', 'ledger', '--report');
    expect(report.code).toBe(0);
    expect(report.stdout).toContain('wairon family migration: rename');
    expect(report.stdout).toContain('id: ledger → books-ledger');
    expect(report.stdout).toContain('ledger::ledger-portal → books-ledger::ledger-portal');
    expect(report.stdout).toContain('Report only (--report): nothing was written.');
    expect(report.stdout).toMatch(/To re-lock once applied: ledger, \., billing/);
    expect(dirHash(f.top)).toEqual(before);

    const unanswered = await cli(f.top, home, 'project', 'rename', 'books-ledger', '--project', 'ledger');
    expect(unanswered.code).toBe(0);
    expect(unanswered.stdout).toContain('re-run with --yes to apply it. Nothing was written.');
    expect(dirHash(f.top)).toEqual(before);

    const applied = await cli(f.top, home, 'project', 'rename', 'books-ledger', '--project', 'ledger', '--yes');
    expect(applied.code, applied.stdout).toBe(0);
    expect(applied.stdout).toContain('Applied the rename migration');
    for (const dir of ['ledger', '.', 'billing']) expect(applied.stdout).toContain(`Re-lock ${dir}: run \`wairon lock\` there.`);
    expect(configOf(f.ledger)).toMatchObject({ id: 'books-ledger', previousIds: ['ledger'] });
  }, 600_000);

  it('a refused plan exits non-zero, naming the refusal, and writes nothing; every verb is a command', async () => {
    const f = buildContractFamily();
    made.push(f);
    const before = dirHash(f.top);
    const refused = await cli(f.top, home, 'member', 'detach', 'ghost', '--yes');
    expect(refused.code).not.toBe(0);
    expect(refused.stdout).toContain('[not-a-member]');
    expect(refused.stdout).toContain('The detach migration is refused; nothing was written.');
    expect(dirHash(f.top)).toEqual(before);
    const help = await cli(f.top, home, 'member', '--help');
    for (const verb of ['attach', 'detach', 'adopt', 'rename-alias', 'internalize']) expect(help.stdout).toContain(verb);
  }, 600_000);
});

describe('stage 6 — the verbs as MCP tools (dryRun)', () => {
  const made: ContractFamily[] = [];
  let client: Client | undefined;
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await client?.close();
    client = undefined;
    setProjectRoot(null);
    invalidateSpecCache();
    for (const f of made.splice(0)) {
      try { f.cleanup(); } catch { /* windows locks */ }
    }
  });

  async function connect(root: string): Promise<Client> {
    setProjectRoot(root);
    invalidateSpecCache();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: 'verbs-test', version: '0.0.1' });
    await Promise.all([createMcpServer().connect(serverTransport), c.connect(clientTransport)]);
    client = c;
    return c;
  }
  const textOf = (r: unknown): string => ((r as { content: { text: string }[] }).content[0]?.text ?? '');

  it('publishes the seven verbs, each with dryRun; dryRun answers the plan and writes nothing; without it the verb applies; a refusal is a tool error', async () => {
    const f = buildContractFamily();
    made.push(f);
    widen(f.ledger);
    pinAt(f.billing);
    const c = await connect(f.top);
    const { tools } = await c.listTools();
    for (const name of ['sdd_attach_member', 'sdd_detach_member', 'sdd_adopt_member', 'sdd_rename_project', 'sdd_rename_member_alias', 'sdd_internalize_member', 'sdd_externalize_subsystem']) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, name).toBeDefined();
      expect(Object.keys(tool!.inputSchema.properties ?? {}), name).toContain('dryRun');
    }
    expect(Object.keys(tools.find((t) => t.name === 'sdd_detach_member')!.inputSchema.properties ?? {})).toContain('widen');

    const before = dirHash(f.top);
    const dry = await c.callTool({ name: 'sdd_detach_member', arguments: { alias: 'ledger', dryRun: true } });
    expect(dry.isError ?? false, textOf(dry)).toBe(false);
    const planned = JSON.parse(textOf(dry));
    expect(planned).toMatchObject({ dryRun: true, applied: false, plan: { verb: 'detach', refusals: [] } });
    expect(planned.plan.edits.map((e: { kind: string }) => e.kind)).toEqual(['member', 'external', 'external', 'pin']);
    expect(dry.structuredContent).toEqual(planned);
    expect(dirHash(f.top)).toEqual(before);

    const applied = await c.callTool({ name: 'sdd_rename_project', arguments: { project: 'ledger', newId: 'books-ledger' } });
    expect(applied.isError ?? false, textOf(applied)).toBe(false);
    expect(JSON.parse(textOf(applied))).toMatchObject({ dryRun: false, applied: true, relock: [path.resolve(f.ledger), path.resolve(f.top), path.resolve(f.billing)] });
    expect(configOf(f.ledger)).toMatchObject({ id: 'books-ledger' });

    const afterRename = dirHash(f.top);
    const refused = await c.callTool({ name: 'sdd_rename_member_alias', arguments: { alias: 'ghost', newAlias: 'spirit' } });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/^Error: the rename-alias migration is refused; nothing was written\./);
    expect(textOf(refused)).toContain('not-a-member');
    expect(dirHash(f.top)).toEqual(afterRename);
  });
});
