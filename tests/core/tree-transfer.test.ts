import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  saveSystemSpec,
  saveSpec,
  invalidateSpecCache,
  inspectChainedRoots,
} from '../../src/core/specs.js';
import { exportSpecTree, importSpecTree } from '../../src/core/treetransfer.js';
import { declareMember } from '../../src/core/provision.js';
import { projectConfigRepositoryAt } from '../../src/config/project-config.js';
import type { SubsystemSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// Spec-tree transfer (.waitree) — the local half of local↔hosted migration.
//
// Export packs the bound root plus every chained subproject; import inspects
// before touching disk, stages, and only then swaps into place with a backup —
// so a refused or corrupt archive leaves the destination exactly as it was.
// ---------------------------------------------------------------------------

const now = new Date().toISOString();
const cleanups: string[] = [];

function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

function initProject(dir: string, systemName: string): void {
  fs.mkdirSync(path.join(dir, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.wai', 'project.yaml'), `schemaVersion: 1.0.0\nname: ${systemName}\ncreatedAt: '${now}'\nupdatedAt: '${now}'\n`);
  setProjectRoot(dir);
  invalidateSpecCache();
  saveSystemSpec({
    schemaVersion: '1.0.0',
    name: systemName,
    vision: `vision for ${systemName}`,
    boundaries: [],
    globalRequirements: [],
    createdAt: now,
    updatedAt: now,
  });
}

function subsystem(id: string, parentSystem: string, projectPath?: string): SubsystemSpec {
  return {
    id,
    name: id,
    description: `subsystem ${id}`,
    parentSystem,
    publicInterfaces: [],
    projectPath,
    trustedLinks: [],
    status: 'draft',
    createdAt: now,
    updatedAt: now,
  };
}

afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  for (const dir of cleanups.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  }
});

// The roots half of inspectChainedRoots (listChainedRoots is gone since stage 5:
// a gate identity no longer walks members, and nothing else read the list alone).
describe('inspectChainedRoots().roots', () => {
  it('returns [] for a project that chains nothing', () => {
    const root = mkTmp('wai-chain-none-');
    initProject(root, 'solo');
    expect(inspectChainedRoots().roots).toEqual([]);
  });

  it('walks nested chains, and skips a member whose directory is missing', () => {
    const root = mkTmp('wai-chain-nested-');
    initProject(root, 'parent');
    const child = path.join(root, 'packages', 'billing');
    initProject(child, 'billing');
    const grandchild = path.join(child, 'vendor', 'ledger');
    initProject(grandchild, 'ledger');

    // Re-bind to the parent and declare the chain top-down.
    setProjectRoot(child);
    invalidateSpecCache();
    declareMember('ledger', { source: 'vendor/ledger' });
    setProjectRoot(root);
    invalidateSpecCache();
    declareMember('billing', { source: 'packages/billing' });
    declareMember('ghost', { source: 'packages/missing' });

    expect(inspectChainedRoots().roots).toEqual(['packages/billing', 'packages/billing/vendor/ledger']);
  });

  it('skips a member that escapes the project root', () => {
    const base = mkTmp('wai-chain-escape-');
    const root = path.join(base, 'proj');
    initProject(root, 'contained');
    const outside = path.join(base, 'victim');
    initProject(outside, 'victim');
    setProjectRoot(root);
    invalidateSpecCache();
    // The write guard refuses to persist it, so plant the escaping member directly.
    projectConfigRepositoryAt(root).declareMember('escape', { source: '../victim' });
    invalidateSpecCache();
    expect(inspectChainedRoots().roots).toEqual([]);
  });
});

describe('exportSpecTree', () => {
  it('packs the bound tree with its content state and a project-named archive', () => {
    const root = mkTmp('wai-export-');
    initProject(root, 'Export Me');

    const result = exportSpecTree();
    expect(result.projectName).toBe('Export Me');
    expect(result.roots).toEqual(['.']);
    expect(result.suggestedFileName).toBe('export-me.waitree');
    expect(result.fileCount).toBeGreaterThan(0);
    expect(result.stateId).toMatch(/^[0-9a-f]{64}$/);
    expect(result.archive.byteLength).toBeGreaterThan(0);
  });

  it('packs every chained subproject alongside the parent', () => {
    const root = mkTmp('wai-export-chain-');
    initProject(root, 'parent');
    initProject(path.join(root, 'packages', 'billing'), 'billing');
    setProjectRoot(root);
    invalidateSpecCache();
    declareMember('billing', { source: 'packages/billing' });

    const result = exportSpecTree();
    expect(result.roots).toEqual(['.', 'packages/billing']);
    // A complete family: nothing was left out.
    expect(result.skipped).toEqual([]);
  });

  it('refuses to export a root that holds no spec tree', () => {
    const root = mkTmp('wai-export-empty-');
    setProjectRoot(root);
    invalidateSpecCache();
    expect(() => exportSpecTree()).toThrow(/no spec tree to export/);
  });

  it('refuses a partial export, naming the missing member, unless allowPartial is set', () => {
    const root = mkTmp('wai-export-missing-');
    initProject(root, 'parent');
    setProjectRoot(root);
    invalidateSpecCache();
    // 'ghost' declares a member whose directory was never created.
    declareMember('ghost', { source: 'packages/missing' });

    expect(() => exportSpecTree()).toThrow(/ghost/);
    expect(() => exportSpecTree()).toThrow(/missing/);

    // allowPartial builds the archive anyway and lists what was left out.
    const result = exportSpecTree(undefined, true);
    expect(result.roots).toEqual(['.']);
    expect(result.skipped).toEqual([{ mount: 'ghost', projectPath: 'packages/missing', reason: 'missing' }]);
    expect(result.archive.byteLength).toBeGreaterThan(0);
  });
});

describe('importSpecTree', () => {
  function exportFrom(name: string): Uint8Array {
    const src = mkTmp('wai-src-');
    initProject(src, name);
    return exportSpecTree().archive;
  }

  it('imports into an empty destination', () => {
    const archive = exportFrom('Imported System');
    const dest = mkTmp('wai-dest-');

    const result = importSpecTree(archive, { destDir: dest });
    expect(result.projectName).toBe('Imported System');
    expect(result.replaced).toBe(false);
    expect(result.backupPath).toBeUndefined();
    expect(result.destDir).toBe(path.resolve(dest));
    expect(fs.existsSync(path.join(dest, '.wai', 'specs', '.index.yaml'))).toBe(true);
    // The staging directory is cleaned up behind it.
    expect(fs.readdirSync(dest).filter((e) => e.startsWith('.wai-staging-'))).toEqual([]);
  });

  /** Author a subsystem into a tree, so it counts as design rather than a bootstrap. */
  function authorSubsystem(root: string, parentSystem: string): void {
    setProjectRoot(root);
    invalidateSpecCache();
    saveSpec('subsystem', subsystem('authored', parentSystem));
  }

  it('REFUSES a destination holding AUTHORED design unless replaceExisting is set', () => {
    const archive = exportFrom('Incoming');
    const dest = mkTmp('wai-occupied-');
    initProject(dest, 'Existing');
    authorSubsystem(dest, 'Existing');

    expect(() => importSpecTree(archive, { destDir: dest })).toThrow(/already holds an authored spec tree/);
    // Untouched: the refusal happens before anything is staged or written.
    expect(fs.readFileSync(path.join(dest, '.wai', 'project.yaml'), 'utf8')).toContain('Existing');
    expect(fs.readdirSync(dest).filter((e) => e.startsWith('.wai-staging-'))).toEqual([]);
  });

  it('imports over a BOOTSTRAP tree without an override — an empty L0 is not a design', () => {
    const archive = exportFrom('Incoming');
    const dest = mkTmp('wai-bootstrap-');
    initProject(dest, 'Freshly Provisioned'); // project.yaml + an empty L0 spec, nothing authored

    const result = importSpecTree(archive, { destDir: dest });
    expect(result.projectName).toBe('Incoming');
    // Still backed up: the guard relaxes the REFUSAL, never the preservation.
    expect(result.replaced).toBe(true);
    expect(result.backupPath).toBeTruthy();
    expect(fs.readFileSync(path.join(dest, '.wai', 'project.yaml'), 'utf8')).toContain('Incoming');
  });

  it('replaces an occupied destination and backs the previous tree up', () => {
    const archive = exportFrom('Incoming');
    const dest = mkTmp('wai-replace-');
    initProject(dest, 'Existing');
    const marker = path.join(dest, '.wai', 'specs', 'subsystems', 'old.yaml');
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, 'id: old\n');

    const result = importSpecTree(archive, { destDir: dest, replaceExisting: true });
    expect(result.replaced).toBe(true);
    expect(result.backupPath).toBeTruthy();

    // The new tree is live...
    expect(fs.readFileSync(path.join(dest, '.wai', 'project.yaml'), 'utf8')).toContain('Incoming');
    expect(fs.existsSync(marker)).toBe(false);
    // ...and the previous one is recoverable by moving one directory back.
    const backedUp = path.join(result.backupPath!, '.wai', 'specs', 'subsystems', 'old.yaml');
    expect(fs.readFileSync(backedUp, 'utf8')).toContain('old');
  });

  it('recreates a chained subproject layout at the destination', () => {
    const src = mkTmp('wai-chain-src-');
    initProject(src, 'parent');
    initProject(path.join(src, 'packages', 'billing'), 'billing');
    setProjectRoot(src);
    invalidateSpecCache();
    declareMember('billing', { source: 'packages/billing' });
    const archive = exportSpecTree().archive;

    const dest = mkTmp('wai-chain-dest-');
    const result = importSpecTree(archive, { destDir: dest });
    expect(result.roots).toEqual(['.', 'packages/billing']);
    expect(fs.readFileSync(path.join(dest, 'packages', 'billing', '.wai', 'project.yaml'), 'utf8'))
      .toContain('billing');
  });

  it('leaves the destination untouched when extraction is refused, and cleans up staging', () => {
    const dest = mkTmp('wai-refused-');
    initProject(dest, 'Existing');
    const before = fs.readFileSync(path.join(dest, '.wai', 'project.yaml'), 'utf8');

    // Not a .waitree at all — the failure lands during extraction, after staging.
    const notATree = Buffer.from('PK definitely not a tree archive');
    expect(() => importSpecTree(notATree, { destDir: dest, replaceExisting: true })).toThrow();

    expect(fs.readFileSync(path.join(dest, '.wai', 'project.yaml'), 'utf8')).toBe(before);
    expect(fs.readdirSync(dest).filter((e) => e.startsWith('.wai-staging-'))).toEqual([]);
  });

  it('round-trips a tree whose specs are readable again from the imported root', () => {
    const archive = exportFrom('Round Trip');
    const dest = mkTmp('wai-roundtrip-');
    importSpecTree(archive, { destDir: dest });

    // Bind the destination and read the tree back through the normal loader —
    // the import invalidated the cache, so this is not a stale hit.
    setProjectRoot(dest);
    const config = fs.readFileSync(path.join(dest, '.wai', 'project.yaml'), 'utf8');
    expect(config).toContain('Round Trip');
    expect(exportSpecTree().projectName).toBe('Round Trip');
  });
});
