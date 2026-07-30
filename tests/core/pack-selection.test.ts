import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadProjectExtensions, packEntryLabel, packEntryRef, diagnoseProjectPacks, pinInstalledPacksAsSelections } from '../../src/core/extensions.js';
import { installPackFromDirectory, uninstallPack } from '../../src/core/packstore.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { expandSource } from '../../src/commands/packs.js';
import { defaultPackSelections } from '../../src/core/extensions.js';
import { validateSddTree } from '../../src/core/validation.js';
import { loadProjectConfig } from '../../src/config/loader.js';

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

describe('an unresolvable selection fails LOUDLY, under a code that names the remedy', () => {
  it('PACK_NOT_INSTALLED when the pack is absent entirely', () => {
    store();
    project([{ name: 'missing-pack' }]);

    const ext = loadProjectExtensions();
    expect(ext.selectionFailures).toHaveLength(1);
    expect(ext.selectionFailures[0].code).toBe('PACK_NOT_INSTALLED');
    expect(ext.selectionFailures[0].name).toBe('missing-pack');
    expect(ext.selectionFailures[0].message).toContain('wairon pack install');
    // No doctrine silently applied in its place.
    expect(ext.packNames).toEqual([]);
  });

  it('names the recorded source in the fix instructions', () => {
    store();
    project([{ name: 'missing-pack', source: 'https://example.test/missing-1.0.0.wpack' }]);
    const failure = loadProjectExtensions().selectionFailures[0];
    expect(failure.message).toContain('wairon pack sync');
    expect(failure.message).toContain('https://example.test/missing-1.0.0.wpack');
  });

  it('PACK_VERSION_UNSATISFIED when the pack IS installed but the pin is not — a different remedy', () => {
    store();
    installPackFromDirectory(packSource('demo', '1.2.0'));
    project([{ name: 'demo', version: '9.9.9' }]);

    const ext = loadProjectExtensions();
    expect(ext.selectionFailures[0].code).toBe('PACK_VERSION_UNSATISFIED');
    expect(ext.selectionFailures[0].message).toContain('demo@9.9.9');
    // The message names what IS installed, so the pin can be corrected.
    expect(ext.selectionFailures[0].message).toContain('1.2.0');
    expect(ext.packNames).toEqual([]);
  });

  it('PACK_INTEGRITY_MISMATCH when the content is not what was pinned', () => {
    store();
    installPackFromDirectory(packSource('demo', '1.2.0'));
    project([{ name: 'demo', version: '1.2.0', integrity: 'sha256-0000000000000000000000000000000000000000000000000000000000000000' }]);

    const ext = loadProjectExtensions();
    expect(ext.selectionFailures).toHaveLength(1);
    expect(ext.selectionFailures[0].code).toBe('PACK_INTEGRITY_MISMATCH');
    expect(ext.packNames).toEqual([]);
  });

  it('one unresolvable selection never suppresses the packs that DID resolve', () => {
    store();
    installPackFromDirectory(packSource('good', '1.0.0'));
    project([{ name: 'good' }, { name: 'missing-pack' }]);

    const ext = loadProjectExtensions();
    expect(ext.packNames).toEqual(['good']);        // the good pack still applies
    expect(ext.selectionFailures).toHaveLength(1);  // and the gap is still reported
  });

  it('an uninstall of a selected pack turns the gate red', () => {
    store();
    installPackFromDirectory(packSource('demo', '1.2.0'));
    project([{ name: 'demo' }]);
    expect(loadProjectExtensions().selectionFailures).toEqual([]);

    uninstallPack('demo');
    expect(loadProjectExtensions().selectionFailures[0].code).toBe('PACK_NOT_INSTALLED');
  });

  it('reaches the GATE as an error, not just the loader', () => {
    store();
    const dir = project([{ name: 'missing-pack' }]);
    // A loadable L0 is required: validation short-circuits before the rule phase
    // when there is no system spec, so an empty tree would never reach the rule.
    fs.writeFileSync(path.join(dir, '.wai', 'specs', '.index.yaml'),
      "schemaVersion: 1.0.0\nname: GateSys\nvision: v\ncreatedAt: '2026-07-03T10:00:00Z'\nupdatedAt: '2026-07-03T10:00:00Z'\n");
    invalidateSpecCache();

    // The end that matters: `validate` refuses. A gate running without the
    // doctrine the project declared must never look clean.
    const result = validateSddTree();
    const failure = result.issues.find((i) => i.code === 'PACK_NOT_INSTALLED');
    expect(failure).toBeDefined();
    expect(failure?.severity).toBe('error');
    expect(result.valid).toBe(false);
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

describe('applyByDefault seeds NEW projects (A5)', () => {
  it('offers only the store packs that declare applyByDefault', () => {
    store();
    installPackFromDirectory(packSource('opt-in', '1.0.0'));
    installPackFromDirectory(packSource('default-on', '2.0.0', 'applyByDefault: true\n'));
    project([]);

    const seeded = defaultPackSelections();
    // A machine-wide install becomes a default for projects created FROM NOW ON,
    // not retroactive authority over everything on disk.
    expect(seeded.map((s) => s.name)).toEqual(['default-on']);
    expect(seeded[0].version).toBe('2.0.0');
  });

  it('seeds nothing when no installed pack asks for it', () => {
    store();
    installPackFromDirectory(packSource('opt-in', '1.0.0'));
    project([]);
    expect(defaultPackSelections()).toEqual([]);
  });
});

describe('enforceReproducibility finally enforces something (A6)', () => {
  /** Validate a project holding one selection, returning its issue codes. */
  function codesFor(selection: unknown, rules: Record<string, unknown> = {}): string[] {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-repro-'));
    created.push(dir);
    fs.mkdirSync(path.join(dir, '.wai', 'specs'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.wai', 'project.yaml'), JSON.stringify({
      schemaVersion: '1.0.0', name: 'p', projectType: 'backend',
      targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
      rules,
      extensions: { useGlobalPacks: false, packs: [selection] },
      createdAt: '2026-07-03T10:00:00Z', updatedAt: '2026-07-03T10:00:00Z',
    }));
    fs.writeFileSync(path.join(dir, '.wai', 'specs', '.index.yaml'),
      "schemaVersion: 1.0.0\nname: S\nvision: v\ncreatedAt: '2026-07-03T10:00:00Z'\nupdatedAt: '2026-07-03T10:00:00Z'\n");
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    invalidateSpecCache();
    // Pass rules exactly as the validate command and the MCP tool do — otherwise
    // the project's opt-out never reaches the rule.
    return validateSddTree({ rules: loadProjectConfig().rules }).issues.map((i) => i.code);
  }

  it('warns on a floating selection — it resolves off whatever this machine has', () => {
    store();
    installPackFromDirectory(packSource('demo', '1.2.0'));
    expect(codesFor({ name: 'demo', source: 'https://h/demo-{version}.wpack' }))
      .toContain('UNPINNED_PACK_SELECTION');
  });

  it('accepts a pinned selection', () => {
    store();
    installPackFromDirectory(packSource('demo', '1.2.0'));
    const codes = codesFor({ name: 'demo', version: '1.2.0', source: 'https://h/demo-1.2.0.wpack' });
    expect(codes).not.toContain('UNPINNED_PACK_SELECTION');
    expect(codes).not.toContain('PACK_SOURCE_UNFETCHABLE');
  });

  it('accepts a BUNDLED selection without a pin — its committed bytes are the pin', () => {
    store();
    const codes = codesFor({ name: 'demo', bundle: true });
    expect(codes).not.toContain('UNPINNED_PACK_SELECTION');
    expect(codes).not.toContain('PACK_SOURCE_UNFETCHABLE');
  });

  it('warns when nothing can obtain the pack elsewhere', () => {
    store();
    installPackFromDirectory(packSource('demo', '1.2.0'));
    expect(codesFor({ name: 'demo', version: '1.2.0' })).toContain('PACK_SOURCE_UNFETCHABLE');
  });

  it('goes silent when the project opts out of reproducibility', () => {
    store();
    installPackFromDirectory(packSource('demo', '1.2.0'));
    const codes = codesFor({ name: 'demo' }, { enforceReproducibility: false });
    expect(codes).not.toContain('UNPINNED_PACK_SELECTION');
    expect(codes).not.toContain('PACK_SOURCE_UNFETCHABLE');
  });
});
