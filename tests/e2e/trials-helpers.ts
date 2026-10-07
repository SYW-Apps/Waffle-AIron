import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile, execFileSync } from 'child_process';
import { assertDistBuilt, DIST_CLI, rmrfWithRetry } from './helpers';
import { materializeFixtureProject, type FixtureTree } from '../rules-matrix/harness';

// ---------------------------------------------------------------------------
// Shared seam of the user-trial regression journeys (trials-*.test.ts).
//
// Three rounds of sandbox user trials drove the BUILT CLI by hand, as a solo
// developer, a platform team, a library author and a tinkerer would. Every
// journey here replays one of those probes against `node dist/cli/index.js`
// in a scratch project and asserts what the trial observed (exit code AND the
// key output text), so a fixed finding cannot silently come back.
//
// Isolation: every user-level location the CLI may read or write (HOME,
// USERPROFILE, APPDATA, LOCALAPPDATA, the git cache, the pack/variant stores,
// the AI tools' config dirs) points into a per-file sandbox — exactly what
// the trials' `wairon` wrapper did — so a journey never touches the real
// user's config and never sees another run's packs.
// ---------------------------------------------------------------------------

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  /** stdout + stderr, for "the output says X" assertions that do not care which stream. */
  all: string;
}

export interface TrialSandbox {
  /** Root of the sandbox (home, appdata, cache, and the trial projects live under it). */
  root: string;
  /** Environment for every CLI spawn of this sandbox. */
  env: NodeJS.ProcessEnv;
  /** A fresh, empty project directory under the sandbox (realpath'd). */
  project: (name: string) => string;
  /** A fresh project directory with a fixture tree materialized into it. */
  materialize: (name: string, tree: FixtureTree) => string;
  /** Run the built CLI in `cwd` with the sandbox environment. */
  run: (args: string[], cwd: string) => Promise<CliResult>;
  /** Remove the whole sandbox. */
  cleanup: () => Promise<void>;
}

/** Create one sandbox per test file (call in beforeAll, cleanup in afterAll). */
export function createTrialSandbox(prefix: string): TrialSandbox {
  assertDistBuilt();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `wairon-trial-${prefix}-`)));
  const at = (...p: string[]): string => {
    const d = path.join(root, ...p);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };
  const home = at('home');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: at('appdata'),
    LOCALAPPDATA: at('localappdata'),
    XDG_CACHE_HOME: at('cache'),
    XDG_CONFIG_HOME: at('config'),
    WAIRON_CACHE_DIR: at('cache', 'wairon'),
    WAIRON_PACKS_DIR: at('home', '.wairon', 'packs'),
    WAIRON_VARIANTS_DIR: at('home', '.wairon', 'variants'),
    WAIRON_DATA_DIR: at('home', '.wairon', 'data'),
    CLAUDE_CONFIG_DIR: at('home', '.claude'),
    GEMINI_CONFIG_DIR: at('home', '.gemini'),
    // Plain text: assertions read words, not escape sequences.
    NO_COLOR: '1',
    FORCE_COLOR: '0',
  };
  // The CLI binds the project from its cwd, never from the runner's; and a CI
  // runner's own variables must not change what the CLI decides.
  delete env.WAIRON_PROJECT_DIR;
  delete env.CI;
  delete env.GITHUB_ACTIONS;

  const projectsRoot = at('projects');
  const project = (name: string): string => {
    const d = path.join(projectsRoot, name);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };

  return {
    root,
    env,
    project,
    materialize: (name, tree) => {
      const d = project(name);
      materializeFixtureProject(d, tree);
      return d;
    },
    run: (args, cwd) => runCliIn(args, cwd, env),
    cleanup: () => rmrfWithRetry(root),
  };
}

/** Run the built CLI (never a shell string — cross-platform paths). */
export function runCliIn(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [DIST_CLI, ...args],
      { cwd, env, timeout: 120_000, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error && typeof (error as unknown as { code?: unknown }).code === 'number'
          ? (error as unknown as { code: number }).code
          : error ? 1 : 0;
        resolve({ code, stdout, stderr, all: `${stdout}\n${stderr}` });
      },
    );
  });
}

/** Full transcript of a run, for assertion messages. */
export const transcript = (r: CliResult): string => `exit ${r.code}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`;

/** Write (or overwrite) a file relative to a project directory. */
export function writeFile(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** Read a file relative to a project directory. */
export function readFile(dir: string, rel: string): string {
  return fs.readFileSync(path.join(dir, ...rel.split('/')), 'utf8');
}

/** `git init` + one commit, for journeys whose subject is binding or a committed record. */
export function gitInit(dir: string): void {
  const git = (...args: string[]): void => {
    execFileSync('git', args, {
      cwd: dir,
      stdio: 'ignore',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'trial', GIT_AUTHOR_EMAIL: 'trial@example.invalid',
        GIT_COMMITTER_NAME: 'trial', GIT_COMMITTER_EMAIL: 'trial@example.invalid',
      },
    });
  };
  git('init', '-q');
  git('add', '-A');
  git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'trial baseline', '--allow-empty');
}

/** Count the occurrences of a finding code in an output. */
export function countCode(text: string, code: string): number {
  return text.split(`[${code}]`).length - 1;
}
