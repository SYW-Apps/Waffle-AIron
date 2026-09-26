import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { captureBuildStamp, isBuildStale, type BuildStamp } from '../../src/mcp/build.js';
import { assessBuildFreshness, createMcpServer, markStale, schemaFingerprint } from '../../src/mcp/server.js';
import { setProjectRoot } from '../../src/utils/fs.js';
import { writeYamlFile } from '../../src/utils/yaml.js';
import { invalidateSpecCache, loadSubsystemSpec } from '../../src/core/specs.js';

// ---------------------------------------------------------------------------
// Stale-server guard: a long-running MCP server whose build changed on disk
// must announce itself as stale (its in-memory Zod schemas silently STRIP
// fields newer builds added — this destroyed spec data three times before the
// guard), and must REFUSE a spec write when the rebuild changed a schema a
// write passes through — the one staleness that loses data.
// ---------------------------------------------------------------------------

let dirs: string[] = [];
let clients: Client[] = [];

afterEach(async () => {
  for (const client of clients) { try { await client.close(); } catch { /* already closed */ } }
  clients = [];
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
  invalidateSpecCache();
});

function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

/**
 * A stand-in for a build entry: a module exporting `schemaFingerprint`, which
 * is exactly what the guard's child process asks the build on disk for. It is
 * stamped as built, then REBUILT (rewritten, one byte longer) to answer `next`.
 */
function rebuiltEntry(next: string | 'throws'): BuildStamp {
  const entry = path.join(tempDir('wairon-build-'), 'entry.js');
  fs.writeFileSync(entry, "exports.schemaFingerprint = () => 'the build the server started from';\n");
  const stamp = captureBuildStamp(entry) as BuildStamp;
  fs.writeFileSync(entry, next === 'throws'
    ? "throw new Error('half-written build');\n"
    : `exports.schemaFingerprint = () => ${JSON.stringify(next)}; // rebuilt\n`);
  return stamp;
}

describe('MCP server build-freshness guard', () => {
  it('a stamped entry file is fresh until it changes on disk, then stale', () => {
    const dir = tempDir('wairon-stamp-');
    const entry = path.join(dir, 'entry.js');
    fs.writeFileSync(entry, '// build A');

    const stamp = captureBuildStamp(entry);
    expect(stamp).not.toBeNull();
    expect(isBuildStale(stamp)).toBe(false);

    // A rebuild changes size (and mtime); either alone must trip the guard.
    fs.writeFileSync(entry, '// build B — one byte longer');
    expect(isBuildStale(stamp)).toBe(true);
  });

  it('fails open (never warns) when the entry cannot be stat\'d — e.g. a pkg snapshot fs', () => {
    expect(captureBuildStamp('/no/such/entry/file.js')).toBeNull();
    expect(isBuildStale(null)).toBe(false);
    // A stamp whose file has since vanished also stays quiet rather than crying wolf.
    expect(isBuildStale({ path: '/no/such/entry/file.js', mtimeMs: 1, size: 1 })).toBe(false);
    expect(assessBuildFreshness(null)).toEqual({ state: 'fresh', writesRefused: false, reason: '' });
  });

  // -------------------------------------------------------------------------
  // The warning has to reach BOTH channels.
  // -------------------------------------------------------------------------

  it('marks a structured answer as stale as well as banner-ing the text block', () => {
    const marked = markStale({
      content: [{ type: 'text', text: 'Successfully added L2 Component Spec "Ledger" (ledger, Store).' }],
      structuredContent: { kind: 'component', id: 'ledger', replacedExisting: false },
    });
    expect(marked.structuredContent).toEqual({
      kind: 'component', id: 'ledger', replacedExisting: false, staleServer: true,
    });
    expect((marked.content as any)[0].text).toContain('STALE SERVER');
    // Appended, never substituted: the sentence the caller expects comes first.
    expect((marked.content as any)[0].text.startsWith('Successfully added')).toBe(true);
  });

  it('still banners a text-only answer, and invents no structured content for it', () => {
    const marked = markStale({ content: [{ type: 'text', text: 'Successfully deleted component spec "ledger".' }] });
    expect(marked.structuredContent).toBeUndefined();
    expect((marked.content as any)[0].text).toContain('STALE SERVER');
  });
});

// ---------------------------------------------------------------------------
// The schema fingerprint decides between a warning and a refusal.
// ---------------------------------------------------------------------------

describe('a rebuild is judged by its schema fingerprint', () => {
  it('the running fingerprint is a stable sha256', () => {
    const first = schemaFingerprint();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(schemaFingerprint()).toBe(first);
  });

  it('a rebuild whose schemas match is build-changed: warned, writes allowed', () => {
    const freshness = assessBuildFreshness(rebuiltEntry(schemaFingerprint()));
    expect(freshness.state).toBe('build-changed');
    expect(freshness.writesRefused).toBe(false);
    expect(freshness.reason).toContain('spec writes still go through');
  });

  it('a rebuild whose schemas differ is schema-changed: writes refused, reconnect named', () => {
    const freshness = assessBuildFreshness(rebuiltEntry('a different schema fingerprint'));
    expect(freshness.state).toBe('schema-changed');
    expect(freshness.writesRefused).toBe(true);
    expect(freshness.reason).toContain('REFUSED');
    expect(freshness.reason).toContain('/mcp reconnect wairon');
  });

  it('a rebuild that cannot answer is unreadable, and refuses writes rather than guess', () => {
    const freshness = assessBuildFreshness(rebuiltEntry('throws'));
    expect(freshness.state).toBe('unreadable');
    expect(freshness.writesRefused).toBe(true);
    expect(freshness.reason).toContain('half-written build');
  });
});

// ---------------------------------------------------------------------------
// Through the real server: a schema-changed server writes nothing; a
// build-changed one writes with the warning; sdd_get_status leads with it.
// ---------------------------------------------------------------------------

type ToolResult = { isError?: boolean; content?: { type: string; text?: string }[]; structuredContent?: any };
const textOf = (result: ToolResult): string => result.content?.[0]?.text ?? '';

type Call = (name: string, args: Record<string, unknown>) => Promise<ToolResult>;

async function serverStandingFor(stamp: BuildStamp): Promise<{ call: Call; root: string }> {
  const root = tempDir('wairon-stale-project-');
  fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
  const now = new Date().toISOString();
  writeYamlFile(path.join(root, '.wai', 'project.yaml'), {
    schemaVersion: '1.0.0', name: 'stale', targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {}, createdAt: now, updatedAt: now,
  });
  setProjectRoot(root);
  invalidateSpecCache();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'build-freshness-test', version: '0.0.1' });
  await Promise.all([createMcpServer({ buildStamp: stamp }).connect(serverTransport), client.connect(clientTransport)]);
  clients.push(client);
  const call: Call = async (name, args) => (await client.callTool({ name, arguments: args })) as ToolResult;
  return { call, root };
}

describe('the guard on the tools', () => {
  it('a schema-changed server refuses a spec write and writes nothing', async () => {
    const { call, root } = await serverStandingFor(rebuiltEntry('a different schema fingerprint'));

    const result = await call('sdd_initialize_system', { name: 'Shop', vision: 'sells things' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^Error: sdd_initialize_system refused — the wairon build on disk changed/);
    expect(textOf(result)).toContain('/mcp reconnect wairon');
    // Nothing reached disk: the spec tree is exactly as empty as it was.
    expect(fs.readdirSync(path.join(root, '.wai', 'specs'))).toEqual([]);

    // A dry run is refused too: its account would be computed by the old schemas.
    const dry = await call('sdd_update_spec', { kind: 'system', id: 'system', delta: { vision: 'x' }, dryRun: true });
    expect(dry.isError).toBe(true);
    expect(textOf(dry)).toContain('sdd_update_spec refused');
  });

  it('a schema-changed server still answers reads, and says writes are refused', async () => {
    const { call } = await serverStandingFor(rebuiltEntry('a different schema fingerprint'));
    const status = await call('sdd_get_status', {});
    expect(status.isError ?? false).toBe(false);
    // It LEADS: the first call of a session surfaces it before anything else.
    expect(textOf(status).startsWith('⚠ STALE SERVER:')).toBe(true);
    expect(textOf(status)).toContain('every spec write is REFUSED');

    const validated = await call('sdd_validate_tree', {});
    expect(validated.structuredContent.staleServer).toBe(true);
    expect(validated.structuredContent.writesRefused).toBe(true);
    // Everywhere else it trails the answer.
    expect(textOf(validated).startsWith('⚠')).toBe(false);
    expect(textOf(validated)).toContain('⚠ STALE SERVER:');
  });

  it('a build-changed server writes, with the warning in both channels', async () => {
    const { call } = await serverStandingFor(rebuiltEntry(schemaFingerprint()));
    const result = await call('sdd_initialize_system', { name: 'Shop', vision: 'sells things' });
    expect(result.isError ?? false, textOf(result)).toBe(false);
    expect(textOf(result)).toContain('⚠ STALE SERVER:');
    expect(textOf(result)).toContain('spec writes still go through');
    expect(result.structuredContent.staleServer).toBe(true);
    expect(result.structuredContent.writesRefused).toBeUndefined();
    const added = await call('sdd_add_subsystem', { id: 'shop', name: 'Shop', description: 'the shop' });
    expect(added.isError ?? false, textOf(added)).toBe(false);
    invalidateSpecCache();
    expect(loadSubsystemSpec('shop')?.name).toBe('Shop');

    const status = await call('sdd_get_status', {});
    expect(textOf(status).startsWith('⚠ STALE SERVER:')).toBe(true);
    expect(textOf(status)).not.toContain('REFUSED');
  });
});
