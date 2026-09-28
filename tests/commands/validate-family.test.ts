import { describe, it, expect, afterEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { pinExternals } from '../../src/core/surfaces.js';
import { runValidate } from '../../src/commands/validate.js';
import { createMcpServer } from '../../src/mcp/server.js';
import * as library from '../../src/index.js';
import { buildContractFamily, type ContractFamily } from '../helpers/reference-family.js';

// ---------------------------------------------------------------------------
// Stage 4, wave B — the three surfaces of the family run: `wairon validate`
// (plain at a parent, `--family` at a member), the MCP `sdd_validate_tree`
// tool's `family` flag, and the library entry. Each reaches the same two
// functions: validateProject and validateFamily.
// ---------------------------------------------------------------------------

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  setProjectRoot(null);
  invalidateSpecCache();
  vi.restoreAllMocks();
  for (const c of cleanups.splice(0)) {
    try { await c(); } catch { /* windows file locks */ }
  }
});

function contractFamily(): ContractFamily {
  const f = buildContractFamily();
  cleanups.push(() => f.cleanup());
  return f;
}

function bind(dir: string): void {
  setProjectRoot(dir);
  invalidateSpecCache();
}

/** Run `wairon validate` at `dir`, capturing what it prints and whether it exits non-zero. */
async function validateAt(dir: string, options: Parameters<typeof runValidate>[0] = {}): Promise<{ out: string; failed: boolean }> {
  bind(dir);
  const lines: string[] = [];
  const capture = (...args: unknown[]): void => { lines.push(args.map(String).join(' ')); };
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);
  let failed = false;
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { failed = (code ?? 0) !== 0; }) as never);
  await runValidate(options);
  vi.restoreAllMocks();
  return { out: lines.join('\n'), failed };
}

describe('wairon validate', () => {
  it('at a parent runs the family run: each project\'s verdict and the composition findings under its key', async () => {
    const f = contractFamily();
    bind(f.billing);
    pinExternals();
    f.setLedgerContract('record');
    const { out, failed } = await validateAt(f.top);
    expect(out).toContain('Per project (each its own gate):');
    expect(out).toMatch(/house \(bound\) — .*error\(s\)/);
    expect(out).toMatch(/ledger — .*error\(s\)/);
    expect(out).toMatch(/billing — .*error\(s\)/);
    expect(out).toMatch(/\[billing\] \[EXTERNAL_INCOMPATIBLE\]/);
    expect(failed).toBe(true);
    // --no-recursive at the parent: the owner's gate alone.
    const own = await validateAt(f.top, { recursive: false });
    expect(own.out).not.toContain('Per project');
    expect(own.out).not.toContain('EXTERNAL_INCOMPATIBLE');
  });

  it('at a member runs its owner\'s gate with the --family hint; --family composes its externals', async () => {
    const f = contractFamily();
    bind(f.billing);
    pinExternals();
    f.setLedgerContract('record');
    const plain = await validateAt(f.billing);
    expect(plain.out).toMatch(/judged against its pin alone; `wairon validate --family`/);
    expect(plain.out).not.toContain('EXTERNAL_INCOMPATIBLE');
    const composed = await validateAt(f.billing, { family: true });
    expect(composed.out).toMatch(/\[billing \(bound\)\] \[EXTERNAL_INCOMPATIBLE\]/);
    expect(composed.failed).toBe(true);
  });

  it('--ci fails on an unwaived warning of the family run, as it does on the owner\'s gate', async () => {
    const f = contractFamily();
    // Nothing pinned, nothing locked: the family run's warnings are real.
    const { failed, out } = await validateAt(f.top, { ci: true });
    expect(out).toMatch(/\[MEMBER_UNAPPROVED\]/);
    expect(failed).toBe(true);
  });
});

describe('sdd_validate_tree', () => {
  async function connect(): Promise<Client> {
    const server = createMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'family-test', version: '0.0.1' });
    await client.connect(clientTransport);
    cleanups.push(async () => { await client.close(); });
    return client;
  }

  it('runs the family run at a parent, the owner\'s gate at a member, and the family run with `family: true`', async () => {
    const f = contractFamily();
    bind(f.billing);
    pinExternals();
    f.setLedgerContract('record');
    const client = await connect();
    bind(f.top);
    const atParent = (await client.callTool({ name: 'sdd_validate_tree', arguments: {} })).structuredContent as Record<string, any>;
    expect(atParent.projects.map((p: { key: string }) => p.key)).toEqual(['', 'ledger', 'billing']);
    expect(atParent.errors.some((e: { code: string; project?: string }) => e.code === 'EXTERNAL_INCOMPATIBLE' && e.project === 'billing')).toBe(true);
    bind(f.billing);
    const atMember = (await client.callTool({ name: 'sdd_validate_tree', arguments: {} })).structuredContent as Record<string, any>;
    expect(atMember.projects).toBeUndefined();
    expect(atMember.hint).toMatch(/`wairon validate --family`/);
    bind(f.billing);
    const withFamily = (await client.callTool({ name: 'sdd_validate_tree', arguments: { family: true } })).structuredContent as Record<string, any>;
    expect(withFamily.projects.map((p: { key: string }) => p.key)).toEqual(['']);
    expect(withFamily.errors.some((e: { code: string }) => e.code === 'EXTERNAL_INCOMPATIBLE')).toBe(true);
  });
});

describe('the library entry', () => {
  it('exports validateProject and validateFamily, and no alias for the retired name', () => {
    expect(typeof library.validateProject).toBe('function');
    expect(typeof library.validateFamily).toBe('function');
    expect((library as Record<string, unknown>).validateSddTree).toBeUndefined();
  });
});
