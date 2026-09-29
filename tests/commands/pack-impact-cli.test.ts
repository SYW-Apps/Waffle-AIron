import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { usePack, unusePack, impactPack, addPack, removePack, installPack } from '../../src/commands/packs.js';
import { runMemberAdd } from '../../src/commands/subsystem.js';
import {
  governanceMachine, bindRoot, editConfig, readConfig, writeSubsystem, writeComponent, acmeBaseYaml, type GovernanceMachine,
} from '../helpers/governance-fixture.js';

// ---------------------------------------------------------------------------
// The pack-selecting commands show the pack's impact BEFORE they write and ask;
// `--yes`, or a run with no terminal to ask on, applies without the report and
// says so. `wairon pack impact` shows the report on demand and writes nothing.
// `wairon member add` states the required packs it applied. The terminal is the
// one boundary faked here (the prompt, and whether stdin/stdout are TTYs);
// everything behind it — the measurement, the loader, the gate, the registry
// write — is real, over real directories and a redirected pack store.
// ---------------------------------------------------------------------------

const promptMock = vi.hoisted(() => vi.fn());
vi.mock('inquirer', () => ({ default: { prompt: promptMock } }));

let machine: GovernanceMachine | undefined;
let out: string[] = [];
const tty = { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY };

function terminal(on: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { value: on, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: on, configurable: true });
}

beforeEach(() => {
  out = [];
  const capture = (...args: unknown[]): void => { out.push(args.map(String).join(' ')); };
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);
  promptMock.mockReset();
  process.exitCode = undefined;
});

afterEach(() => {
  terminal(false);
  Object.defineProperty(process.stdin, 'isTTY', { value: tty.stdin, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: tty.stdout, configurable: true });
  machine?.cleanup();
  machine = undefined;
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

const text = (): string => out.join('\n');
const packsOf = (dir: string): unknown[] => ((readConfig(dir).extensions as { packs?: unknown[] } | undefined)?.packs ?? []);

function shop(): { m: GovernanceMachine; dir: string } {
  const m = (machine = governanceMachine());
  m.install('1.2.0');
  const dir = m.project('shop');
  writeSubsystem(dir, 'core');
  writeComponent(dir, 'core', 'engine');
  bindRoot(dir);
  return { m, dir };
}

describe('wairon pack use — the impact first, then the question', () => {
  it('in a terminal shows the report and writes nothing when the answer is no', async () => {
    const { dir } = shop();
    terminal(true);
    promptMock.mockResolvedValue({ confirmed: false });
    await usePack('acme-base@1.2.0');
    expect(promptMock).toHaveBeenCalledTimes(1);
    expect(text()).toMatch(/Pack impact — acme-base v1\.2\.0/);
    expect(text()).toMatch(/profile backend/);
    expect(text()).toMatch(/Nothing was written\./);
    expect(packsOf(dir)).toEqual([]);
  });

  it('in a terminal applies when the answer is yes', async () => {
    const { dir } = shop();
    terminal(true);
    promptMock.mockResolvedValue({ confirmed: true });
    await usePack('acme-base@1.2.0');
    expect(packsOf(dir)).toEqual([{ name: 'acme-base', version: '1.2.0', source: 'https://packs.example.test/acme-base-1.2.0.wpack' }]);
    expect(text()).not.toMatch(/without showing the impact/);
  });

  it('--yes applies without the report and says so', async () => {
    const { dir } = shop();
    terminal(true);
    await usePack('acme-base@1.2.0', { yes: true });
    expect(promptMock).not.toHaveBeenCalled();
    expect(text()).not.toMatch(/Pack impact —/);
    expect(text()).toMatch(/Applied without showing the impact — see it with wairon pack impact acme-base/);
    expect(packsOf(dir)).toHaveLength(1);
  });

  it('with no terminal to ask on it applies without the report and says so', async () => {
    const { dir } = shop();
    terminal(false);
    await usePack('acme-base@1.2.0');
    expect(promptMock).not.toHaveBeenCalled();
    expect(text()).toMatch(/Applied without showing the impact/);
    expect(packsOf(dir)).toHaveLength(1);
  });
});

describe('wairon pack unuse / add / remove / install — the same gate', () => {
  it('unuse measures the removal and keeps the selection on a no', async () => {
    const { dir } = shop();
    await usePack('acme-base@1.2.0', { yes: true });
    terminal(true);
    promptMock.mockResolvedValue({ confirmed: false });
    await unusePack('acme-base');
    expect(text()).toMatch(/Measured as removed/);
    expect(packsOf(dir)).toHaveLength(1);
    promptMock.mockResolvedValue({ confirmed: true });
    await unusePack('acme-base');
    expect(packsOf(dir)).toEqual([]);
  });

  it('add shows the impact before vendoring, and declining vendors and registers nothing', async () => {
    const { m, dir } = shop();
    const source = path.join(m.home, 'house-pack');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'pack.yaml'), acmeBaseYaml('1.5.0'));
    terminal(true);
    promptMock.mockResolvedValue({ confirmed: false });
    await addPack(source);
    expect(text()).toMatch(/Pack impact — acme-base v1\.5\.0/);
    expect(fs.existsSync(path.join(dir, '.wai', 'packs', 'house-pack'))).toBe(false);
    expect(packsOf(dir)).toEqual([]);
    promptMock.mockResolvedValue({ confirmed: true });
    await addPack(source);
    expect(packsOf(dir)).toEqual(['.wai/packs/house-pack']);
    // remove: declined keeps it, --yes removes it and says so.
    promptMock.mockResolvedValue({ confirmed: false });
    await removePack('acme-base');
    expect(packsOf(dir)).toEqual(['.wai/packs/house-pack']);
    await removePack('acme-base', false, true);
    expect(packsOf(dir)).toEqual([]);
    expect(text()).toMatch(/Removed \.wai\/packs\/house-pack without showing the impact/);
  });

  it('install that moves this project\'s floating selection is measured as an update and asked', async () => {
    const { m, dir } = shop();
    editConfig(dir, (doc) => { doc.extensions = { useGlobalPacks: false, packs: [{ name: 'acme-base' }] }; });
    const source = path.join(m.home, 'next');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'pack.yaml'), acmeBaseYaml('1.3.0'));
    terminal(true);
    promptMock.mockResolvedValue({ confirmed: false });
    bindRoot(dir);
    await installPack(source);
    expect(text()).toMatch(/replaces v1\.2\.0/);
    expect(text()).toMatch(/Nothing was installed\./);
    expect(fs.existsSync(path.join(m.store, 'acme-base', '1.3.0'))).toBe(false);
    await installPack(source, true);
    expect(fs.existsSync(path.join(m.store, 'acme-base', '1.3.0'))).toBe(true);
    expect(text()).toMatch(/its selection now resolves to v1\.3\.0/);
  });
});

describe('wairon pack impact — on demand, writing nothing', () => {
  it('measures applying a pack the project does not apply, and removing one it applies exactly as asked', async () => {
    const { dir } = shop();
    const before = fs.readFileSync(path.join(dir, '.wai', 'project.yaml'), 'utf8');
    await impactPack('acme-base');
    expect(text()).toMatch(/Measured as applied/);
    expect(fs.readFileSync(path.join(dir, '.wai', 'project.yaml'), 'utf8')).toBe(before);
    await usePack('acme-base@1.2.0', { yes: true });
    out = [];
    await impactPack('acme-base@1.2.0');
    expect(text()).toMatch(/Measured as removed: the findings below are what the pack accounts for/);
  });

  it('refuses a pack that is not installed, naming what is', async () => {
    shop();
    await impactPack('nope');
    expect(process.exitCode).toBe(1);
    expect(text()).toMatch(/No pack "nope" is installed[\s\S]*Installed: acme-base/);
  });
});

describe('wairon member add — states the packs scaffolding applied', () => {
  it('names each applied pack with its pinned version, the projectType, and each unsatisfiable requirement', async () => {
    const { dir } = shop();
    editConfig(dir, (doc) => {
      doc.composition = { requirePolicies: [{ pack: 'acme-base', version: '^1', profile: 'strict' }, { pack: 'audit-trail', version: '*' }] };
    });
    bindRoot(dir);
    await runMemberAdd('svc', 'services/svc');
    expect(text()).toMatch(/Applied the required pack acme-base@1\.2\.0 to its new configuration/);
    expect(text()).toMatch(/Set its projectType to "strict"/);
    expect(text()).toMatch(/No installed version of "audit-trail" satisfies \*/);
  });
});
