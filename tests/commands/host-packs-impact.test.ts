import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { runHostPacks } from '../../src/commands/host.js';
import { createPlacedProject } from '../server/helpers.js';
import { existingProjectRoot } from '../../src/server/projects.js';
import { governanceMachine, editConfig, readConfig, type GovernanceMachine } from '../helpers/governance-fixture.js';
import type { HostConfig } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// `wairon host packs install | remove --project` show the pack's impact on the
// hosted project first and ask; `--yes`, or a run with no terminal, writes
// without the report and says so. The terminal is the one boundary faked here
// (the prompt and whether stdin/stdout are TTYs); the host's preview, the
// validator and the pack store behind it are real, over a temp data directory
// with HOME, USERPROFILE and APPDATA redirected.
//
// And `wairon init` in a subdirectory (the member branch) states the parent's
// required packs it scaffolded, exactly as `wairon member add` does — run as
// the real CLI in a child process.
// ---------------------------------------------------------------------------

const promptMock = vi.hoisted(() => vi.fn());
vi.mock('inquirer', () => ({ default: { prompt: promptMock } }));

const MASTER = 'master-credential-secret-value';
const ACME_YAML = [
  'name: acme-svc',
  'version: 1.0.0',
  'profiles:',
  '  acme-svc:',
  '    family: backend-like',
  '    rules:',
  '      sddRuleSeverity:',
  "        UNUSED_COMPONENT: 'off'",
  'languages: {}',
  '',
].join('\n');

const tty = { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY };
function terminal(on: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { value: on, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: on, configurable: true });
}

describe('wairon host packs — the impact before a project pack write', () => {
  let tmp: string;
  let dataDir: string;
  let packFile: string;
  let cfg: HostConfig;
  let out: string[] = [];
  const savedEnv = { ...process.env };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-host-packs-cli-'));
    dataDir = path.join(tmp, 'data');
    const home = path.join(tmp, 'home');
    for (const dir of [dataDir, home, path.join(tmp, 'instance-packs'), path.join(tmp, 'image-packs')]) fs.mkdirSync(dir, { recursive: true });
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.APPDATA = home;
    process.env.WAIRON_ADMIN_TOKEN = MASTER;
    process.env.WAIRON_PACKS_DIR = path.join(tmp, 'instance-packs');
    process.env.WAIRON_IMAGE_PACKS_DIR = path.join(tmp, 'image-packs');
    packFile = path.join(tmp, 'acme-svc.yaml');
    fs.writeFileSync(packFile, ACME_YAML);
    cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true };
    createPlacedProject(cfg, MASTER, 'demo');
    out = [];
    const capture = (...args: unknown[]): void => { out.push(args.map(String).join(' ')); };
    vi.spyOn(console, 'log').mockImplementation(capture);
    vi.spyOn(console, 'warn').mockImplementation(capture);
    vi.spyOn(console, 'error').mockImplementation(capture);
    promptMock.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: tty.stdin, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: tty.stdout, configurable: true });
    vi.restoreAllMocks();
    process.env = { ...savedEnv };
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* windows file locks */ }
  });

  const text = (): string => out.join('\n');
  const vendored = (): string[] => {
    const dir = path.join(existingProjectRoot(dataDir, 'demo')!, '.wai', 'packs');
    return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  };

  it('in a terminal shows the impact and installs nothing when the answer is no', async () => {
    terminal(true);
    promptMock.mockResolvedValue({ confirmed: false });
    await runHostPacks('install', { project: 'demo', file: packFile, dataDir });
    expect(promptMock).toHaveBeenCalledTimes(1);
    expect(text()).toMatch(/Pack impact — acme-svc v1\.0\.0/);
    expect(text()).toMatch(/rule off: UNUSED_COMPONENT/);
    expect(text()).toMatch(/Nothing was installed\./);
    expect(vendored()).toEqual([]);
  });

  it('in a terminal installs on yes, and removes only after showing what the pack accounts for', async () => {
    terminal(true);
    promptMock.mockResolvedValue({ confirmed: true });
    await runHostPacks('install', { project: 'demo', file: packFile, dataDir });
    expect(vendored()).toEqual(['acme-svc.yaml']);

    out = [];
    promptMock.mockResolvedValueOnce({ confirmed: false });
    await runHostPacks('remove', { project: 'demo', name: 'acme-svc', dataDir });
    expect(text()).toMatch(/Measured as removed/);
    expect(text()).toMatch(/Nothing was removed\./);
    expect(vendored()).toEqual(['acme-svc.yaml']);

    promptMock.mockResolvedValueOnce({ confirmed: true });
    await runHostPacks('remove', { project: 'demo', name: 'acme-svc', dataDir });
    expect(vendored()).toEqual([]);
  });

  it('--yes (or no terminal) writes without the report or the question, and says so', async () => {
    terminal(true);
    await runHostPacks('install', { project: 'demo', file: packFile, dataDir, yes: true });
    expect(promptMock).not.toHaveBeenCalled();
    expect(text()).not.toMatch(/Pack impact —/);
    expect(text()).toMatch(/without showing its impact/);
    expect(vendored()).toEqual(['acme-svc.yaml']);

    terminal(false);
    out = [];
    await runHostPacks('remove', { project: 'demo', name: 'acme-svc', dataDir });
    expect(promptMock).not.toHaveBeenCalled();
    expect(text()).toMatch(/Removed "acme-svc" without showing its impact/);
    expect(vendored()).toEqual([]);
  });

  it('a server-global install governs no project, so it asks nothing', async () => {
    terminal(true);
    await runHostPacks('install', { file: packFile, dataDir });
    expect(promptMock).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(tmp, 'instance-packs', 'acme-svc.yaml'))).toBe(true);
  });
});

const execFileP = promisify(execFile);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const WAIRON_CLI = path.join(REPO_ROOT, 'src', 'cli', 'index.ts');

describe('wairon init in a subdirectory states the required packs it scaffolded (real CLI)', () => {
  let machine: GovernanceMachine | undefined;

  afterEach(() => {
    machine?.cleanup();
    machine = undefined;
  });

  it('prints the pack it applied and the requirement nothing installed satisfies, as member add does', async () => {
    const m = (machine = governanceMachine());
    m.install('1.2.0');
    const parent = m.project('parent');
    editConfig(parent, (doc) => {
      doc.composition = { requirePolicies: [{ pack: 'acme-base', version: '^1.0' }, { pack: 'absent-pack', version: '*' }] };
    });
    const child = path.join(parent, 'svc');
    fs.mkdirSync(child);

    const { stdout, stderr } = await execFileP(process.execPath, [TSX_CLI, WAIRON_CLI, 'init', '--yes'], {
      cwd: child, timeout: 180_000, env: { ...process.env },
    });

    const printed = [stdout, stderr].join('\n');
    expect(printed).toMatch(/Applied the required pack acme-base@1\.2\.0 to its new configuration/);
    expect(printed).toMatch(/No installed version of "absent-pack" satisfies \*/);
    const packs = (readConfig(child).extensions as { packs?: { name: string }[] } | undefined)?.packs ?? [];
    expect(packs.map((p) => p.name)).toEqual(['acme-base']);
  }, 180_000);
});
