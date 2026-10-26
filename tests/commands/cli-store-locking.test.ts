import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';

// ---------------------------------------------------------------------------
// The CLI's own files under concurrent writers: the credential store
// (~/.wairon/credentials.json) and the settings (~/.wairon/config.json) do
// every read-change-write under the file's write lock, so no process loses
// another's change; a credential file that cannot be read is refused rather
// than replaced; `mcp install` re-reads the agent's config just before it
// writes. Real processes and real files, in a home redirected per test: no
// test here ever touches the maintainer's own ~/.wairon.
// ---------------------------------------------------------------------------

// A hook on fs.readFileSync, off unless a test sets it: ESM forbids spying on the namespace.
const readHook = vi.hoisted(() => ({ after: null as null | ((file: unknown) => void) }));
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  const readFileSync = ((file: unknown, options?: unknown) => {
    const text = real.readFileSync(file as never, options as never);
    readHook.after?.(file);
    return text;
  }) as typeof real.readFileSync;
  return { ...real, readFileSync, default: { ...real, readFileSync } };
});

const REPO = path.resolve(__dirname, '../..');
const TSX = path.join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const temps: string[] = [];
const savedHome = process.env.HOME;
const savedProfile = process.env.USERPROFILE;
const savedCwd = process.cwd();

afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(savedCwd);
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  if (savedProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedProfile;
  for (const t of temps.splice(0)) {
    try { fs.rmSync(t, { recursive: true, force: true }); } catch { /* win file locks */ }
  }
});

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/** Point this process's home at `home`, and prove it took before anything can write. */
function useHome(home: string): void {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  expect(os.homedir()).toBe(home);
}

/** Run one worker script in its own node process with `home` as its home. */
function worker(script: string, home: string, args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TSX, script, ...args], {
      cwd: REPO,
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

function script(dir: string, name: string, body: string[]): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body.join('\n'));
  return file;
}

const url = (rel: string): string => JSON.stringify(new URL(`file:///${path.join(REPO, rel).replace(/\\/g, '/')}`).href);

describe('remote_binding_store: the credential store under concurrent writers', () => {
  it('four processes storing credentials at once keep every one', async () => {
    const home = tmp('cli-lock-home-');
    const file = script(tmp('cli-lock-work-'), 'store.mts', [
      `const m = await import(${url('src/commands/remotebinding.ts')});`,
      'const { writeCredential } = m.default ?? m;',
      'const [who] = process.argv.slice(2);',
      'for (let i = 0; i < 15; i++) writeCredential(`https://${who}-${i}.example`, `wk_${who}${i}`);',
    ]);
    const runs = await Promise.all(['a', 'b', 'c', 'd'].map((who) => worker(file, home, [who])));
    for (const r of runs) expect(r.code, r.out).toBe(0);
    const stored = JSON.parse(fs.readFileSync(path.join(home, '.wairon', 'credentials.json'), 'utf8')) as Record<string, string>;
    expect(Object.keys(stored)).toHaveLength(60);
    expect(stored['https://c-14.example']).toBe('wk_c14');
  }, 120_000);

  it('a credential file that cannot be parsed is refused, naming it, and left as it was', async () => {
    const home = tmp('cli-lock-home-');
    useHome(home);
    const { writeCredential, clearCredential } = await import('../../src/commands/remotebinding.js');
    const file = path.join(home, '.wairon', 'credentials.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ "https://kept.example": "wk_kept", ');
    expect(() => writeCredential('https://new.example', 'wk_new')).toThrow(/credentials\.json is not valid JSON.*Nothing was written/);
    expect(() => clearCredential('https://kept.example')).toThrow(/credentials\.json is not valid JSON/);
    expect(fs.readFileSync(file, 'utf8')).toBe('{ "https://kept.example": "wk_kept", ');
  });

  it('forgetting an instance it holds no credential for writes nothing, and creates no file', async () => {
    const home = tmp('cli-lock-home-');
    useHome(home);
    const { writeCredential, clearCredential, readCredential } = await import('../../src/commands/remotebinding.js');
    clearCredential('https://never.example');
    expect(fs.existsSync(path.join(home, '.wairon', 'credentials.json'))).toBe(false);
    writeCredential('https://kept.example/', 'wk_kept');
    const file = path.join(home, '.wairon', 'credentials.json');
    const before = fs.statSync(file).mtimeMs;
    clearCredential('https://other.example');
    expect(fs.statSync(file).mtimeMs).toBe(before);
    clearCredential('HTTPS://KEPT.example');
    expect(readCredential('https://kept.example')).toBeNull();
  });

  it('a binding is replaced through a temp file of its own: no shared remote.json.tmp is left or used', async () => {
    const home = tmp('cli-lock-home-');
    useHome(home);
    const root = tmp('cli-lock-project-');
    const { writeBinding, readBinding } = await import('../../src/commands/remotebinding.js');
    // A stray fixed-name temp file (what an older writer left) is neither renamed nor removed.
    fs.mkdirSync(path.join(root, '.wai'), { recursive: true });
    fs.writeFileSync(path.join(root, '.wai', 'remote.json.tmp'), 'stray');
    writeBinding(root, { url: 'https://i.example', projectId: 'p', source: 'binding-file' });
    expect(readBinding(root)?.projectId).toBe('p');
    expect(fs.readFileSync(path.join(root, '.wai', 'remote.json.tmp'), 'utf8')).toBe('stray');
    expect(fs.readdirSync(path.join(root, '.wai')).sort()).toEqual(['remote.json', 'remote.json.tmp']);
  });
});

describe('user_config_store: the settings file under concurrent writers', () => {
  it('three processes each setting their own field at once all keep it', async () => {
    const home = tmp('cli-lock-home-');
    const file = script(tmp('cli-lock-work-'), 'settings.mts', [
      `const m = await import(${url('src/config/userconfig.ts')});`,
      'const { setChannel, setDisabledAliases, setLastSeenVersion } = m.default ?? m;',
      'const [which] = process.argv.slice(2);',
      'for (let i = 0; i < 25; i++) {',
      '  if (which === "channel") setChannel(i % 2 === 0 ? "beta" : "dev");',
      '  if (which === "aliases") setDisabledAliases([`alias-${i}`]);',
      '  if (which === "seen") setLastSeenVersion(`6.3.${i}`);',
      '}',
    ]);
    const runs = await Promise.all(['channel', 'aliases', 'seen'].map((which) => worker(file, home, [which])));
    for (const r of runs) expect(r.code, r.out).toBe(0);
    const config = JSON.parse(fs.readFileSync(path.join(home, '.wairon', 'config.json'), 'utf8'));
    expect(config).toEqual({ channel: 'beta', disabledAliases: ['alias-24'], lastSeenVersion: '6.3.24' });
  }, 120_000);
});

describe('cli_mcp_adapter.installMcpServer: the agent config is re-read just before the write', () => {
  it('a server the agent added after the install read the file is kept', async () => {
    const home = tmp('cli-lock-home-');
    useHome(home);
    const project = tmp('cli-lock-project-');
    const now = new Date().toISOString();
    fs.mkdirSync(path.join(project, '.wai', 'specs'), { recursive: true });
    fs.writeFileSync(path.join(project, '.wai', 'project.yaml'), JSON.stringify({
      schemaVersion: '1.0.0', name: 'reread', targets: [], rules: {}, createdAt: now, updatedAt: now,
    }));
    const config = path.join(project, '.mcp.json');
    fs.writeFileSync(config, JSON.stringify({ mcpServers: { first: { command: 'first' } } }, null, 2) + '\n');
    process.chdir(project);

    // The agent writes its own server into the file right after the install's first read of it.
    let reads = 0;
    readHook.after = (file) => {
      if (typeof file === 'string' && path.resolve(file) === path.resolve(config) && ++reads === 1) {
        fs.writeFileSync(config, JSON.stringify({ mcpServers: { first: { command: 'first' }, later: { command: 'later' } } }, null, 2) + '\n');
      }
    };

    const { runMcpInstall } = await import('../../src/commands/mcp.js');
    try {
      runMcpInstall({ backend: 'claude' });
    } finally {
      readHook.after = null;
    }

    expect(reads).toBeGreaterThanOrEqual(2);
    const written = JSON.parse(fs.readFileSync(config, 'utf8'));
    expect(Object.keys(written.mcpServers).sort()).toEqual(['first', 'later', 'wairon']);
  });
});
