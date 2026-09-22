import { describe, it, expect, afterEach, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ---------------------------------------------------------------------------
// user_config_store — a person's own settings at ~/.wairon/config.json.
//
// READ THIS BEFORE ADDING A TEST HERE. Every writer in this module resolves its
// path from `os.homedir()` AT MODULE LOAD, and writes the real file. A test that
// imports it statically has already bound the maintainer's real home before its
// first line runs, and the first `setChannel` overwrites their actual settings.
//
// So nothing here imports the module at the top. `inTempHome()` points HOME and
// USERPROFILE (which is what `os.homedir()` reads on Windows) at a fresh temp
// directory, PROVES the redirect took before anything can write, and only then
// re-imports the module through `vi.resetModules()` so the constants are
// recomputed. `afterAll` re-reads the real file and fails if these tests changed
// a single byte of it.
// ---------------------------------------------------------------------------

type UserConfigModule = typeof import('../../src/config/userconfig.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** The real file, captured before any redirect — the thing that must not move. */
const REAL_CONFIG = realConfigPath();
const REAL_CONFIG_BEFORE = readOrNull(REAL_CONFIG);

function realConfigPath(): string {
  return path.join(os.homedir(), '.wairon', 'config.json');
}

function readOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

const savedHome = process.env.HOME;
const savedProfile = process.env.USERPROFILE;
const homes: string[] = [];

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = savedProfile;
  vi.restoreAllMocks();
  for (const dir of homes.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  }
});

afterAll(() => {
  // The fence, proven rather than assumed: the maintainer's own settings are
  // byte-for-byte what they were before this file ran.
  expect(readOrNull(realConfigPath())).toBe(REAL_CONFIG_BEFORE);
  expect(realConfigPath()).toBe(REAL_CONFIG);
});

interface TempHome {
  home: string;
  configFile: string;
  /** The module, loaded fresh with its path constants pointing into `home`. */
  store: UserConfigModule;
}

/**
 * Redirect this machine's home at a throwaway directory and load the store
 * against it. Throws — before any write is possible — if the redirect did not
 * take, because the alternative is silently writing to the real home.
 */
async function inTempHome(): Promise<TempHome> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-userconfig-'));
  homes.push(home);
  process.env.HOME = home;
  process.env.USERPROFILE = home;

  if (path.resolve(os.homedir()) !== path.resolve(home)) {
    throw new Error(
      `home redirect did not take on ${process.platform}: os.homedir() is ${os.homedir()}, wanted ${home}`,
    );
  }

  vi.resetModules();
  const store = (await import('../../src/config/userconfig.js')) as UserConfigModule;
  return { home, configFile: path.join(home, '.wairon', 'config.json'), store };
}

/** Leave a config.json on disk verbatim, the way a hand edit would. */
function writeRaw(home: string, contents: string): void {
  fs.mkdirSync(path.join(home, '.wairon'), { recursive: true });
  fs.writeFileSync(path.join(home, '.wairon', 'config.json'), contents, 'utf8');
}

describe('user_config_store: the fence these tests depend on', () => {
  it('writes into the home it is pointed at, and never the real one', async () => {
    const { home, configFile, store } = await inTempHome();

    store.setChannel('beta');

    expect(fs.existsSync(configFile)).toBe(true);
    expect(path.resolve(configFile).startsWith(path.resolve(home))).toBe(true);
    expect(path.resolve(configFile)).not.toBe(path.resolve(REAL_CONFIG));
    expect(readOrNull(REAL_CONFIG)).toBe(REAL_CONFIG_BEFORE);
  });

  it('creates the directory on the first write — nothing else ever does', async () => {
    const { home, configFile, store } = await inTempHome();
    expect(fs.existsSync(path.join(home, '.wairon'))).toBe(false);

    store.saveUserConfig({ channel: 'dev' });

    expect(JSON.parse(fs.readFileSync(configFile, 'utf8'))).toEqual({ channel: 'dev' });
  });
});

describe('user_config_store.load: an unconfigured machine is a normal state', () => {
  it('answers nothing configured when the file is absent', async () => {
    const { configFile, store } = await inTempHome();
    expect(fs.existsSync(configFile)).toBe(false);

    expect(store.loadUserConfig()).toEqual({});
  });

  it('answers nothing configured when the file cannot be read', async () => {
    const { home, configFile, store } = await inTempHome();
    // A directory where the file should be: it exists, and reading it throws.
    fs.mkdirSync(configFile, { recursive: true });
    expect(fs.existsSync(path.join(home, '.wairon', 'config.json'))).toBe(true);

    expect(store.loadUserConfig()).toEqual({});
  });

  it('answers nothing configured when the file is malformed', async () => {
    // Exactly what the BSD-sed installer bug used to leave behind: a literal
    // `n` where a newline was meant, so the document no longer parses.
    const { home, store } = await inTempHome();
    writeRaw(home, '{\n  "channel": "dev"n  "installDir": "/usr/local/bin"\n}\n');

    expect(store.loadUserConfig()).toEqual({});
  });

  it('answers the settings the file holds when it parses', async () => {
    const { home, store } = await inTempHome();
    writeRaw(home, '{ "channel": "preview", "disabledAliases": ["wai"] }');

    expect(store.loadUserConfig()).toEqual({ channel: 'preview', disabledAliases: ['wai'] });
  });

  it('re-reads the file on every call rather than caching it', async () => {
    const { home, store } = await inTempHome();
    writeRaw(home, '{ "channel": "beta" }');
    expect(store.loadUserConfig().channel).toBe('beta');

    // Another process — the installer, or a hand edit — moves it underneath us.
    writeRaw(home, '{ "channel": "dev" }');

    expect(store.loadUserConfig().channel).toBe('dev');
  });
});

describe('user_config_store: every write is read-modify-write', () => {
  it('setChannel leaves the opted-out aliases alone', async () => {
    const { configFile, store } = await inTempHome();
    store.setDisabledAliases(['wai']);

    store.setChannel('beta');

    expect(JSON.parse(fs.readFileSync(configFile, 'utf8'))).toEqual({
      disabledAliases: ['wai'],
      channel: 'beta',
    });
  });

  it('setDisabledAliases leaves the channel alone', async () => {
    const { configFile, store } = await inTempHome();
    store.setChannel('dev');

    store.setDisabledAliases(['wai']);

    expect(JSON.parse(fs.readFileSync(configFile, 'utf8'))).toEqual({
      channel: 'dev',
      disabledAliases: ['wai'],
    });
  });

  it('keeps a field it does not know about — the file is the person’s, not ours', async () => {
    const { home, configFile, store } = await inTempHome();
    writeRaw(home, '{ "channel": "beta", "somethingALaterBuildAdded": 1 }');

    store.setDisabledAliases([]);

    expect(JSON.parse(fs.readFileSync(configFile, 'utf8'))).toEqual({
      channel: 'beta',
      somethingALaterBuildAdded: 1,
      disabledAliases: [],
    });
  });

  it('writes the document pretty-printed, so a person can hand-edit it', async () => {
    const { configFile, store } = await inTempHome();

    store.setChannel('stable');

    const text = fs.readFileSync(configFile, 'utf8');
    expect(text).toBe('{\n  "channel": "stable"\n}\n');
  });
});

describe('user_config_store.channel: an unrecognized value can never widen the install', () => {
  it('answers the narrowest channel for a value this build does not know', async () => {
    const { home, store } = await inTempHome();
    writeRaw(home, '{ "channel": "nightly" }');

    expect(store.getChannel()).toBe('stable');
  });

  it('answers the narrowest channel when nothing is recorded', async () => {
    const { store } = await inTempHome();
    expect(store.getChannel()).toBe('stable');
  });

  it('answers every channel this build does know', async () => {
    const { home, store } = await inTempHome();
    for (const channel of store.UPDATE_CHANNELS) {
      writeRaw(home, JSON.stringify({ channel }));
      expect(store.getChannel()).toBe(channel);
    }
  });

  it('answers no opted-out aliases when the field is absent — active by default', async () => {
    const { home, store } = await inTempHome();
    writeRaw(home, '{ "channel": "dev" }');

    expect(store.getDisabledAliases()).toEqual([]);
  });
});

describe('user_config_store: the file carries only what something reads', () => {
  it('offers the six operations and nothing that no caller has', async () => {
    const { store } = await inTempHome();

    expect(Object.keys(store).sort()).toEqual(
      [
        'UPDATE_CHANNELS',
        'getChannel',
        'getDisabledAliases',
        'isUpdateChannel',
        'loadUserConfig',
        'saveUserConfig',
        'setChannel',
        'setDisabledAliases',
      ].sort(),
    );
  });
});

describe('the installers only READ ~/.wairon/config.json', () => {
  const sh = fs.readFileSync(path.join(REPO_ROOT, 'install.sh'), 'utf8');
  const ps1 = fs.readFileSync(path.join(REPO_ROOT, 'install.ps1'), 'utf8');

  it('records no installDir — nothing has ever read one back', () => {
    // The value was written by hand-editing JSON with sed. GNU sed expands the
    // `\n` in the replacement; BSD sed (macOS) inserts a literal `n`, leaving a
    // document that does not parse — and `load` then answers "nothing
    // configured", silently dropping the person's channel and opt-outs.
    expect(sh).not.toContain('installDir');
    expect(ps1).not.toContain('installDir');
  });

  it('writes nothing into the config file at all', () => {
    expect(sh).not.toMatch(/sed .*WAIRON_CFG_FILE/);
    expect(sh).not.toMatch(/>\s*"?\$\{?WAIRON_CFG_FILE/);
    expect(ps1).not.toMatch(/Set-Content\s+\$ConfigFile/);
    expect(ps1).not.toMatch(/Add-Member[^\n]*\$cfg|\$cfg\s*\|\s*Add-Member/);
  });

  it('still reads the opted-out aliases, against a path it actually defines', () => {
    expect(sh).toContain('disabledAliases');
    expect(sh).toMatch(/WAIRON_CFG_FILE="/);
    expect(ps1).toContain('disabledAliases');
    expect(ps1).toMatch(/\$ConfigFile = "/);
  });
});

describe('cli_runner.runAliasesList: what it says about an install it does not manage', () => {
  it('names package.json rather than an install script that would set a directory', async () => {
    const { store } = await inTempHome();
    store.setDisabledAliases([]);
    const { runAliasesList } = await import('../../src/commands/aliases.js');

    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.join(' '));
    });
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      lines.push(args.join(' '));
    });

    await runAliasesList();

    const output = lines.join('\n');
    // Under vitest this is a Node script, not a packaged binary: there is no
    // directory of ours, and the old copy told people to run the install script
    // to record one — which it no longer does, and which nothing would read.
    expect(output).not.toContain('Install directory unknown');
    expect(output).not.toContain('set it manually');
    expect(output).toContain('No install directory of ours to manage');
    expect(output).toContain("package.json's bin entries");
  });
});
