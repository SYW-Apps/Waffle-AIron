import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { WAIRON_VERSION } from '../../src/config/defaults.js';
import type { ReleaseNote, TreeStanding, TreeUpgradeReport, UpgradePlan } from '../../src/upgrade/types.js';

// ---------------------------------------------------------------------------
// cli_runner — the upgrade workflows (src/commands/upgrade.ts): `wairon
// upgrade`, `wairon whatsnew`, the standing guard in front of every project
// command, and the release banner. Everything reaches sdd_upgrade through the
// CLI upgrade adapter and the machine's settings through the user config
// store, so both are replaced here: the workflows are judged on what they ask
// of them and what they print, never against a real tree or the real home.
// ---------------------------------------------------------------------------

const adapter = vi.hoisted(() => ({
  standing: vi.fn(),
  plan: vi.fn(),
  apply: vi.fn(),
  discard: vi.fn(),
  releaseNotes: vi.fn(),
}));
vi.mock('../../src/cli/adapters/upgrade.js', () => adapter);

const store = vi.hoisted(() => ({
  lastSeenVersion: vi.fn(),
  setLastSeenVersion: vi.fn(),
}));
vi.mock('../../src/config/userconfig.js', () => store);

const prompt = vi.hoisted(() => vi.fn());
vi.mock('inquirer', () => ({ default: { prompt } }));

import { runUpgrade, runWhatsNew, guardStanding, announceRelease, CHANGELOG_URL } from '../../src/commands/upgrade.js';

/** A bound project with a project.yaml, so the guard reads its standing (through the mocked adapter). */
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-upgrade-test-project-'));
fs.mkdirSync(path.join(ROOT, '.wai'), { recursive: true });
fs.writeFileSync(path.join(ROOT, '.wai', 'project.yaml'), 'id: demo\nname: Demo\n');

const standingOf = (state: TreeStanding['state'], over: Partial<TreeStanding> = {}): TreeStanding => ({
  root: ROOT, writtenMajor: state === 'older' ? 5 : 6, stamped: state !== 'older', runningMajor: 6, state, ...over,
});

/** A plan for one older project; `rewrites` is how many changes its step plans (0 = a stamp-only plan). */
function planOf(rewrites: number, over: Partial<UpgradePlan> = {}): UpgradePlan {
  return {
    familyRoot: ROOT,
    runningMajor: 6,
    standings: [standingOf('older')],
    steps: [{
      step: { from: 5, to: 6 },
      project: ROOT,
      changes: Array.from({ length: rewrites }, (_, i) => ({ spec: `spec_${i}`, description: `rewrite ${i}`, design: i === 0 })),
      reported: [],
    }],
    whatChanged: rewrites > 0 ? ['Specialists are Orchestrators'] : [],
    changes: [],
    ...over,
  };
}

const currentPlan = (): UpgradePlan => ({ familyRoot: ROOT, runningMajor: 6, standings: [standingOf('current')], steps: [], whatChanged: [], changes: [] });

const committed = (plan: UpgradePlan, relock: string[] = []): TreeUpgradeReport => ({ plan, committed: true, stamped: [ROOT], relock });

let out: string;
let isTTY: { stdin: boolean | undefined; stdout: boolean | undefined };

beforeEach(() => {
  out = '';
  const capture = (...args: unknown[]): void => { out += `${args.map(String).join(' ')}\n`; };
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);
  Object.values(adapter).forEach((fn) => fn.mockReset());
  Object.values(store).forEach((fn) => fn.mockReset());
  prompt.mockReset();
  isTTY = { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY };
  delete process.env.CI;
  setProjectRoot(ROOT);
});

afterEach(() => {
  process.stdin.isTTY = isTTY.stdin as boolean;
  process.stdout.isTTY = isTTY.stdout as boolean;
  setProjectRoot(null);
  vi.restoreAllMocks();
});

function terminal(on: boolean): void {
  process.stdin.isTTY = on;
  process.stdout.isTTY = on;
}

describe('cli_runner.runUpgrade', () => {
  it('refuses the command with the refusal when the release cannot upgrade the project, writing nothing', async () => {
    adapter.plan.mockReturnValue(planOf(0, { refusal: `${ROOT}: written by a newer major` }));
    await expect(runUpgrade({})).rejects.toThrow(/cannot upgrade the project.*written by a newer major/);
    expect(adapter.apply).not.toHaveBeenCalled();
  });

  it('says the family is already on the running major when nothing is older, and drops the plan', async () => {
    const plan = currentPlan();
    adapter.plan.mockReturnValue(plan);
    await runUpgrade({});
    expect(out).toContain('Already on the running major');
    expect(adapter.discard).toHaveBeenCalledWith(plan);
    expect(adapter.apply).not.toHaveBeenCalled();
  });

  it('--report prints each rewrite with the design changes marked and what the new major changes, then writes nothing', async () => {
    const plan = planOf(2);
    adapter.plan.mockReturnValue(plan);
    await runUpgrade({ report: true });
    expect(out).toContain('rewrite 0');
    expect(out).toContain('design');
    expect(out).toContain('What the new major changes');
    expect(out).toContain('Specialists are Orchestrators');
    expect(out).toContain('Nothing was written.');
    expect(adapter.discard).toHaveBeenCalledWith(plan);
    expect(adapter.apply).not.toHaveBeenCalled();
  });

  it('prints a stamp-only plan as one line and applies it without asking', async () => {
    const plan = planOf(0);
    adapter.plan.mockReturnValue(plan);
    adapter.apply.mockReturnValue(committed(plan));
    await runUpgrade({});
    expect(out).toContain('only the major stamp moves');
    expect(adapter.apply).toHaveBeenCalledWith(plan);
    expect(prompt).not.toHaveBeenCalled();
  });

  it('a non-interactive run without --yes is not confirmed: the plan is dropped and `wairon upgrade --yes` is named', async () => {
    terminal(false);
    const plan = planOf(2);
    adapter.plan.mockReturnValue(plan);
    await runUpgrade({});
    expect(adapter.apply).not.toHaveBeenCalled();
    expect(adapter.discard).toHaveBeenCalledWith(plan);
    expect(out).toContain('wairon upgrade --yes');
  });

  it('--yes applies all or nothing and names each project whose design moved with `wairon lock`', async () => {
    terminal(false);
    const plan = planOf(2);
    adapter.plan.mockReturnValue(plan);
    adapter.apply.mockReturnValue(committed(plan, [ROOT]));
    await runUpgrade({ yes: true });
    expect(adapter.apply).toHaveBeenCalledWith(plan);
    expect(out).toContain('is now on major 6');
    expect(out).toContain('wairon lock');
  });

  it('an interactive run asks, and applies on yes; on no it drops the plan', async () => {
    terminal(true);
    const plan = planOf(1);
    adapter.plan.mockReturnValue(plan);
    adapter.apply.mockReturnValue(committed(plan));
    prompt.mockResolvedValueOnce({ confirmed: true });
    await runUpgrade({});
    expect(adapter.apply).toHaveBeenCalledTimes(1);

    adapter.apply.mockClear();
    prompt.mockResolvedValueOnce({ confirmed: false });
    await runUpgrade({});
    expect(adapter.apply).not.toHaveBeenCalled();
    expect(adapter.discard).toHaveBeenCalledWith(plan);
  });

  it('CI never counts as interactive', async () => {
    terminal(true);
    process.env.CI = 'true';
    adapter.plan.mockReturnValue(planOf(1));
    await runUpgrade({});
    expect(prompt).not.toHaveBeenCalled();
    expect(adapter.apply).not.toHaveBeenCalled();
  });

  it('fails with the transaction failure, saying every file is as before, when the commit did not happen', async () => {
    const plan = planOf(1);
    adapter.plan.mockReturnValue(plan);
    adapter.apply.mockReturnValue({ plan, committed: false, failure: 'disk full', stamped: [], relock: [] });
    await expect(runUpgrade({ yes: true })).rejects.toThrow(/disk full.*Every file is as before/);
  });
});

describe('cli_runner.runWhatsNew', () => {
  it('reads the notes of the running version by default and prints each highlight and the changelog link', async () => {
    const notes: ReleaseNote[] = [{ version: WAIRON_VERSION, highlights: ['one thing', 'another thing'] }];
    adapter.releaseNotes.mockReturnValue(notes);
    await runWhatsNew();
    expect(adapter.releaseNotes).toHaveBeenCalledWith(null, WAIRON_VERSION);
    expect(out).toContain('one thing');
    expect(out).toContain('another thing');
    expect(out).toContain(CHANGELOG_URL);
  });

  it('reads the version named, and says so when it has no curated notes', async () => {
    adapter.releaseNotes.mockReturnValue([]);
    await runWhatsNew('6.2.0');
    expect(adapter.releaseNotes).toHaveBeenCalledWith(null, '6.2.0');
    expect(out).toContain('no curated notes');
    expect(out).toContain(CHANGELOG_URL);
  });
});

describe('cli_runner.guardStanding', () => {
  it.each(['upgrade', 'whatsnew', 'doctor', 'init', 'help', 'version', 'host project', 'serve', 'update', 'mcp serve'])(
    'lets %s run without reading where the tree stands',
    async (command) => {
      await guardStanding(command);
      expect(adapter.standing).not.toHaveBeenCalled();
    },
  );

  it('lets a command run when no project binds the folder', async () => {
    setProjectRoot(null);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-unbound-'));
    const cwd = process.cwd();
    process.chdir(empty);
    try {
      await guardStanding('status');
      expect(adapter.standing).not.toHaveBeenCalled();
    } finally {
      process.chdir(cwd);
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('lets a command report a missing project.yaml itself, never sending it to `wairon upgrade`', async () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-noconfig-'));
    fs.mkdirSync(path.join(bare, '.wai', 'specs'), { recursive: true });
    setProjectRoot(bare);
    try {
      await guardStanding('lock-check');
      expect(adapter.standing).not.toHaveBeenCalled();
    } finally {
      setProjectRoot(null);
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });

  it('lets a command on a current tree run', async () => {
    adapter.standing.mockReturnValue(standingOf('current'));
    await guardStanding('status');
    expect(adapter.plan).not.toHaveBeenCalled();
  });

  it.each(['newer', 'out_of_window'] as const)('refuses a command on a %s tree with the release to install', async (state) => {
    adapter.standing.mockReturnValue(standingOf(state, { advice: 'Install wairon 7.' }));
    await expect(guardStanding('status')).rejects.toThrow(/Install wairon 7\./);
    expect(adapter.plan).not.toHaveBeenCalled();
  });

  it('applies a stamp-only upgrade without asking and lets the command run', async () => {
    adapter.standing.mockReturnValue(standingOf('older'));
    const plan = planOf(0);
    adapter.plan.mockReturnValue(plan);
    adapter.apply.mockReturnValue(committed(plan));
    await expect(guardStanding('status')).resolves.toBeUndefined();
    expect(adapter.apply).toHaveBeenCalledWith(plan);
    expect(prompt).not.toHaveBeenCalled();
  });

  it('refuses a non-interactive command on an older tree, naming `wairon upgrade`, and drops the plan', async () => {
    terminal(false);
    adapter.standing.mockReturnValue(standingOf('older'));
    const plan = planOf(3);
    adapter.plan.mockReturnValue(plan);
    await expect(guardStanding('validate')).rejects.toThrow(/older wairon major.*wairon upgrade/);
    expect(adapter.discard).toHaveBeenCalledWith(plan);
    expect(adapter.apply).not.toHaveBeenCalled();
  });

  it('asks on a terminal: yes upgrades and lets the command run, printing what owes `wairon lock`', async () => {
    terminal(true);
    adapter.standing.mockReturnValue(standingOf('older'));
    const plan = planOf(3);
    adapter.plan.mockReturnValue(plan);
    adapter.apply.mockReturnValue(committed(plan, [ROOT]));
    prompt.mockResolvedValueOnce({ confirmed: true });
    await expect(guardStanding('validate')).resolves.toBeUndefined();
    expect(out).toContain('wairon lock');
  });

  it('asks on a terminal: no refuses the command and drops the plan', async () => {
    terminal(true);
    adapter.standing.mockReturnValue(standingOf('older'));
    const plan = planOf(3);
    adapter.plan.mockReturnValue(plan);
    prompt.mockResolvedValueOnce({ confirmed: false });
    await expect(guardStanding('validate')).rejects.toThrow(/wairon upgrade/);
    expect(adapter.discard).toHaveBeenCalledWith(plan);
  });

  it('does not ask on a refused plan, and names the refusal', async () => {
    terminal(true);
    adapter.standing.mockReturnValue(standingOf('older'));
    adapter.plan.mockReturnValue(planOf(0, { refusal: 'a step needs an author' }));
    await expect(guardStanding('validate')).rejects.toThrow(/wairon upgrade.*a step needs an author/);
    expect(prompt).not.toHaveBeenCalled();
  });

  it('names the failure when the upgrade did not commit', async () => {
    terminal(true);
    adapter.standing.mockReturnValue(standingOf('older'));
    const plan = planOf(2);
    adapter.plan.mockReturnValue(plan);
    adapter.apply.mockReturnValue({ plan, committed: false, failure: 'swap failed', stamped: [], relock: [] });
    prompt.mockResolvedValueOnce({ confirmed: true });
    await expect(guardStanding('validate')).rejects.toThrow(/swap failed/);
  });
});

describe('cli_runner.announceRelease', () => {
  it('says nothing on a non-interactive run, and records nothing', () => {
    terminal(false);
    announceRelease();
    expect(out).toBe('');
    expect(store.setLastSeenVersion).not.toHaveBeenCalled();
  });

  it('says nothing under CI even on a terminal', () => {
    terminal(true);
    process.env.CI = '1';
    announceRelease();
    expect(out).toBe('');
    expect(store.setLastSeenVersion).not.toHaveBeenCalled();
  });

  it('says nothing under --silent', async () => {
    terminal(true);
    const { setLogLevel } = await import('../../src/utils/logger.js');
    setLogLevel('silent');
    try {
      announceRelease();
    } finally {
      setLogLevel('info');
    }
    expect(out).toBe('');
    expect(store.setLastSeenVersion).not.toHaveBeenCalled();
  });

  it('prints the notes since the version last seen, newest first, then `wairon whatsnew` and the link, and records the running version', () => {
    terminal(true);
    store.lastSeenVersion.mockReturnValue('5.0.0');
    adapter.releaseNotes.mockReturnValue([
      { version: '6.1.0', highlights: ['newest highlight'] },
      { version: '6.0.0', highlights: ['older highlight'] },
    ] satisfies ReleaseNote[]);
    announceRelease();
    expect(adapter.releaseNotes).toHaveBeenCalledWith('5.0.0', WAIRON_VERSION);
    expect(out.indexOf('newest highlight')).toBeGreaterThan(-1);
    expect(out.indexOf('newest highlight')).toBeLessThan(out.indexOf('older highlight'));
    expect(out).toContain('wairon whatsnew');
    expect(out).toContain(CHANGELOG_URL);
    expect(store.setLastSeenVersion).toHaveBeenCalledWith(WAIRON_VERSION);
  });

  it('records the running version when none was recorded, even with nothing to print', () => {
    terminal(true);
    store.lastSeenVersion.mockReturnValue(null);
    adapter.releaseNotes.mockReturnValue([]);
    announceRelease();
    expect(adapter.releaseNotes).toHaveBeenCalledWith(null, WAIRON_VERSION);
    expect(out).toBe('');
    expect(store.setLastSeenVersion).toHaveBeenCalledWith(WAIRON_VERSION);
  });

  it('says nothing once the running version has been seen', () => {
    terminal(true);
    store.lastSeenVersion.mockReturnValue(WAIRON_VERSION);
    announceRelease();
    expect(adapter.releaseNotes).not.toHaveBeenCalled();
    expect(out).toBe('');
    expect(store.setLastSeenVersion).not.toHaveBeenCalled();
  });
});
