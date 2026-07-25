import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { loadProjectConfig } from '../../src/config/loader.js';
import { validateSddTree } from '../../src/core/validation.js';
import { runWithProjectRoot } from '../../src/utils/fs.js';
import { hostCore } from '../../src/server/adapters.js';
import { installGlobalPack } from '../../src/server/packs.js';
import { setProjectType, getProjectConfig } from '../../src/server/policy.js';
import { createPlacedProject } from './helpers.js';
import type { HostConfig } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Stage D acceptance test: a selected profile must actually GOVERN the project.
//
// Every other test in this area proves a step of the chain — the catalog tags
// the right tier, the ensure seam vendors the contributing pack, the write path
// records what it applied. None of them proves the thing that was actually
// broken: that after picking a PACK-provided profile, the validator enforces
// that profile's doctrine inside the project.
//
// That is the whole bug. Before this stage, writing a pack profile as the
// projectType left `ctx.ext.profiles[projectType]` undefined whenever the
// contributing pack was not registered in THAT project: the profile silently
// degraded to family 'neutral', its rules block (designDepth, severities,
// naming, complexity) never applied, and the only trace was an UNKNOWN_PROFILE
// warning nobody was looking at. So this test drives the hosted write path and
// then reads the VALIDATOR's verdict through the same path the hosted data
// plane uses (project config -> validateSddTree with its rules + projectType).
// ---------------------------------------------------------------------------

const ADMIN = 'test-admin-secret';

// A server-global pack whose profile carries real doctrine: it FORBIDS the Actor
// stereotype. Enforcement of that one rule is the observable proof the profile
// is in force — it can only fire if the pack loaded AND the profile governs.
// The file stem ('strict') deliberately differs from the manifest name.
const STRICT_PACK = [
  'name: strict-doctrine',
  'profiles:',
  '  strict-actorless:',
  '    family: backend-like',
  '    forbiddenStereotypes:',
  '      - types: [Actor]',
  '        reason: this platform has no long-lived actors — model async work as scheduled work',
  '',
].join('\n');

describe('Stage D — a selected pack profile actually governs the project (sdd_host)', () => {
  let base: string;
  let dataDir: string;
  let cfg: HostConfig;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    invalidateSpecCache();
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-governs-it-'));
    dataDir = path.join(base, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    process.env.WAIRON_ADMIN_TOKEN = ADMIN;
    process.env.WAIRON_PACKS_DIR = path.join(dataDir, 'packs');
    // Isolate the image tier — a populated /opt/wairon/packs on the host must
    // never leak in and resolve the profile for the wrong reason.
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

  const projectRoot = (projectId: string): string => path.join(dataDir, 'projects', projectId);

  /** Write one L2 Actor component into the project's spec tree, under a subsystem
   *  parented to whatever the provisioned L0 is actually called. An Actor is the
   *  stereotype the seeded profile forbids, so it is the probe for enforcement. */
  function seedActorComponent(projectId: string): void {
    const root = projectRoot(projectId);
    const systemName = runWithProjectRoot(root, () => hostCore.loadSystemSpec()?.name);
    expect(systemName).toBeTruthy(); // a provisioned project always has an L0

    const stamp = "createdAt: '2026-07-25T00:00:00Z'\nupdatedAt: '2026-07-25T00:00:00Z'";
    const specs = path.join(root, '.wai', 'specs');
    fs.mkdirSync(path.join(specs, 'sub_a', 'worker_a'), { recursive: true });
    fs.writeFileSync(
      path.join(specs, 'sub_a', '.index.yaml'),
      `schemaVersion: 1.0.0\nid: sub_a\nname: SubA\ndescription: a seeded subsystem\nparentSystem: ${systemName}\n${stamp}\n`,
    );
    fs.writeFileSync(
      path.join(specs, 'sub_a', 'worker_a', '.index.yaml'),
      `schemaVersion: 1.0.0\nid: worker_a\nname: worker_a\ndescription: a seeded actor\nsubsystem: sub_a\ncomponentType: Actor\n${stamp}\n`,
    );
    invalidateSpecCache();
  }

  /** Validate the project EXACTLY as the hosted data plane does: bind the
   *  project root, read its own config, and pass that config's rules +
   *  projectType into the validator (see the sdd_validate_tree tool path). */
  function validateAsHosted(projectId: string): { codes: string[]; specIdsFor: (code: string) => (string | undefined)[] } {
    return runWithProjectRoot(projectRoot(projectId), () => {
      invalidateSpecCache();
      const config = loadProjectConfig();
      const res = validateSddTree({ rules: config.rules, projectType: config.projectType });
      return {
        codes: res.issues.map((i) => i.code),
        specIdsFor: (code: string) => res.issues.filter((i) => i.code === code).map((i) => i.specId),
      };
    });
  }

  it('enforces an ADOPTED pack profile: the doctrine is inert before the write and in force after', () => {
    installGlobalPack(cfg, ADMIN, 'strict', STRICT_PACK); // server-global only — NOT in the project
    createPlacedProject(cfg, ADMIN, 'demo');
    seedActorComponent('demo');

    // BEFORE: the project runs on the default profile, which forbids nothing.
    // The pack exists on the instance but is not registered in this project, so
    // its doctrine cannot reach the tree.
    const before = validateAsHosted('demo');
    expect(before.codes).not.toContain('PROFILE_FORBIDDEN_STEREOTYPE');
    expect(before.codes).not.toContain('UNKNOWN_PROFILE');

    // THE WRITE: pick the pack-provided profile. The write path vendors the
    // contributing pack into the project so the id it writes really resolves.
    const view = setProjectType(cfg, ADMIN, 'demo', 'strict-actorless');
    expect(view.projectType).toBe('strict-actorless');
    expect(view.adoptedPackName).toBe('strict-doctrine');
    expect(view.profileSource).toBe('strict-doctrine');
    expect(view.profileResolvable).toBe(true);

    // AFTER: the profile's OWN doctrine is enforced against the tree — the
    // forbidden stereotype fires on the seeded Actor. This is the assertion the
    // whole stage exists for: a pack profile that genuinely governs.
    const after = validateAsHosted('demo');
    expect(after.codes).toContain('PROFILE_FORBIDDEN_STEREOTYPE');
    // On the seeded Actor specifically — so the finding is the profile's own
    // doctrine hitting a real component, not an unrelated tree complaint.
    expect(after.specIdsFor('PROFILE_FORBIDDEN_STEREOTYPE')).toContain('worker_a');

    // And it is enforced for the RIGHT reason: the profile resolved. An
    // UNKNOWN_PROFILE here would mean the projectType named a profile no loaded
    // pack carries — exactly the silent degradation this stage removes.
    expect(after.codes).not.toContain('UNKNOWN_PROFILE');
  });

  it('never leaves a project governed by a profile it cannot resolve', () => {
    createPlacedProject(cfg, ADMIN, 'demo');
    seedActorComponent('demo');

    // The instance carries no such profile in any tier: refused outright rather
    // than written as a name that would quietly disable the doctrine.
    expect(() => setProjectType(cfg, ADMIN, 'demo', 'strict-actorless')).toThrow(/strict-actorless/);

    // The project is untouched and still governed by a profile that resolves,
    // so validation reports no UNKNOWN_PROFILE.
    const view = getProjectConfig(cfg, ADMIN, 'demo');
    expect(view.projectType).not.toBe('strict-actorless');
    expect(view.profileResolvable).toBe(true);
    expect(validateAsHosted('demo').codes).not.toContain('UNKNOWN_PROFILE');
  });
});
