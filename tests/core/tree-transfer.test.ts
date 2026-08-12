import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  saveSystemSpec,
  saveSubsystemSpec,
  invalidateSpecCache,
  listChainedRoots,
} from '../../src/core/specs.js';
import { exportSpecTree, importSpecTree } from '../../src/core/treetransfer.js';
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
  fs.writeFileSync(path.join(dir, '.wai', 'project.yaml'), `schemaVersion: 1.0.0\nname: ${systemName}\n`);
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

describe('listChainedRoots', () => {
  it('returns [] for a project that chains nothing', () => {
    const root = mkTmp('wai-chain-none-');
    initProject(root, 'solo');
    expect(listChainedRoots()).toEqual([]);
  });

  it('walks nested chains, and skips a mount whose directory is missing', () => {
    const root = mkTmp('wai-chain-nested-');
    initProject(root, 'parent');
    const child = path.join(root, 'packages', 'billing');
    initProject(child, 'billing');
    const grandchild = path.join(child, 'vendor', 'ledger');
    initProject(grandchild, 'ledger');

    // Re-bind to the parent and declare the chain top-down.
    setProjectRoot(child);
    invalidateSpecCache();
    saveSubsystemSpec(subsystem('ledger', 'billing', 'vendor/ledger'));
    setProjectRoot(root);
    invalidateSpecCache();
    saveSubsystemSpec(subsystem('billing', 'parent', 'packages/billing'));
    saveSubsystemSpec(subsystem('ghost', 'parent', 'packages/missing'));

    expect(listChainedRoots()).toEqual(['packages/billing', 'packages/billing/vendor/ledger']);
  });

  it('skips a mount that escapes the project root', () => {
    const base = mkTmp('wai-chain-escape-');
    const root = path.join(base, 'proj');
    initProject(root, 'contained');
    const outside = path.join(base, 'victim');
    initProject(outside, 'victim');
    setProjectRoot(root);
    invalidateSpecCache();
    // The write guard refuses to persist it, so plant the escaping mount directly.
    fs.mkdirSync(path.join(root, '.wai', 'specs', 'subsystems'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.wai', 'specs', 'subsystems', 'escape.yaml'),
      `id: escape\nname: escape\ndescription: escaping mount\nparentSystem: contained\n` +
        `publicInterfaces: []\ntrustedLinks: []\nstatus: draft\nprojectPath: ../victim\n` +
        `createdAt: '${now}'\nupdatedAt: '${now}'\n`,
    );
    expect(listChainedRoots()).toEqual([]);
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
    saveSubsystemSpec(subsystem('billing', 'parent', 'packages/billing'));

    expect(exportSpecTree().roots).toEqual(['.', 'packages/billing']);
  });

  it('refuses to export a root that holds no spec tree', () => {
    const root = mkTmp('wai-export-empty-');
    setProjectRoot(root);
    invalidateSpecCache();
    expect(() => exportSpecTree()).toThrow(/no spec tree to export/);
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
    saveSubsystemSpec(subsystem('authored', parentSystem));
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
    saveSubsystemSpec(subsystem('billing', 'parent', 'packages/billing'));
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
