import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import * as yaml from 'js-yaml';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  saveSystemSpec, saveSpec, saveComponentSpec, saveInterfaceSpec, saveImplementationSpec, invalidateSpecCache,
} from '../../src/core/specs.js';
import type {
  ComponentSpec, ImplementationSpec, InterfaceSpec, SubsystemSpec, SystemSpec,
} from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// The documented CI recipe passes on a fresh clone of a TypeScript project.
//
// Trial round 3 ran the shipped CI lines on a `git clone` of a TS project with
// implemented code: `wairon validate --ci` failed on CONFORMANCE_DEGRADED — no
// TypeScript compiler resolvable from the project (no node_modules yet) — and
// nothing in the docs said to install the project's dependencies first; the
// reusable workflow even skipped them by design.
//
// This test reads the recipe FROM THE DOCS (docs/cli.md "Without the reusable
// workflow", the README quick start, and the reusable workflow's own steps), so
// it fails when a doc drops the install step, and runs the recipe's wairon
// steps against a fresh clone. The install is simulated without network: the
// repo's own node_modules/typescript is linked into the clone. The published
// CLI does not carry TypeScript, while this checkout does — so the CLI runs
// with a preload that lets `typescript` resolve ONLY from the clone, which is
// exactly the published install's situation.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const WAIRON_CLI = path.join(REPO_ROOT, 'src', 'cli', 'index.ts');
const now = '2026-10-07T10:00:00Z';

/** The commands a project's own package manager installs its dependencies with. */
const INSTALL = /^(npm ci|pnpm install|yarn install)\b/;

// --- the recipe, as the docs give it --------------------------------------

/** docs/cli.md "Without the reusable workflow": the `run:` steps, in order. */
function documentedRunSteps(): string[] {
  const md = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'cli.md'), 'utf8').replace(/\r\n/g, '\n');
  const at = md.indexOf('#### Without the reusable workflow');
  expect(at, 'docs/cli.md: the "Without the reusable workflow" section').toBeGreaterThan(-1);
  const block = /```yaml\n([\s\S]*?)\n```/.exec(md.slice(at));
  expect(block, 'docs/cli.md: its yaml block').not.toBeNull();
  const workflow = yaml.load(block![1]) as { jobs: Record<string, { steps: { run?: string }[] }> };
  return Object.values(workflow.jobs).flatMap((job) => job.steps)
    .filter((s) => typeof s.run === 'string')
    .map((s) => s.run!.trim());
}

/** The README quick start's CI lines: from `wairon lock-check` to `wairon validate --ci`. */
function readmeCiLines(): string[] {
  const lines = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8').split(/\r?\n/)
    .map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean);
  const from = lines.findIndex((l) => l.startsWith('wairon lock-check'));
  const to = lines.findIndex((l, i) => i > from && l === 'wairon validate --ci');
  expect(from, 'README: the quick start runs wairon lock-check').toBeGreaterThan(-1);
  expect(to, 'README: the quick start runs wairon validate --ci after it').toBeGreaterThan(from);
  return lines.slice(from, to + 1);
}

// --- the fixture: a small TS project with one implemented component -------

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=wairon-test', '-c', 'user.email=test@wairon.invalid', '-c', 'core.autocrlf=false', ...args], { cwd, stdio: 'pipe' });
}

function buildOrigin(root: string): void {
  fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, '.wai', 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0', id: 'ci-fixture', name: 'ci-fixture', projectType: 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {}, createdAt: now, updatedAt: now,
  }));
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({
    name: 'ci-fixture', version: '1.0.0', private: true, devDependencies: { typescript: '^5.5.2' },
  }, null, 2)}\n`);
  // The lockfile `npm ci` needs; its content does not matter to the simulation.
  fs.writeFileSync(path.join(root, 'package-lock.json'), `${JSON.stringify({
    name: 'ci-fixture', version: '1.0.0', lockfileVersion: 3, requires: true, packages: {},
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n');
  fs.writeFileSync(path.join(root, 'src', 'pricing.ts'), [
    'export class PriceCalculator {',
    '  total(net: number, rate: number): number {',
    '    return net + net * rate;',
    '  }',
    '}',
    '',
  ].join('\n'));

  setProjectRoot(root);
  try {
    saveSystemSpec({
      schemaVersion: '1.0.0', name: 'ci-fixture', vision: 'Price an order.',
      boundaries: [], globalRequirements: [], targetLanguage: 'typescript', createdAt: now, updatedAt: now,
    } as SystemSpec);
    saveSpec('subsystem', {
      id: 'pricing', name: 'pricing', description: 'prices orders', parentSystem: 'ci-fixture',
      publicInterfaces: [], trustedLinks: [],
      lifecycle: [{ phase: 'init', component: 'price_calculator', method: 'total' }],
      status: 'complete', createdAt: now, updatedAt: now,
    } as SubsystemSpec);
    saveComponentSpec({
      id: 'price_calculator', name: 'PriceCalculator', description: 'computes a gross price',
      subsystem: 'pricing', componentType: 'Orchestrator', dependencyClass: 'pure', dependsOn: [], owns: [],
      status: 'complete', createdAt: now, updatedAt: now,
    } as ComponentSpec);
    saveInterfaceSpec({
      id: 'iprice_calculator', name: 'IPriceCalculator', description: 'the price contract', component: 'price_calculator',
      methods: [{
        name: 'total', description: 'The gross price of a net amount.', returns: 'float',
        params: [{ name: 'net', type: 'float' }, { name: 'rate', type: 'float' }],
      }],
      status: 'complete', createdAt: now, updatedAt: now,
    } as InterfaceSpec);
    saveImplementationSpec({
      id: 'price_calculator_impl', name: 'PriceCalculator', description: 'in-process', contract: 'iprice_calculator',
      sourcePath: 'src/pricing.ts',
      methods: [{ name: 'total', narrative: [{ stepNumber: 1, description: 'Add the tax to the net amount', type: 'return', outcome: 'the gross price' }] }],
      status: 'complete', createdAt: now, updatedAt: now,
    } as ImplementationSpec);
  } finally {
    invalidateSpecCache();
    setProjectRoot(null);
  }
}

/** A preload that lets `typescript` resolve only from inside `projectDir` — the published CLI's situation. */
function writeTypeScriptFence(file: string): void {
  fs.writeFileSync(file, [
    "const Module = require('module');",
    "const path = require('path');",
    'const only = path.resolve(process.env.WAIRON_TEST_TYPESCRIPT_ONLY_FROM).toLowerCase() + path.sep;',
    'const resolve = Module._resolveFilename;',
    'Module._resolveFilename = function (request, parent, ...rest) {',
    "  if (request === 'typescript' || request.startsWith('typescript/')) {",
    "    const from = parent && parent.filename ? path.resolve(parent.filename).toLowerCase() : '';",
    '    if (!from.startsWith(only)) {',
    "      const e = new Error(\"Cannot find module 'typescript' (outside the project under test)\");",
    "      e.code = 'MODULE_NOT_FOUND';",
    '      throw e;',
    '    }',
    '  }',
    '  return resolve.call(this, request, parent, ...rest);',
    '};',
    '',
  ].join('\n'));
}

describe('the documented CI recipe on a fresh clone of a TypeScript project', () => {
  let tmp: string;
  let clone: string;
  let fence: string;

  const wairon = (args: string[], env: NodeJS.ProcessEnv = {}): { status: number | null; out: string } => {
    const r = spawnSync(process.execPath, [TSX_CLI, WAIRON_CLI, ...args], {
      cwd: clone,
      encoding: 'utf8',
      timeout: 180_000,
      env: {
        ...process.env,
        ...env,
        WAIRON_TEST_TYPESCRIPT_ONLY_FROM: clone,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${JSON.stringify(fence)}`.trim(),
      },
    });
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };

  beforeAll(() => {
    // realpath: the analyzer names files by their long path, and the fence compares against it.
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-ci-recipe-')));
    const origin = path.join(tmp, 'origin');
    clone = path.join(tmp, 'clone');
    fence = path.join(tmp, 'typescript-fence.cjs');
    writeTypeScriptFence(fence);
    fs.mkdirSync(origin);
    buildOrigin(origin);

    // The author approves the design on their machine and commits it.
    const lock = spawnSync(process.execPath, [TSX_CLI, WAIRON_CLI, 'lock', '--yes'], { cwd: origin, encoding: 'utf8', timeout: 180_000 });
    expect(lock.status, `${lock.stdout}${lock.stderr}`).toBe(0);
    git(origin, 'init', '-q');
    git(origin, 'add', '-A');
    git(origin, 'commit', '-q', '-m', 'design and code');

    // CI: a fresh clone — no node_modules.
    git(tmp, 'clone', '-q', origin, clone);
    expect(fs.existsSync(path.join(clone, 'node_modules'))).toBe(false);
    expect(fs.existsSync(path.join(clone, '.wai', 'lock.json'))).toBe(true);
  }, 240_000);

  afterAll(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* windows file locks */ }
  });

  it('the docs install the project\'s dependencies before wairon validate --ci', () => {
    const steps = documentedRunSteps();
    const validate = steps.indexOf('wairon validate --ci');
    const install = steps.findIndex((s) => INSTALL.test(s));
    expect(validate, `docs/cli.md recipe: ${JSON.stringify(steps)}`).toBeGreaterThan(-1);
    expect(install, 'docs/cli.md recipe: an install of the project\'s dependencies').toBeGreaterThan(-1);
    expect(install).toBeLessThan(validate);
    expect(steps.indexOf('wairon lock-check --strict')).toBeGreaterThan(-1);

    const readme = readmeCiLines();
    expect(readme.some((l) => INSTALL.test(l)), `README quick start CI lines: ${JSON.stringify(readme)}`).toBe(true);
  });

  it('the reusable workflow installs them before validate, and only for validate', () => {
    const wf = yaml.load(fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'lock-check.yml'), 'utf8')) as {
      jobs: Record<string, { steps: { name?: string; run?: string; if?: string }[] }>;
    };
    const steps = Object.values(wf.jobs)[0].steps;
    const lockCheck = steps.findIndex((s) => /wairon lock-check/.test(s.run ?? ''));
    const install = steps.findIndex((s) => /npm ci/.test(s.run ?? '') && /pnpm install/.test(s.run ?? '') && /yarn install/.test(s.run ?? ''));
    const validate = steps.findIndex((s) => /wairon validate --ci/.test(s.run ?? ''));
    expect(lockCheck).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(lockCheck);
    expect(validate).toBeGreaterThan(install);
    expect(steps[install].if ?? '').toContain('inputs.validate');
    // The approval check alone installs nothing of the project's.
    for (const s of steps.slice(0, lockCheck + 1)) expect(s.run ?? '', s.name).not.toMatch(/npm ci|pnpm install|yarn install/);
  });

  it('without the install, validate --ci fails on the runner (CONFORMANCE_DEGRADED)', () => {
    const r = wairon(['validate', '--ci']);
    expect(r.out).toContain('CONFORMANCE_DEGRADED');
    expect(r.status).not.toBe(0);
  }, 180_000);

  it('the documented steps pass on the clone', () => {
    const steps = documentedRunSteps();
    let installed = false;
    for (const step of steps) {
      if (/^npm install --global @wairon\/cli@/.test(step)) continue; // this test runs the CLI from source
      if (INSTALL.test(step)) {
        // `npm ci`, offline: the one dependency the gate needs, linked from this checkout.
        fs.mkdirSync(path.join(clone, 'node_modules'), { recursive: true });
        fs.symlinkSync(path.join(REPO_ROOT, 'node_modules', 'typescript'), path.join(clone, 'node_modules', 'typescript'), 'junction');
        installed = true;
        continue;
      }
      expect(step, 'a recipe step this test does not know how to run').toMatch(/^wairon /);
      const r = wairon(step.split(/\s+/).slice(1));
      expect(r.status, `${step}\n${r.out}`).toBe(0);
      if (step === 'wairon validate --ci') expect(r.out).not.toContain('CONFORMANCE_DEGRADED');
    }
    expect(installed).toBe(true);
  }, 360_000);
});
