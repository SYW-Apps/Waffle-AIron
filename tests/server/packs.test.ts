import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { invalidateSpecCache } from '../../src/core/specs.js';
import * as admin from '../../src/server/admin.js';
import { AdminAuthError } from '../../src/server/admin.js';
import { UnauthenticatedError } from '../../src/server/errors.js';
import * as packs from '../../src/server/packs.js';
import { createPlacedProject, mintUserToken } from './helpers.js';
import { loadProjectConfig } from '../../src/core/index.js';
import { runWithProjectRoot } from '../../src/utils/fs.js';
import { readYamlFile, writeYamlFile } from '../../src/utils/yaml.js';
import type { HostConfig } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Integration test for hosted extension-pack management (sdd_host). Exercises
// the pack orchestrator + registry directly: declarative install/list/remove at
// both server-global and project scope, the declarative-only guard, pack-name
// sanitization, admin-credential rejection, and data-volume persistence.
// ---------------------------------------------------------------------------

const ADMIN = 'test-admin-secret';

const DECLARATIVE_PACK = [
  'name: acme-doctrine',
  'profiles:',
  '  ddd:',
  '    family: backend-like',
  '    forbiddenStereotypes:',
  '      - types: [Portal]',
  '        reason: the domain layer must stay transport-free',
  'languages:',
  '  rust:',
  '    unsupportedFlow: {}',
  '    foreignBuiltins: []',
  '',
].join('\n');

/** The entries a project's configuration registers under extensions.packs. */
function registeredPacks(root: string): unknown[] {
  return runWithProjectRoot(root, () => loadProjectConfig())?.extensions?.packs ?? [];
}

describe('hosted pack management (sdd_host)', () => {
  let base: string;
  let dataDir: string;
  let cfg: HostConfig;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    invalidateSpecCache();
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-packs-it-'));
    dataDir = path.join(base, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    process.env.WAIRON_ADMIN_TOKEN = ADMIN;
    process.env.WAIRON_PACKS_DIR = path.join(dataDir, 'packs');
    // Isolate the image tier too: a populated /opt/wairon/packs on the host
    // must never leak into these instance-tier assertions.
    process.env.WAIRON_IMAGE_PACKS_DIR = path.join(dataDir, 'image-packs');
    cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true };
  });

  afterEach(() => {
    invalidateSpecCache();
    process.env = { ...savedEnv };
    try {
      fs.rmSync(base, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  describe('server-global scope', () => {
    it('installs a declarative pack onto the data volume, lists it with counts, and removes it', () => {
      const desc = packs.installGlobalPack(cfg, ADMIN, 'acme', DECLARATIVE_PACK);
      expect(desc.name).toBe('acme-doctrine');
      expect(desc.scope).toBe('global');
      expect(desc.profiles).toBe(1);
      expect(desc.languages).toBe(1);
      expect(desc.rules).toBe(0);
      expect(desc.error).toBeUndefined();
      // persisted under the data volume (survives container recreation)
      expect(fs.existsSync(path.join(dataDir, 'packs', 'acme.yaml'))).toBe(true);

      expect(packs.listGlobalPacks(cfg, ADMIN).map((p) => p.name)).toContain('acme-doctrine');

      packs.removeGlobalPack(cfg, ADMIN, 'acme');
      expect(packs.listGlobalPacks(cfg, ADMIN)).toHaveLength(0);
    });

    it('refuses a non-declarative (code-shaped) pack, pointing to the filesystem path', () => {
      expect(() => packs.installGlobalPack(cfg, ADMIN, 'evil', 'module.exports = { rules: [] }')).toThrow(/declarative pack/i);
      // a YAML body missing the required name is not a valid declarative pack either
      expect(() => packs.installGlobalPack(cfg, ADMIN, 'noname', 'profiles: {}')).toThrow(/declarative pack/i);
      expect(fs.existsSync(path.join(dataDir, 'packs', 'evil.yaml'))).toBe(false);
    });

    it('rejects an unsafe pack name (path traversal)', () => {
      expect(() => packs.installGlobalPack(cfg, ADMIN, '../escape', DECLARATIVE_PACK)).toThrow(/Invalid pack name/);
    });

    it('rejects a bad credential (401) and an authenticated non-admin (403) before any effect', () => {
      // An unknown credential is unauthenticated under the resolver model.
      expect(() => packs.installGlobalPack(cfg, 'wrong', 'acme', DECLARATIVE_PACK)).toThrow(UnauthenticatedError);
      expect(() => packs.listGlobalPacks(cfg, null)).toThrow(UnauthenticatedError);
      // An authenticated caller WITHOUT instance-level project:admin is refused.
      const plain = mintUserToken(dataDir, { id: 'k-plain', userId: 'u-plain' });
      expect(() => packs.installGlobalPack(cfg, plain, 'acme', DECLARATIVE_PACK)).toThrow(AdminAuthError);
      expect(fs.existsSync(path.join(dataDir, 'packs', 'acme.yaml'))).toBe(false);
    });
  });

  describe('project scope', () => {
    it('vendors the pack into .wai/packs, registers it in project.yaml, lists it, and removes it', () => {
      createPlacedProject(cfg, ADMIN, 'demo');

      const desc = packs.installProjectPack(cfg, ADMIN, 'demo', 'acme', DECLARATIVE_PACK);
      expect(desc.scope).toBe('project');
      expect(desc.profiles).toBe(1);

      const root = path.join(dataDir, 'projects', 'demo');
      expect(fs.existsSync(path.join(root, '.wai', 'packs', 'acme.yaml'))).toBe(true);
      expect(registeredPacks(root)).toContain('.wai/packs/acme.yaml');

      expect(packs.listProjectPacks(cfg, ADMIN, 'demo').map((p) => p.name)).toContain('acme-doctrine');

      packs.removeProjectPack(cfg, ADMIN, 'demo', 'acme');
      expect(fs.existsSync(path.join(root, '.wai', 'packs', 'acme.yaml'))).toBe(false);
      expect(registeredPacks(root)).not.toContain('.wai/packs/acme.yaml');
    });

    it('registers a project pack exactly once, even when it is installed again', () => {
      createPlacedProject(cfg, ADMIN, 'demo');
      const root = path.join(dataDir, 'projects', 'demo');

      const first = packs.installProjectPack(cfg, ADMIN, 'demo', 'acme', DECLARATIVE_PACK);
      const again = packs.installProjectPack(cfg, ADMIN, 'demo', 'acme', DECLARATIVE_PACK);

      // The registry's ref is the path reference the orchestrator registered.
      expect(first.ref).toBe('.wai/packs/acme.yaml');
      expect(again.ref).toBe('.wai/packs/acme.yaml');
      expect(registeredPacks(root).filter((entry) => entry === '.wai/packs/acme.yaml')).toHaveLength(1);
    });

    it('removal deregisters the kind it matched: a selection by its name, a path reference by that reference', () => {
      createPlacedProject(cfg, ADMIN, 'demo');
      const root = path.join(dataDir, 'projects', 'demo');
      packs.installProjectPack(cfg, ADMIN, 'demo', 'acme', DECLARATIVE_PACK);

      // Beside the path reference, a by-name selection with its bundle directory.
      const file = path.join(root, '.wai', 'project.yaml');
      const raw = readYamlFile(file) as { extensions: { packs: unknown[] } };
      raw.extensions.packs.push({ name: 'tenant' });
      writeYamlFile(file, raw);
      fs.mkdirSync(path.join(root, '.wai', 'packs', 'tenant'), { recursive: true });
      fs.writeFileSync(path.join(root, '.wai', 'packs', 'tenant', 'pack.yaml'), 'name: tenant\n');

      // The selection goes, with its bundle directory; the path reference stays.
      packs.removeProjectPack(cfg, ADMIN, 'demo', 'tenant');
      expect(registeredPacks(root)).toEqual(['.wai/packs/acme.yaml']);
      expect(fs.existsSync(path.join(root, '.wai', 'packs', 'tenant'))).toBe(false);
      expect(fs.existsSync(path.join(root, '.wai', 'packs', 'acme.yaml'))).toBe(true);

      // The path reference goes next, matched by its file stem.
      packs.removeProjectPack(cfg, ADMIN, 'demo', 'acme');
      expect(registeredPacks(root)).toEqual([]);
      expect(fs.existsSync(path.join(root, '.wai', 'packs', 'acme.yaml'))).toBe(false);

      // A name nothing registers is refused, with the message removal always gave.
      expect(() => packs.removeProjectPack(cfg, ADMIN, 'demo', 'ghost')).toThrow('Project has no registered pack named "ghost".');
    });

    it('rejects operations on an unknown project', () => {
      expect(() => packs.listProjectPacks(cfg, ADMIN, 'ghost')).toThrow(/Unknown project/);
    });
  });
});
