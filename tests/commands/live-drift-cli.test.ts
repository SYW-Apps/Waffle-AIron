import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { pinExternals } from '../../src/core/surfaces.js';
import { runValidate } from '../../src/commands/validate.js';
import { runStatus } from '../../src/commands/status.js';
import { runExternals } from '../../src/commands/externals.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { buildGitExternalPair, buildPathExternalPair, type PathExternalPair } from '../helpers/reference-family.js';
import { WAIRON_MAJOR, WAIRON_VERSION } from '../../src/config/defaults.js';

// ---------------------------------------------------------------------------
// The trial scenario end to end at the command surfaces: a producer renames a
// method its consumer uses. A path external is read live, so the owner's gate
// itself fails on the break, naming the rename (`validate --ci` exits 1). A
// pinned git external keeps the owner's gate green — the pin gates — and plain
// `validate` says offline that it was not compared; `status` and sdd_get_status
// carry an Externals section; sdd_validate_tree lists the finding marked
// advisory with the tree still valid; `externals status` exits 1.
// ---------------------------------------------------------------------------

const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  setProjectRoot(null);
  invalidateSpecCache();
  process.exitCode = undefined;
  for (const c of cleanups.splice(0)) {
    try { c(); } catch { /* windows file locks */ }
  }
});

/** billing reads ledger live (a `../` path external, never pinned), then ledger renames the `post` billing uses. */
function renamedLive(): PathExternalPair {
  const p = buildPathExternalPair();
  cleanups.push(() => p.cleanup());
  setProjectRoot(p.billing);
  invalidateSpecCache();
  p.setLedgerContract({ postName: 'record', formerly: ['iledger-portal.post'] });
  invalidateSpecCache();
  return p;
}

/** billing pinned against ledger (a git external), then ledger releases a rename of the `post` billing uses. */
function renamedAfterPin(): PathExternalPair {
  const p = buildGitExternalPair();
  cleanups.push(() => p.cleanup());
  setProjectRoot(p.billing);
  invalidateSpecCache();
  pinExternals();
  p.setLedgerContract({ postName: 'record', formerly: ['iledger-portal.post'] });
  invalidateSpecCache();
  return p;
}

/** Everything the command printed, one string. */
function capture(): () => string {
  const out: string[] = [];
  const push = (...args: unknown[]): void => { out.push(args.map(String).join(' ')); };
  vi.spyOn(console, 'log').mockImplementation(push);
  vi.spyOn(console, 'error').mockImplementation(push);
  vi.spyOn(console, 'warn').mockImplementation(push);
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => { out.push(String(chunk)); return true; });
  return () => out.join('\n');
}

describe('live drift at the command surfaces', () => {
  it('plain `validate --ci` fails the live break of a path external, naming the rename', async () => {
    const p = renamedLive();
    // A consumer whose own gate is otherwise clean: one enabled target, and the
    // miniature's unrelated findings (an untyped number, an unreached adapter) off.
    fs.writeFileSync(path.join(p.billing, '.wai', 'project.yaml'), [
      'schemaVersion: 1.0.0', `waironMajor: ${WAIRON_MAJOR}`, 'id: billing', 'name: Billing',
      'externals:', '  ledger:', '    source:', '      path: ../ledger',
      'rules:', '  sddRuleSeverity:', '    TYPE_NOT_NEUTRAL: "off"', '    UNUSED_COMPONENT: "off"',
      '  severityReasons:', '    TYPE_NOT_NEUTRAL: "The miniature types a number."', '    UNUSED_COMPONENT: "The miniature leaves an adapter unreached."',
      'targets:', '  - type: claude', '    outputDir: .claude/agents', '    enabled: true',
      "createdAt: '2026-09-27T00:00:00.000Z'", "updatedAt: '2026-09-27T00:00:00.000Z'", '',
    ].join('\n'));
    invalidateSpecCache();
    const printed = capture();
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
    await expect(runValidate({ ci: true })).rejects.toThrow('exit 1');
    expect(exit).toHaveBeenCalledWith(1);
    const text = printed();
    expect(text).toContain('[INVALID_TARGET_METHOD_REFERENCE]');
    expect(text).toContain('renamed to "record"');
  });

  it('plain `validate --ci` composes a pinned git external live and fails its break, naming the rename and the re-pin', async () => {
    const p = renamedAfterPin();
    fs.writeFileSync(path.join(p.billing, '.wai', 'project.yaml'), [
      'schemaVersion: 1.0.0', `waironMajor: ${WAIRON_MAJOR}`, 'id: billing', 'name: Billing',
      'externals:', '  ledger:', '    source:', `      git: ${p.url}`,
      'rules:', '  sddRuleSeverity:', '    TYPE_NOT_NEUTRAL: "off"', '    UNUSED_COMPONENT: "off"',
      '  severityReasons:', '    TYPE_NOT_NEUTRAL: "The miniature types a number."', '    UNUSED_COMPONENT: "The miniature leaves an adapter unreached."',
      'targets:', '  - type: claude', '    outputDir: .claude/agents', '    enabled: true',
      "createdAt: '2026-09-27T00:00:00.000Z'", "updatedAt: '2026-09-27T00:00:00.000Z'", '',
    ].join('\n'));
    invalidateSpecCache();
    const printed = capture();
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
    await expect(runValidate({ ci: true })).rejects.toThrow('exit 1');
    expect(exit).toHaveBeenCalledWith(1);
    const text = printed();
    expect(text).toContain('[EXTERNAL_INCOMPATIBLE]');
    expect(text).toContain('renamed to "ledger-portal.record"');
    expect(text).toContain('`wairon externals pin ledger`');
    expect(text).toContain(`(wairon ${WAIRON_VERSION})`);
  });

  it('`status` prints an Externals section and exits as before', async () => {
    renamedLive();
    const printed = capture();
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
    await runStatus();
    expect(exit).not.toHaveBeenCalled();
    const out = printed();
    expect(out).toMatch(/Externals[\s\S]*\[EXTERNAL_LIVE_INCOMPATIBLE\][\s\S]*renamed to "ledger-portal\.record"/);
    expect(out).toContain(`wairon ${WAIRON_VERSION}`);
  });

  it('`externals status` exits 1 on an incompatible external and names the rename; `externals pin` exits 1 when an alias cannot be pinned', async () => {
    const p = renamedLive();
    const printed = capture();
    await runExternals('status', []);
    expect(process.exitCode).toBe(1);
    expect(printed()).toContain('renamed to ledger-portal.record');
    process.exitCode = undefined;
    p.setBillingConfig(['id: billing', 'name: Billing', 'externals:', '  ledger:', '    source:', '      git: file:///nowhere/ledger.git']);
    invalidateSpecCache();
    await runExternals('pin', [], { json: true });
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    // Nothing can be compared: exit 2, never a pass.
    await runExternals('status', [], { json: true });
    expect(process.exitCode).toBe(2);
  });

  it('sdd_validate_tree reports a pinned git external break as an error; sdd_get_externals_status names the rename', async () => {
    renamedAfterPin();
    const server = createMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'live-drift-test', version: '0.0.1' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const validated: any = await client.callTool({ name: 'sdd_validate_tree', arguments: {} });
      expect(validated.structuredContent.valid).toBe(false);
      expect(validated.structuredContent.errors.map((e: any) => e.code)).toEqual(['EXTERNAL_INCOMPATIBLE']);
      const externals: any = await client.callTool({ name: 'sdd_get_externals_status', arguments: {} });
      expect(externals.structuredContent.statuses[0]).toMatchObject({ alias: 'ledger', health: 'incompatible' });
      expect(externals.structuredContent.statuses[0].uses[0]).toMatchObject({ state: 'renamed', renamedTo: 'ledger-portal.record' });
    } finally {
      await client.close();
    }
  });
});
