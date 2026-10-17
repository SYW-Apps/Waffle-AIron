/**
 * The design export's delivery (wave 3): surface_transfer_adapter.writeDesignTo
 * and surface_orchestrator.exportDesign, the surface portal and its library
 * re-export, and `wairon export` (cli_runner.runExport) — the lock-check verdict
 * decided first and handed in, stdout carrying the JSON and nothing else, a
 * repository with no spec tree refused.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// The verdict runExport hands down, steerable per test; the real check otherwise.
const verdict = vi.hoisted(() => ({ forced: null as null | { state: string; approved: boolean; message: string } }));
vi.mock('../../src/commands/lock.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/commands/lock.js')>();
  return { ...real, checkApproval: (strict: boolean) => verdict.forced ?? real.checkApproval(strict) };
});

import { setProjectRoot } from '../../src/utils/fs.js';
import {
  saveSystemSpec,
  saveSpec,
  saveComponentSpec,
  saveInterfaceSpec,
  invalidateSpecCache,
} from '../../src/core/specs.js';
import { runExport } from '../../src/commands/surface.js';
import { exportDesign as orchestratorExport, writeDesignTo } from '../../src/core/surfaces.js';
import { exportDesign as portalExport } from '../../src/core/surface-portal.js';
import * as library from '../../src/index.js';
import { DesignExportSchema, type ComponentSpec, type DesignExport } from '../../src/models/index.js';
import { WaironError } from '../../src/utils/errors.js';

const now = '2026-10-04T12:00:00.000Z';

function buildProject(root: string): void {
  fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(root, '.wai', 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0', id: 'tiny', name: 'tiny-system', projectType: 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }], rules: {}, createdAt: now, updatedAt: now,
  }));
  setProjectRoot(root);
  saveSystemSpec({
    schemaVersion: '1.0.0', name: 'tiny-system', vision: 'one portal', boundaries: [], globalRequirements: [], databases: [],
    createdAt: now, updatedAt: now,
  });
  saveSpec('subsystem', {
    id: 'core-sub', name: 'core-sub', description: 'the core', parentSystem: 'tiny-system',
    publicInterfaces: [], trustedLinks: [], status: 'complete', createdAt: now, updatedAt: now,
  });
  saveComponentSpec({
    id: 'tiny-portal', name: 'Tiny Portal', description: 'serves', subsystem: 'core-sub', componentType: 'Portal',
    portalType: 'CLI', owns: [], dependsOn: [], status: 'complete', createdAt: now, updatedAt: now,
  } as ComponentSpec);
  saveInterfaceSpec({
    id: 'itiny-portal', name: 'ITinyPortal', description: 'contract', component: 'tiny-portal', status: 'complete',
    methods: [{ name: 'run', description: 'Run it.', returns: 'void', params: [], endpoint: { transport: 'CLI', command: 'tiny run' } }],
    createdAt: now, updatedAt: now,
  });
  invalidateSpecCache();
  setProjectRoot(root);
}

describe('design export delivery', () => {
  let root: string;
  let out: string;
  let stdout: string;
  let write: ReturnType<typeof vi.spyOn>;
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-export-'));
    out = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-export-out-'));
    stdout = '';
    write = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write);
    log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { stdout += `${args.join(' ')}\n`; });
  });
  afterEach(() => {
    write.mockRestore();
    log.mockRestore();
    verdict.forced = null;
    setProjectRoot(null);
    invalidateSpecCache();
    for (const dir of [root, out]) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* win file locks */ }
    }
  });

  it('the orchestrator writes the export to --out as deterministic JSON, the same bytes every time', () => {
    buildProject(root);
    const target = path.join(out, 'nested', 'design.json');
    const design = orchestratorExport(target, 'stale');
    const first = fs.readFileSync(target, 'utf8');
    expect(first).toBe(`${JSON.stringify(design, null, 2)}\n`);
    expect(design.source).toMatchObject({ approval: 'stale', approved: false });
    orchestratorExport(target, 'stale');
    expect(fs.readFileSync(target, 'utf8')).toBe(first);
  });

  it('the orchestrator writes nothing without an output path', () => {
    buildProject(root);
    const before = fs.readdirSync(out);
    expect(orchestratorExport().format).toBe('wairon-design');
    expect(fs.readdirSync(out)).toEqual(before);
  });

  it('writeDesignTo sorts object keys whatever order the design arrives in, and names a path it cannot write', () => {
    buildProject(root);
    const design = orchestratorExport();
    const shuffled = Object.fromEntries(Object.entries(design).reverse()) as DesignExport;
    const a = writeDesignTo(path.join(out, 'a.json'), design);
    const b = writeDesignTo(path.join(out, 'b.json'), shuffled);
    expect(fs.readFileSync(b, 'utf8')).toBe(fs.readFileSync(a, 'utf8'));
    const blocker = path.join(out, 'file');
    fs.writeFileSync(blocker, 'x');
    expect(() => writeDesignTo(path.join(blocker, 'under-a-file.json'), design)).toThrow(/Cannot write the design export to .*under-a-file\.json/);
  });

  it('the portal forwards to the orchestrator, and the library entry publishes it as exportDesign', () => {
    buildProject(root);
    expect(JSON.stringify(portalExport(undefined, 'locked'))).toBe(JSON.stringify(orchestratorExport(undefined, 'locked')));
    expect(library.exportDesign).toBe(portalExport);
    expect(library.exportDesign().source.approval).toBe('unjudged');
  });

  describe('wairon export (runExport)', () => {
    it('prints the JSON to stdout and nothing else, stamped with the lock-check verdict', async () => {
      buildProject(root);
      await runExport();
      const parsed = JSON.parse(stdout) as DesignExport;
      expect(DesignExportSchema.safeParse(parsed).success).toBe(true);
      const design = parsed;
      // A project that never locked: lock-check says unlocked, and so does the export.
      expect(design.source).toMatchObject({ approval: 'unlocked', approved: false });
      expect(stdout).toBe(`${JSON.stringify(design, null, 2)}\n`);
      const tiny = design.interfaces[0].methods[0];
      expect(tiny.endpoint).toEqual({ transport: 'CLI', command: 'tiny run' });
    });

    it('hands down exactly the state lock-check decided', async () => {
      buildProject(root);
      verdict.forced = { state: 'locked', approved: true, message: 'ok' };
      await runExport();
      expect(JSON.parse(stdout).source).toMatchObject({ approval: 'locked', approved: true });
      stdout = '';
      verdict.forced = { state: 'stale', approved: false, message: 'moved' };
      await runExport();
      expect(JSON.parse(stdout).source).toMatchObject({ approval: 'stale', approved: false });
    });

    it('writes --out and reports the path and the approval instead of printing the JSON', async () => {
      buildProject(root);
      const target = path.join(out, 'design.json');
      await runExport(target);
      const written = JSON.parse(fs.readFileSync(target, 'utf8')) as DesignExport;
      expect(written.source.approval).toBe('unlocked');
      expect(stdout).toContain(target);
      expect(stdout).toContain('approval: unlocked');
      expect(stdout).not.toContain('"format"');
    });

    it("at a family's top with no design of its own, lists the member as a dependency and says so off stdout", async () => {
      // The member: a project of its own (an id and an L0) holding the design.
      buildProject(path.join(root, 'core'));
      // The top: an L0 and a member, and no subsystem of its own.
      fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
      fs.writeFileSync(path.join(root, '.wai', 'project.yaml'), JSON.stringify({
        schemaVersion: '1.0.0', id: 'top', name: 'top-system', projectType: 'backend', members: { core: 'core' },
        targets: [], rules: {}, createdAt: now, updatedAt: now,
      }));
      setProjectRoot(root);
      saveSystemSpec({
        schemaVersion: '1.0.0', name: 'top-system', vision: 'a family', boundaries: [], globalRequirements: [], databases: [],
        createdAt: now, updatedAt: now,
      });
      invalidateSpecCache();
      setProjectRoot(root);
      let stderr = '';
      const err = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
        stderr += String(chunk);
        return true;
      }) as typeof process.stderr.write);
      try {
        await runExport();
      } finally {
        err.mockRestore();
      }
      // Correct per the format: the member is a dependency, never inlined.
      const design = JSON.parse(stdout) as DesignExport;
      expect(design.components).toEqual([]);
      expect(design.dependencies.map((d) => [d.alias, d.role])).toEqual([['core', 'member']]);
      // ...and the empty-looking export says why, on stderr only.
      expect(stderr).toMatch(/1 member project\(s\) are listed under `dependencies`, not inlined \(core\): run `wairon export` in a member's own root/);

      // With --out the report names the member too.
      stdout = '';
      await runExport(path.join(out, 'top.json'));
      expect(stdout).toContain('0 component(s)');
      expect(stdout).toMatch(/1 member project\(s\) are listed under `dependencies`/);
    });

    it('refuses a repository with no spec tree', async () => {
      fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
      setProjectRoot(root);
      invalidateSpecCache();
      await expect(runExport()).rejects.toThrow(WaironError);
      await expect(runExport()).rejects.toThrow(/Nothing to export: there is no SDD spec tree here/);
      expect(stdout).toBe('');
    });
  });
});
