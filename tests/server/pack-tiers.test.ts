import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  storeListGlobalPacks,
  installGlobalPack,
  removeGlobalPack,
  readProjectReferences,
} from '../../src/server/packs.js';
import type { HostConfig, PackDescriptor } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Pack Registry — two-tier server-global store (sdd_host). Exercises the merge
// of the immutable image tier (WAIRON_IMAGE_PACKS_DIR) and the mutable instance
// tier (WAIRON_PACKS_DIR): tier tagging, instance-wins shadowing, install/remove
// confined to the instance tier (removal re-exposes a shadowed image pack), an
// absent image tier, and the path-free readProjectReferences drift read.
// ---------------------------------------------------------------------------

const MASTER = 'master-credential-secret-value';
// cfg is unused by the server-global entries (they authorize by credential only).
const cfg = {
  host: '127.0.0.1',
  port: 0,
  adminHost: '127.0.0.1',
  adminPort: 0,
  dataDir: '/unused',
  authEnabled: true,
} as HostConfig;

function packYaml(name: string): string {
  return `name: ${name}\nprofiles: {}\nlanguages: {}\n`;
}

describe('pack registry — two-tier server-global store (sdd_host)', () => {
  let imageDir: string;
  let instanceDir: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    imageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-packs-image-'));
    instanceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-packs-inst-'));
    process.env.WAIRON_ADMIN_TOKEN = MASTER;
    process.env.WAIRON_IMAGE_PACKS_DIR = imageDir;
    process.env.WAIRON_PACKS_DIR = instanceDir;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    for (const dir of [imageDir, instanceDir]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* windows file locks */
      }
    }
  });

  const seedImage = (name: string): void => fs.writeFileSync(path.join(imageDir, `${name}.yaml`), packYaml(name));
  const seedInstance = (name: string): void => fs.writeFileSync(path.join(instanceDir, `${name}.yaml`), packYaml(name));

  const pick = (list: PackDescriptor[], tier: string, name: string): PackDescriptor | undefined =>
    list.find((d) => d.tier === tier && d.name === name);

  it('discovers image-tier packs, tagged tier="image" and un-shadowed', () => {
    seedImage('img-pack');
    const list = storeListGlobalPacks();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('img-pack');
    expect(list[0].scope).toBe('global');
    expect(list[0].tier).toBe('image');
    expect(list[0].shadowed).toBeFalsy();
  });

  it('merges both tiers; the instance pack wins a name collision and the image copy is marked shadowed', () => {
    seedImage('shared');
    seedImage('img-only');
    seedInstance('shared');
    seedInstance('inst-only');

    const list = storeListGlobalPacks();
    expect(list).toHaveLength(4); // the union carries BOTH copies of "shared"

    expect(pick(list, 'instance', 'shared')!.shadowed).toBeFalsy(); // the effective copy
    expect(pick(list, 'image', 'shared')!.shadowed).toBe(true); // shadowed by the instance copy
    expect(pick(list, 'image', 'img-only')!.shadowed).toBeFalsy();
    expect(pick(list, 'instance', 'inst-only')!.shadowed).toBeFalsy();
  });

  it('install writes the instance tier only; remove deletes it and re-exposes the shadowed image pack', () => {
    seedImage('foo'); // an image pack projects may depend on
    expect(storeListGlobalPacks().filter((d) => d.name === 'foo')).toHaveLength(1);

    const installed = installGlobalPack(cfg, MASTER, 'foo', packYaml('foo'));
    expect(installed.tier).toBe('instance');
    expect(fs.existsSync(path.join(instanceDir, 'foo.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(imageDir, 'foo.yaml'))).toBe(true); // image untouched

    let foo = storeListGlobalPacks().filter((d) => d.name === 'foo');
    expect(foo).toHaveLength(2);
    expect(pick(foo, 'instance', 'foo')!.shadowed).toBeFalsy();
    expect(pick(foo, 'image', 'foo')!.shadowed).toBe(true);

    removeGlobalPack(cfg, MASTER, 'foo');
    expect(fs.existsSync(path.join(instanceDir, 'foo.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(imageDir, 'foo.yaml'))).toBe(true); // image tier is immutable

    foo = storeListGlobalPacks().filter((d) => d.name === 'foo');
    expect(foo).toHaveLength(1);
    expect(foo[0].tier).toBe('image');
    expect(foo[0].shadowed).toBeFalsy(); // the image pack is re-exposed as effective
  });

  it('remove refuses a pack that lives only in the immutable image tier', () => {
    seedImage('baked-only');
    expect(() => removeGlobalPack(cfg, MASTER, 'baked-only')).toThrow(/immutable image-layer/i);
    expect(fs.existsSync(path.join(imageDir, 'baked-only.yaml'))).toBe(true);
  });

  it('an absent image directory yields an empty image tier — instance discovery is unchanged', () => {
    process.env.WAIRON_IMAGE_PACKS_DIR = path.join(imageDir, 'nonexistent');
    seedInstance('inst-pack');
    const list = storeListGlobalPacks();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('inst-pack');
    expect(list[0].tier).toBe('instance');
    expect(list[0].shadowed).toBeFalsy();
  });
});

describe('pack registry — readProjectReferences (sdd_host)', () => {
  let projectsRoot: string;

  beforeEach(() => {
    projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-refs-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(projectsRoot, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  /** Create an isolated project root, optionally seeding a raw .wai/project.yaml. */
  function makeProjectRoot(id: string, projectYaml?: string): string {
    const root = path.join(projectsRoot, id);
    if (projectYaml !== undefined) {
      fs.mkdirSync(path.join(root, '.wai'), { recursive: true });
      fs.writeFileSync(path.join(root, '.wai', 'project.yaml'), projectYaml);
    } else {
      fs.mkdirSync(root, { recursive: true });
    }
    return root;
  }

  it('unions extensions.packs (by stem) with the profileSelection pack names and carries the profile ids', () => {
    const root = makeProjectRoot(
      'proj-full',
      [
        'extensions:',
        '  packs:',
        '    - .wai/packs/vendored.yaml',
        'profileSelection:',
        '  requiredPackNames: [req-pack]',
        '  defaultPackNames: [def-pack]',
        '  profileIds: [prof-1]',
        "  selectedAt: ''",
        '',
      ].join('\n'),
    );

    const ref = readProjectReferences(root);
    expect(ref.projectId).toBe('proj-full');
    expect(ref.packNames.sort()).toEqual(['def-pack', 'req-pack', 'vendored']);
    expect(ref.profileIds).toEqual(['prof-1']);
  });

  it('reads references from extensions.packs alone when no profile selection is recorded', () => {
    const root = makeProjectRoot(
      'proj-vendored',
      ['extensions:', '  packs:', '    - .wai/packs/only-vendored.yaml', ''].join('\n'),
    );

    const ref = readProjectReferences(root);
    expect(ref.projectId).toBe('proj-vendored');
    expect(ref.packNames).toEqual(['only-vendored']);
    expect(ref.profileIds).toBeUndefined();
  });

  it('returns an empty, path-free reference (never throws) when the project has no config', () => {
    const root = makeProjectRoot('proj-empty'); // no .wai/project.yaml

    const ref = readProjectReferences(root);
    expect(ref.projectId).toBe('proj-empty');
    expect(ref.packNames).toEqual([]);
    expect(ref.profileIds).toBeUndefined();
  });
});
