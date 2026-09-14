import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { writeYamlFile } from '../../src/utils/yaml.js';
import { installPackFromDirectory } from '../../src/core/index.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { addPack, usePack, unusePack, bundlePack } from '../../src/commands/packs.js';
import { setExecutionTier } from '../../src/commands/execution.js';
import { listRules } from '../../src/commands/rules.js';

// ---------------------------------------------------------------------------
// The CLI's reads and writes of .wai/project.yaml, through the core portal
// (stage 2a-0). Every write reaches the file through the project config
// Repository, whose fs adapter is the one caller of writeYamlFile for it — so
// wrapping writeYamlFile counts the configuration writes a command makes.
// ---------------------------------------------------------------------------

vi.mock('../../src/utils/yaml.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/yaml.js')>();
  return { ...actual, writeYamlFile: vi.fn(actual.writeYamlFile) };
});

type Entry = string | { name: string; version?: string; source?: string; bundle?: boolean };
interface WrittenConfig {
  extensions?: { packs?: Entry[]; useGlobalPacks?: boolean };
  execution?: { tier?: string };
  [key: string]: unknown;
}

const tmpRoots: string[] = [];
function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

const configFile = (dir: string): string => path.join(dir, '.wai', 'project.yaml');
const readConfig = (dir: string): WrittenConfig =>
  yaml.load(fs.readFileSync(configFile(dir), 'utf8')) as WrittenConfig;
const packNames = (dir: string): string[] =>
  (readConfig(dir).extensions?.packs ?? []).map((e) => (typeof e === 'string' ? e : e.name));

/** An initialized project bound as the cwd. Written as JSON, which YAML parses. */
function project(fields: Record<string, unknown> = {}): string {
  const dir = mkTmp('wairon-cfg-cli-');
  fs.mkdirSync(path.join(dir, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(configFile(dir), JSON.stringify({
    schemaVersion: '1.0.0',
    name: 'config-cli-project',
    projectType: 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {},
    createdAt: '2026-09-13T12:00:00Z',
    updatedAt: '2026-09-13T12:00:00Z',
    ...fields,
  }));
  vi.spyOn(process, 'cwd').mockReturnValue(dir);
  invalidateSpecCache();
  return dir;
}

/** Writes of any project.yaml since the last clear. */
function configWrites(): number {
  return vi.mocked(writeYamlFile).mock.calls.filter(([file]) => path.basename(file) === 'project.yaml').length;
}

/** Point the machine-wide pack store at a fresh directory. */
function useStore(): void {
  process.env.WAIRON_PACKS_DIR = mkTmp('wairon-cfg-cli-store-');
}

/** Install a minimal declarative pack into the store. */
function installPack(name: string, version: string): void {
  const dir = mkTmp('wairon-cfg-cli-src-');
  fs.writeFileSync(path.join(dir, 'pack.yaml'),
    `name: ${name}\nversion: ${version}\nprofiles:\n  ${name}-profile:\n    family: neutral\n`);
  installPackFromDirectory(dir);
}

afterEach(() => {
  delete process.env.WAIRON_PACKS_DIR;
  invalidateSpecCache();
  vi.restoreAllMocks();
  // The negative paths set process.exitCode; never let it leak into the run.
  process.exitCode = 0;
});

afterAll(() => {
  for (const dir of tmpRoots) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* win file locks */ }
  }
});

describe('pack add', () => {
  it('registers the vendored ref once when the same pack is added twice', async () => {
    const dir = project();
    const source = path.join(mkTmp('wairon-cfg-cli-pack-'), 'demo.yaml');
    fs.writeFileSync(source, 'name: demo\nversion: 1.0.0\nprofiles:\n  demo-profile:\n    family: neutral\n');

    vi.mocked(writeYamlFile).mockClear();
    await addPack(source);
    await addPack(source);

    expect(process.exitCode ?? 0).toBe(0);
    expect(readConfig(dir).extensions?.packs).toEqual(['.wai/packs/demo.yaml']);
    // The second add only refreshed the vendored copy.
    expect(configWrites()).toBe(1);
  });
});

describe('pack use', () => {
  it('moves a re-selected pack last and reports it as re-selected', async () => {
    useStore();
    installPack('alpha', '1.0.0');
    installPack('beta', '1.0.0');
    const dir = project({ extensions: { useGlobalPacks: false, packs: [{ name: 'alpha' }, { name: 'beta' }] } });
    const said = vi.spyOn(console, 'log');

    await usePack('alpha');

    expect(process.exitCode ?? 0).toBe(0);
    expect(packNames(dir)).toEqual(['beta', 'alpha']);
    expect(said.mock.calls.flat().join('\n')).toContain('Re-selected pack "alpha"');
  });

  it('keeps an unknown top-level key of project.yaml', async () => {
    useStore();
    installPack('alpha', '1.0.0');
    const dir = project({ futureSetting: { keep: 'me' } });

    await usePack('alpha');

    expect(process.exitCode ?? 0).toBe(0);
    const config = readConfig(dir);
    expect(config.extensions?.packs).toEqual([{ name: 'alpha' }]);
    expect(config.futureSetting).toEqual({ keep: 'me' });
  });
});

describe('pack unuse', () => {
  it('exits 1 and leaves project.yaml untouched when the project does not select the pack', async () => {
    // A legacy path ref whose stem is the name is not a selection, so it does not count.
    const dir = project({ extensions: { useGlobalPacks: false, packs: ['.wai/packs/beta.yaml', { name: 'alpha' }] } });
    const before = fs.readFileSync(configFile(dir), 'utf8');

    vi.mocked(writeYamlFile).mockClear();
    await unusePack('beta');

    expect(process.exitCode).toBe(1);
    expect(configWrites()).toBe(0);
    expect(fs.readFileSync(configFile(dir), 'utf8')).toBe(before);
  });
});

describe('pack bundle', () => {
  it('records every bundled version and bundle: true in one write', async () => {
    useStore();
    installPack('alpha', '1.2.0');
    installPack('beta', '2.0.0');
    const dir = project({
      extensions: {
        useGlobalPacks: false,
        packs: ['.wai/packs/legacy.yaml', { name: 'alpha' }, { name: 'beta', source: 'https://packs.example/beta.wpack' }],
      },
    });

    vi.mocked(writeYamlFile).mockClear();
    await bundlePack(undefined, { all: true });

    expect(process.exitCode ?? 0).toBe(0);
    expect(configWrites()).toBe(1);
    expect(readConfig(dir).extensions?.packs).toEqual([
      '.wai/packs/legacy.yaml',
      { name: 'alpha', version: '1.2.0', bundle: true },
      { name: 'beta', source: 'https://packs.example/beta.wpack', version: '2.0.0', bundle: true },
    ]);
    expect(fs.existsSync(path.join(dir, '.wai', 'packs', 'beta', '2.0.0', 'pack.yaml'))).toBe(true);
  });
});

describe('execution set-tier', () => {
  it('writes nothing when the requested tier is already set', async () => {
    const dir = project({ execution: { tier: 'default', overrides: {} } });

    vi.mocked(writeYamlFile).mockClear();
    await setExecutionTier('default');
    expect(configWrites()).toBe(0);

    // The counter does see this command's write: a new tier is one write.
    await setExecutionTier('trade');
    expect(configWrites()).toBe(1);
    expect(readConfig(dir).execution?.tier).toBe('trade');
  });
});

describe('rules list', () => {
  it('shows a project severity override beside the default', async () => {
    project({ rules: { sddRuleSeverity: { CIRCULAR_DEPENDENCY: 'warning' } } });
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });

    await listRules();

    // eslint-disable-next-line no-control-regex
    const text = lines.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
    expect(text).toMatch(/warning\s+CIRCULAR_DEPENDENCY \(override; default error\)/);
  });
});
