import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadProjectExtensions, packEntryLabel, packEntryRef, diagnoseProjectPacks, pinInstalledPacksAsSelections } from '../../src/core/extensions.js';
import { installPackFromDirectory, uninstallPack } from '../../src/core/packstore.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { expandSource } from '../../src/commands/packs.js';

// ---------------------------------------------------------------------------
// Pack SELECTION (A2) — the project declares which packs apply, by name.
//
// The pack lives in the machine's store (or a committed bundle); the project
// states what it wants. The load-bearing behaviour is the failure mode: a
// declared pack that cannot be resolved is an ERROR carried on the same channel
// as a pack that fails to parse, so validate/status/lock/MCP all refuse rather
// than quietly enforcing a weaker rule set than the project asked for.
// ---------------------------------------------------------------------------

const created: string[] = [];

function packSource(name: string, version: string, extra = ''): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-selsrc-'));
  created.push(dir);
  fs.writeFileSync(path.join(dir, 'pack.yaml'),
    `name: ${name}\nversion: ${version}\nprofiles:\n  ${name}-profile:\n    family: neutral\n${extra}`);
  return dir;
}

function project(packs: unknown[]) {
  invalidateSpecCache();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-sel-'));
  created.push(dir);
  fs.mkdirSync(path.join(dir, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.wai', 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0',
    name: 'sel-project',
    projectType: 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {},
    extensions: { useGlobalPacks: false, packs },
    createdAt: '2026-07-03T10:00:00Z',
    updatedAt: '2026-07-03T10:00:00Z',
  }));
  vi.spyOn(process, 'cwd').mockReturnValue(dir);
  return dir;
}

/** Commit a pack under .wai/packs/<name>/<version>/ — the bundle form. */
function bundle(projectDir: string, name: string, version: string): void {
  const dest = path.join(projectDir, '.wai', 'packs', name, version);
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'pack.yaml'),
    `name: ${name}\nversion: ${version}\nprofiles:\n  bundled-profile:\n    family: neutral\n`);
}

function store(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-selstore-'));
  created.push(dir);
  process.env.WAIRON_PACKS_DIR = dir;
  return dir;
}

afterEach(() => {
  delete process.env.WAIRON_PACKS_DIR;
  invalidateSpecCache();
  vi.restoreAllMocks();
  for (const dir of created.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* win file locks */ }
  }
});

describe('a selection resolves against the store', () => {
  it('applies the selected pack\'s doctrine', () => {
    store();
    installPackFromDirectory(packSource('demo', '1.2.0'));
    project([{ name: 'demo' }]);

    const ext = loadProjectExtensions();
    expect(ext.errors).toEqual([]);
    expect(ext.packNames).toEqual(['demo']);
    expect(Object.keys(ext.profiles)).toContain('demo-profile');
  });

  it('takes the latest installed version when unpinned', () => {
    store();
    installPackFromDirectory(packSource('demo', '1.2.0'));
    installPackFromDirectory(packSource('demo', '1.10.0', 'guarantees: [newer-token]\n'));
    project([{ name: 'demo' }]);

    expect(loadProjectExtensions().guarantees).toContain('newer-token');
  });

  it('honours an exact version pin over the newer install', () => {
    store();
    installPackFromDirectory(packSource('demo', '1.2.0'));
    installPackFromDirectory(packSource('demo', '1.10.0', 'guarantees: [newer-token]\n'));
    project([{ name: 'demo', version: '1.2.0' }]);

    const ext = loadProjectExtensions();
    expect(ext.errors).toEqual([]);
    expect(ext.guarantees).not.toContain('newer-token');
  });

  it('keeps loading legacy path refs alongside selections', () => {
    store();
    installPackFromDirectory(packSource('demo', '1.2.0'));
    const dir = project([{ name: 'demo' }, '.wai/packs/legacy.yaml']);
    fs.mkdirSync(path.join(dir, '.wai', 'packs'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.wai', 'packs', 'legacy.yaml'), 'name: legacy\nprofiles:\n  legacy-profile:\n    family: neutral\n');

    const ext = loadProjectExtensions();
    expect(ext.errors).toEqual([]);
    expect(ext.packNames.sort()).toEqual(['demo', 'legacy']);
  });
});

describe('an unresolvable selection fails LOUDLY', () => {
  it('reports a declared pack that is not installed, naming the fix', () => {
    store();
    project([{ name: 'missing-pack' }]);

    const ext = loadProjectExtensions();
    expect(ext.errors).toHaveLength(1);
    expect(ext.errors[0]).toContain('missing-pack');
    expect(ext.errors[0]).toContain('not installed');
    expect(ext.errors[0]).toContain('wairon pack install');
    // No doctrine silently applied in its place.
    expect(ext.packNames).toEqual([]);
  });

  it('names the recorded source in the fix instructions', () => {
    store();
    project([{ name: 'missing-pack', source: 'https://example.test/missing-1.0.0.wpack' }]);
    expect(loadProjectExtensions().errors[0]).toContain('https://example.test/missing-1.0.0.wpack');
  });

  it('reports a version pin that no installed version satisfies', () => {
    store();
    installPackFromDirectory(packSource('demo', '1.2.0'));
    project([{ name: 'demo', version: '9.9.9' }]);

    const ext = loadProjectExtensions();
    expect(ext.errors[0]).toContain('demo@9.9.9');
    expect(ext.packNames).toEqual([]);
  });

  it('refuses content that does not match a pinned integrity digest', () => {
    store();
    installPackFromDirectory(packSource('demo', '1.2.0'));
    project([{ name: 'demo', version: '1.2.0', integrity: 'sha256-0000000000000000000000000000000000000000000000000000000000000000' }]);

    const ext = loadProjectExtensions();
    expect(ext.errors).toHaveLength(1);
    expect(ext.errors[0]).toMatch(/integrity/i);
    expect(ext.packNames).toEqual([]);
  });

  it('one unresolvable selection never suppresses the packs that DID resolve', () => {
    store();
    installPackFromDirectory(packSource('good', '1.0.0'));
    project([{ name: 'good' }, { name: 'missing-pack' }]);

    const ext = loadProjectExtensions();
    expect(ext.packNames).toEqual(['good']);   // the good pack still applies
    expect(ext.errors).toHaveLength(1);        // and the gap is still reported
  });

  it('an uninstall of a selected pack turns the gate red', () => {
    store();
    installPackFromDirectory(packSource('demo', '1.2.0'));
    project([{ name: 'demo' }]);
    expect(loadProjectExtensions().errors).toEqual([]);

    uninstallPack('demo');
    expect(loadProjectExtensions().errors[0]).toContain('not installed');
  });
});

describe('a committed bundle resolves with an EMPTY store', () => {
  it('resolves from .wai/packs/<name>/<version>/ with nothing installed', () => {
    store(); // deliberately empty
    const dir = project([{ name: 'bundled', version: '2.0.0' }]);
    bundle(dir, 'bundled', '2.0.0');

    const ext = loadProjectExtensions();
    expect(ext.errors).toEqual([]);
    expect(Object.keys(ext.profiles)).toContain('bundled-profile');
  });

  it('the bundle WINS over the store — the committed copy is the truth', () => {
    store();
    installPackFromDirectory(packSource('bundled', '2.0.0', 'guarantees: [from-store]\n'));
    const dir = project([{ name: 'bundled', version: '2.0.0' }]);
    bundle(dir, 'bundled', '2.0.0');

    const ext = loadProjectExtensions();
    expect(Object.keys(ext.profiles)).toContain('bundled-profile');
    expect(ext.guarantees).not.toContain('from-store');
  });

  it('resolves an unpinned selection to the newest bundled version', () => {
    store();
    const dir = project([{ name: 'bundled' }]);
    bundle(dir, 'bundled', '2.0.0');
    bundle(dir, 'bundled', '10.0.0'); // not lexicographic

    expect(loadProjectExtensions().errors).toEqual([]);
    expect(packEntryRef({ name: 'bundled' }, dir)).toContain(path.join('bundled', '10.0.0'));
  });
});

describe('entry helpers', () => {
  it('labels both forms for display', () => {
    expect(packEntryLabel('.wai/packs/legacy.yaml')).toBe('.wai/packs/legacy.yaml');
    expect(packEntryLabel({ name: 'demo' })).toBe('demo');
    expect(packEntryLabel({ name: 'demo', version: '1.2.0' })).toBe('demo@1.2.0');
  });

  it('passes a legacy ref through untouched and returns null for an unresolvable selection', () => {
    store();
    const dir = project([]);
    expect(packEntryRef('.wai/packs/legacy.yaml', dir)).toBe('.wai/packs/legacy.yaml');
    expect(packEntryRef({ name: 'nope' }, dir)).toBeNull();
  });
});

describe('the machine-wide default is OFF (A4) and the migration is loud (A7)', () => {
  it('an installed pack does NOT apply to a project that never asked for it', () => {
    store();
    installPackFromDirectory(packSource('org-doctrine', '2.0.0'));
    // No `extensions` block at all — the shape of a project that never decided.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-a4-'));
    created.push(dir);
    fs.mkdirSync(path.join(dir, '.wai', 'specs'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.wai', 'project.yaml'), JSON.stringify({
      schemaVersion: '1.0.0', name: 'p', projectType: 'backend',
      targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }], rules: {},
      createdAt: '2026-07-03T10:00:00Z', updatedAt: '2026-07-03T10:00:00Z',
    }));
    vi.spyOn(process, 'cwd').mockReturnValue(dir);

    expect(loadProjectExtensions().packNames).toEqual([]);
  });

  it('doctor reports the unapplied pack as a migration risk, and --fix records it', () => {
    store();
    installPackFromDirectory(packSource('org-doctrine', '2.0.0'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-a7-'));
    created.push(dir);
    fs.mkdirSync(path.join(dir, '.wai', 'specs'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.wai', 'project.yaml'), JSON.stringify({
      schemaVersion: '1.0.0', name: 'p', projectType: 'backend',
      targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }], rules: {},
      createdAt: '2026-07-03T10:00:00Z', updatedAt: '2026-07-03T10:00:00Z',
    }));
    vi.spyOn(process, 'cwd').mockReturnValue(dir);

    const before = diagnoseProjectPacks();
    expect(before.globalsUndeclared).toBe(true);           // never decided
    expect(before.notApplied.map((p) => p.name)).toEqual(['org-doctrine']);

    // --fix converts the implicit past into an explicit, reproducible present.
    expect(pinInstalledPacksAsSelections()).toEqual(['org-doctrine@2.0.0']);
    expect(loadProjectExtensions().packNames).toEqual(['org-doctrine']);

    const after = diagnoseProjectPacks();
    expect(after.notApplied).toEqual([]);
    expect(after.globalsUndeclared).toBe(false);           // the decision is recorded
  });

  it('never invents selections for a project that DELIBERATELY applies nothing', () => {
    store();
    installPackFromDirectory(packSource('org-doctrine', '2.0.0'));
    project([]); // writes useGlobalPacks: false explicitly

    expect(diagnoseProjectPacks().globalsUndeclared).toBe(false);
    expect(pinInstalledPacksAsSelections()).toEqual([]);
    expect(loadProjectExtensions().packNames).toEqual([]);
  });

  it('still applies machine-wide packs when a project opts IN explicitly', () => {
    const dir = store();
    installPackFromDirectory(packSource('org-doctrine', '2.0.0'));
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-a4in-'));
    created.push(proj);
    fs.mkdirSync(path.join(proj, '.wai', 'specs'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.wai', 'project.yaml'), JSON.stringify({
      schemaVersion: '1.0.0', name: 'p', projectType: 'backend',
      targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }], rules: {},
      extensions: { useGlobalPacks: true, packs: [] },
      createdAt: '2026-07-03T10:00:00Z', updatedAt: '2026-07-03T10:00:00Z',
    }));
    vi.spyOn(process, 'cwd').mockReturnValue(proj);
    void dir;

    expect(loadProjectExtensions().packNames).toEqual(['org-doctrine']);
    // Opting in is legal but the doctrine does not travel — doctor says so.
    expect(diagnoseProjectPacks().globalsApplied.map((p) => p.name)).toEqual(['org-doctrine']);
  });
});

describe('source expansion (what `pack sync` fetches)', () => {
  it('substitutes the pinned version into a {version} template', () => {
    expect(expandSource('https://h/rel/download/v{version}/p-{version}.wpack', '1.2.0'))
      .toBe('https://h/rel/download/v1.2.0/p-1.2.0.wpack');
  });

  it('leaves a source with no placeholders alone — the floating-latest form', () => {
    // GitHub resolves "latest" with no API call and no token, so an unpinned
    // selection needs no substitution at all.
    const url = 'https://github.com/org/appenser/releases/latest/download/appenser.wpack';
    expect(expandSource(url)).toBe(url);
  });

  it('expands ${VAR} from the environment, so a private URL keeps its token out of the repo', () => {
    process.env.WAIRON_TEST_PACK_TOKEN = 'secret-value';
    try {
      expect(expandSource('https://${WAIRON_TEST_PACK_TOKEN}@git.internal/p.wpack'))
        .toBe('https://secret-value@git.internal/p.wpack');
    } finally {
      delete process.env.WAIRON_TEST_PACK_TOKEN;
    }
  });

  it('expands an unset ${VAR} to empty rather than leaving the literal in a URL', () => {
    delete process.env.WAIRON_TEST_ABSENT;
    expect(expandSource('https://${WAIRON_TEST_ABSENT}host/p.wpack')).toBe('https://host/p.wpack');
  });
});
