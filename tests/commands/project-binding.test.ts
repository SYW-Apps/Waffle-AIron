import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { resolveProjectBinding, setProjectRoot } from '../../src/utils/fs.js';
import { readYamlFile, writeYamlFile } from '../../src/utils/yaml.js';
import { invalidateSpecCache } from '../../src/core/specs.js';

// ---------------------------------------------------------------------------
// The binding rule (WaiPaths): which project a folder binds to. The walk never
// climbs past the repository root unless an ancestor DECLARES the crossing as
// a member; every surface — the CLI, the MCP server, `wairon dev` — binds the
// same root and names it; `init` never edits a project.yaml outside its folder
// without asking.
// ---------------------------------------------------------------------------

const promptMock = vi.hoisted(() => vi.fn());
vi.mock('inquirer', () => ({ default: { prompt: promptMock } }));

const execFileP = promisify(execFile);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const WAIRON_CLI = path.join(REPO_ROOT, 'src', 'cli', 'index.ts');

let roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  promptMock.mockReset();
  setProjectRoot(null);
  invalidateSpecCache();
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows file locks */ }
  }
  roots = [];
});

function tempDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-binding-')));
  roots.push(dir);
  return dir;
}

/** A folder holding a project's L0 (all the binding rule looks for), optionally declaring members. */
function project(dir: string, members?: Record<string, unknown>): string {
  fs.mkdirSync(path.join(dir, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.wai', 'specs', '.index.yaml'), 'name: x\n');
  if (members) writeYamlFile(path.join(dir, '.wai', 'project.yaml'), { schemaVersion: '1.0.0', name: path.basename(dir), members });
  return dir;
}

/** A repository root, as the binding rule sees one: a folder holding `.git`. */
function repository(dir: string): string {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  return dir;
}

describe('resolveProjectBinding — the binding rule', () => {
  it('a stray .wai in a non-git parent binds nothing in a child repository', () => {
    const base = tempDir();
    project(path.join(base, 'straywai'));
    const child = repository(path.join(base, 'straywai', 'child'));
    fs.mkdirSync(path.join(child, 'src', 'deep'), { recursive: true });
    expect(resolveProjectBinding(child)).toBeNull();
    expect(resolveProjectBinding(path.join(child, 'src', 'deep'))).toBeNull();
  });

  it('inside one repository, the nearest L0 above binds (and a folder with its own binds itself)', () => {
    const base = tempDir();
    const root = project(repository(path.join(base, 'outer')));
    const deep = path.join(root, 'apps', 'web', 'src');
    fs.mkdirSync(deep, { recursive: true });
    expect(resolveProjectBinding(deep)).toEqual({ root, via: 'ancestor', repositoryRoot: root });
    expect(resolveProjectBinding(root)).toEqual({ root, via: 'here', repositoryRoot: root });
  });

  it('a child repository inside a wairon project is its own world unless declared', () => {
    const base = tempDir();
    const root = project(repository(path.join(base, 'outer')));
    const child = repository(path.join(root, 'vendor', 'lib'));
    expect(resolveProjectBinding(child)).toBeNull();
  });

  it('a child repository the parent declares as a member still binds to the parent', () => {
    const base = tempDir();
    const root = project(path.join(base, 'outer'), { svc: 'services/svc', remote: 'git@example.com:acme/x.git#0123456789abcdef0123456789abcdef01234567' });
    const svc = repository(path.join(root, 'services', 'svc'));
    fs.mkdirSync(path.join(svc, 'src'), { recursive: true });
    expect(resolveProjectBinding(path.join(svc, 'src'))).toEqual({ root, via: 'declared-member', repositoryRoot: svc });
    // The long form declares the same way.
    const long = project(path.join(base, 'long'), { svc: { source: 'svc', as: 'part' } });
    const repo = repository(path.join(long, 'svc'));
    expect(resolveProjectBinding(repo)?.root).toBe(long);
  });

  it('outside any repository the walk is unbounded, as it always was', () => {
    const base = tempDir();
    const root = project(path.join(base, 'plain'));
    const deep = path.join(root, 'a', 'b');
    fs.mkdirSync(deep, { recursive: true });
    expect(resolveProjectBinding(deep)).toEqual({ root, via: 'ancestor' });
  });
});

/** An initialized parent project the CLI can act on (config + L0). */
function initializedParent(dir: string): string {
  fs.mkdirSync(path.join(dir, '.wai', 'specs'), { recursive: true });
  const now = new Date().toISOString();
  writeYamlFile(path.join(dir, '.wai', 'project.yaml'), {
    schemaVersion: '1.0.0', id: 'parent', name: 'parent', targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {}, createdAt: now, updatedAt: now,
  });
  writeYamlFile(path.join(dir, '.wai', 'specs', '.index.yaml'), {
    schemaVersion: '1.0.0', name: 'Parent', vision: 'v', boundaries: [], globalRequirements: [], databases: [], createdAt: now, updatedAt: now,
  });
  return dir;
}

describe('wairon init inside a folder a parent project binds', () => {
  async function initAt(cwd: string, yes: boolean): Promise<unknown> {
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    try {
      const { runInit } = await import('../../src/commands/init.js');
      await runInit({ yes });
      return null;
    } catch (e) {
      return e;
    } finally {
      if (tty) Object.defineProperty(process.stdin, 'isTTY', tty);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
  }

  it('with --yes refuses, naming the parent and the exact member add command, and edits nothing outside the folder', async () => {
    const parent = initializedParent(repository(path.join(tempDir(), 'outer')));
    const child = path.join(parent, 'services', 'inner');
    fs.mkdirSync(child, { recursive: true });
    const before = fs.readFileSync(path.join(parent, '.wai', 'project.yaml'), 'utf8');

    const error = await initAt(child, true) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain(`bound by the wairon project at ${parent}`);
    expect(error.message).toContain('wairon member add inner services/inner --project');
    expect(error.message).toContain('`git init`');
    expect(promptMock).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(parent, '.wai', 'project.yaml'), 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(child, '.wai'))).toBe(false);
  });

  it('on a terminal it asks — saying yes edits the parent\'s project.yaml — and only then declares the member', async () => {
    const parent = initializedParent(repository(path.join(tempDir(), 'outer')));
    const child = path.join(parent, 'services', 'inner');
    fs.mkdirSync(child, { recursive: true });
    promptMock.mockResolvedValueOnce({ proceed: true }).mockResolvedValueOnce({ id: 'inner' });

    expect(await initAt(child, false)).toBeNull();
    const question = (promptMock.mock.calls[0][0] as { message: string }[])[0].message;
    expect(question).toContain(path.join(parent, '.wai', 'project.yaml'));
    expect((readYamlFile(path.join(parent, '.wai', 'project.yaml')) as { members?: unknown }).members).toEqual({ inner: 'services/inner' });
  });

  it('declined on a terminal: nothing is written', async () => {
    const parent = initializedParent(repository(path.join(tempDir(), 'outer')));
    const child = path.join(parent, 'services', 'inner');
    fs.mkdirSync(child, { recursive: true });
    const before = fs.readFileSync(path.join(parent, '.wai', 'project.yaml'), 'utf8');
    promptMock.mockResolvedValueOnce({ proceed: false });

    expect(await initAt(child, false)).toBeNull();
    expect(fs.readFileSync(path.join(parent, '.wai', 'project.yaml'), 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(child, '.wai'))).toBe(false);
  });
});

/** The first line of a long-running command's stream that matches, then the process is stopped. */
function firstLine(args: string[], cwd: string, stream: 'stdout' | 'stderr', match: RegExp): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TSX_CLI, WAIRON_CLI, ...args], { cwd, env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' } });
    let buffer = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`no line matching ${match} in: ${buffer}`)); }, 150_000);
    child[stream].on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const line = buffer.split(/\r?\n/).find((l) => match.test(l));
      if (line) {
        clearTimeout(timer);
        child.kill();
        resolve(line);
      }
    });
    child.on('error', reject);
  });
}

describe('every surface binds the same root and names it (real CLI)', () => {
  it('a CLI command, the MCP server and `wairon dev` started in a subfolder name one project at one root; export keeps stdout pure', async () => {
    const parent = initializedParent(repository(path.join(tempDir(), 'outer')));
    const sub = path.join(parent, 'src', 'deep');
    fs.mkdirSync(sub, { recursive: true });

    const status = await execFileP(process.execPath, [TSX_CLI, WAIRON_CLI, 'status'], { cwd: sub, timeout: 180_000 });
    expect(status.stderr).toContain(`project parent at ${parent}`);

    const exported = await execFileP(process.execPath, [TSX_CLI, WAIRON_CLI, 'export'], { cwd: sub, timeout: 180_000 });
    expect(() => JSON.parse(exported.stdout)).not.toThrow();
    expect(exported.stderr).toContain(`project parent at ${parent}`);

    const mcp = await firstLine(['mcp', 'serve'], sub, 'stderr', /\[wairon mcp\]/);
    expect(mcp).toContain(`project parent at ${parent}`);

    const port = String(20000 + Math.floor(Math.random() * 20000));
    const dev = await firstLine(['dev', '--port', port], sub, 'stdout', /project:/);
    expect(dev).toContain(`parent at ${parent}`);
  }, 600_000);

  it('a child repository under a stray .wai: the CLI reports no project instead of borrowing the parent', async () => {
    const base = tempDir();
    initializedParent(path.join(base, 'straywai'));
    const child = repository(path.join(base, 'straywai', 'child'));
    const result = await execFileP(process.execPath, [TSX_CLI, WAIRON_CLI, 'status'], { cwd: child, timeout: 180_000 })
      .then((r) => `${r.stdout}${r.stderr}`, (e: { stdout?: string; stderr?: string }) => `${e.stdout ?? ''}${e.stderr ?? ''}`);
    expect(result).toContain('No wairon project found');
    expect(result).not.toContain('project parent at');
  }, 300_000);
});
