import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { validateSddTree, validateAsComplete, type ValidationIssue } from '../../src/core/validation.js';
import { buildRuleContext } from '../../src/core/rules/index.js';
import { validateComponentCandidate } from '../../src/core/rules/candidate.js';
import { runLock } from '../../src/commands/lock.js';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import type { ComponentSpec, SystemSpec } from '../../src/models/index.js';
import type { RulesConfig } from '../../src/models/project.js';

// ---------------------------------------------------------------------------
// The `notice` severity (stage 2a-1).
//
// A notice is a finding that is REPORTED — on every surface that lists
// findings, apart from errors and warnings — but that never makes a result
// invalid and never fails `wairon validate --ci`. No rule emits one by default
// yet, so the only way to reach it today is `rules.sddRuleSeverity`: every
// case below sets a real code to `notice` in a temporary project and proves
// what each surface does with it.
// ---------------------------------------------------------------------------

vi.mock('inquirer', () => ({ default: { prompt: vi.fn() } }));

const execFileP = promisify(execFile);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const WAIRON_CLI = path.join(REPO_ROOT, 'src', 'cli', 'index.ts');

const META = `createdAt: '2026-06-10T22:00:00Z'\nupdatedAt: '2026-06-10T22:00:00Z'`;

interface Fixture {
  /** The project's rules block. */
  rules?: Partial<RulesConfig>;
  /** Status of every spec in the tree. */
  status?: 'draft' | 'complete';
  /** A lint block (YAML, already indented under the key) for the subsystem. */
  subsystemLint?: string;
}

/**
 * One subsystem holding an HTTP portal whose single method has NO endpoint.
 * Draft, that is a draft-waivable DRAFT_SUBSYSTEM_WARNING plus a MISSING_ENDPOINT
 * warning that is NOT waivable (it fails --ci); complete, MISSING_ENDPOINT is an
 * error.
 */
function makeProject(f: Fixture = {}): string {
  const status = f.status ?? 'draft';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-notice-'));
  const wai = path.join(dir, '.wai');
  fs.mkdirSync(wai);
  fs.writeFileSync(path.join(wai, 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0',
    name: 'notice-fixture',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: f.rules ?? {},
    createdAt: '2026-06-10T22:00:00Z',
    updatedAt: '2026-06-10T22:00:00Z',
  }));
  const specs = path.join(wai, 'specs');
  for (const d of ['subsystems', 'components', 'interfaces']) fs.mkdirSync(path.join(specs, d), { recursive: true });
  fs.writeFileSync(path.join(specs, '.index.yaml'),
    `schemaVersion: 1.0.0\nname: NoticeSystem\nvision: A system that proves the notice severity\n${META}\n`);
  fs.writeFileSync(path.join(specs, 'subsystems', 'sub-a.yaml'),
    `schemaVersion: 1.0.0\nid: sub-a\nname: SubA\ndescription: Subsystem A\nparentSystem: NoticeSystem\nstatus: ${status}\n`
    + (f.subsystemLint ? `lint:\n${f.subsystemLint}\n` : '')
    + `${META}\n`);
  fs.writeFileSync(path.join(specs, 'components', 'comp-a.yaml'),
    `schemaVersion: 1.0.0\nid: comp-a\nname: CompA\ndescription: HTTP portal\nsubsystem: sub-a\ncomponentType: Portal\nportalType: HTTP_API\ndependsOn: []\nstatus: ${status}\n${META}\n`);
  fs.writeFileSync(path.join(specs, 'interfaces', 'icomp-a.yaml'),
    `schemaVersion: 1.0.0\nid: icomp-a\nname: ICompA\ndescription: Interface A\ncomponent: comp-a\nstatus: ${status}\nmethods:\n  - name: callApi\n    description: Api method\n    signature: "callApi(): Promise<void>"\n    returns: "Promise<void>"\n${META}\n`);
  return dir;
}

const dirs: string[] = [];
function project(f: Fixture = {}): string {
  const dir = makeProject(f);
  dirs.push(dir);
  setProjectRoot(dir);
  invalidateSpecCache();
  return dir;
}

function rulesOf(sddRuleSeverity: RulesConfig['sddRuleSeverity']): RulesConfig {
  return { sddRuleSeverity } as RulesConfig;
}

const find = (issues: ValidationIssue[], code: string): ValidationIssue[] => issues.filter((i) => i.code === code);

afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  for (const d of dirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* windows file locks */ }
  }
});

// ---------------------------------------------------------------------------
// Resolution: sddRuleSeverity sets, raises and silences a notice
// ---------------------------------------------------------------------------

describe('resolving a code to notice', () => {
  it('reports an error-default code set to notice as a notice, and leaves the result valid', () => {
    project({ status: 'complete' });
    const baseline = validateSddTree();
    expect(find(baseline.issues, 'MISSING_ENDPOINT').map((i) => i.severity)).toEqual(['error']);
    expect(baseline.valid).toBe(false);

    const noticed = validateSddTree({ rules: rulesOf({ MISSING_ENDPOINT: 'notice' }) });
    expect(find(noticed.issues, 'MISSING_ENDPOINT').map((i) => i.severity)).toEqual(['notice']);
    // A notice never makes the tree invalid.
    expect(noticed.valid).toBe(true);
  });

  it('raises a notice back to warning or error, and silences it with off', () => {
    project({ status: 'complete' });
    expect(find(validateSddTree({ rules: rulesOf({ MISSING_ENDPOINT: 'warning' }) }).issues, 'MISSING_ENDPOINT')
      .map((i) => i.severity)).toEqual(['warning']);
    expect(find(validateSddTree({ rules: rulesOf({ MISSING_ENDPOINT: 'error' }) }).issues, 'MISSING_ENDPOINT')
      .map((i) => i.severity)).toEqual(['error']);
    expect(find(validateSddTree({ rules: rulesOf({ MISSING_ENDPOINT: 'off' }) }).issues, 'MISSING_ENDPOINT')).toEqual([]);
  });

  it('keeps a notice a notice in draft context: the draft downgrade never raises one', () => {
    project({ status: 'draft' });
    // Control: draft softens the error default to a warning.
    expect(find(validateSddTree().issues, 'MISSING_ENDPOINT').map((i) => i.severity)).toEqual(['warning']);
    const issue = find(validateSddTree({ rules: rulesOf({ MISSING_ENDPOINT: 'notice' }) }).issues, 'MISSING_ENDPOINT');
    expect(issue.map((i) => i.severity)).toEqual(['notice']);
    expect(issue[0].draftContext).toBe(true);
  });

  it('the draft downgrade is min(default, warning) — a notice default stays a notice', () => {
    // No rule defaults to notice in 2a-1, so the downgrade is driven directly
    // through the context it lives in: MISSING_ENDPOINT is a completeness code.
    const issues: ValidationIssue[] = [];
    const now = new Date().toISOString();
    const system: SystemSpec = {
      schemaVersion: '1.0.0', name: 's', vision: '', boundaries: [], globalRequirements: [], databases: [], createdAt: now, updatedAt: now,
    };
    const ctx = buildRuleContext({
      system, subsystems: [], components: [], interfaces: [], implementations: [], types: [],
      projectType: 'backend', roundTripIssues: [], knownIssueCodes: new Set(['MISSING_ENDPOINT']), issues,
    });
    ctx.addIssue('error', 'MISSING_ENDPOINT', 'an error default, draft', undefined, true);
    ctx.addIssue('warning', 'MISSING_ENDPOINT', 'a warning default, draft', undefined, true);
    ctx.addIssue('notice' as never, 'MISSING_ENDPOINT', 'a notice default, draft', undefined, true);
    expect(issues.map((i) => i.severity)).toEqual(['warning', 'warning', 'notice']);
  });
});

// ---------------------------------------------------------------------------
// lint.allow covers notices, and a stale allow on one is still reported
// ---------------------------------------------------------------------------

describe('lint.allow and notices', () => {
  const allow = '  allow:\n    - code: DRAFT_SUBSYSTEM_WARNING\n      reason: The subsystem is deliberately still being designed';

  it('an allow silences a notice, and is counted as used', () => {
    project({ status: 'draft', subsystemLint: allow });
    const rules = rulesOf({ DRAFT_SUBSYSTEM_WARNING: 'notice' });
    const { issues } = validateSddTree({ rules });
    expect(find(issues, 'DRAFT_SUBSYSTEM_WARNING')).toEqual([]);
    expect(find(issues, 'UNUSED_LINT_ALLOW')).toEqual([]);
  });

  it('control: without the allow the notice is reported', () => {
    project({ status: 'draft' });
    const { issues } = validateSddTree({ rules: rulesOf({ DRAFT_SUBSYSTEM_WARNING: 'notice' }) });
    expect(find(issues, 'DRAFT_SUBSYSTEM_WARNING').map((i) => i.severity)).toEqual(['notice']);
  });

  it('a stale allow for a notice code is reported like any stale allow', () => {
    // Complete: DRAFT_SUBSYSTEM_WARNING cannot fire, so the allow matches nothing.
    project({ status: 'complete', subsystemLint: allow });
    const { issues } = validateSddTree({ rules: rulesOf({ DRAFT_SUBSYSTEM_WARNING: 'notice' }) });
    const stale = find(issues, 'UNUSED_LINT_ALLOW');
    expect(stale).toHaveLength(1);
    expect(stale[0].specId).toBe('sub-a');
  });
});

// ---------------------------------------------------------------------------
// The write gate keeps notices apart from warnings
// ---------------------------------------------------------------------------

describe('the component candidate gate', () => {
  it('returns a notice in its own list, never in warnings or errors', () => {
    const now = new Date().toISOString();
    const candidate = {
      id: 'portal-a', name: 'PortalA', description: 'a portal without its portalType yet', subsystem: 'sub-a',
      componentType: 'Portal', owns: [], dependsOn: [], status: 'draft', createdAt: now, updatedAt: now,
    } as unknown as ComponentSpec;
    const plain = validateComponentCandidate(candidate);
    expect(plain.warnings.map((w) => w.code)).toContain('MISSING_PORTAL_TYPE');
    expect(plain.notices).toEqual([]);

    const noticed = validateComponentCandidate(candidate, { rules: rulesOf({ MISSING_PORTAL_TYPE: 'notice' }) });
    expect(noticed.notices.map((n) => [n.code, n.severity])).toEqual([['MISSING_PORTAL_TYPE', 'notice']]);
    expect(noticed.warnings.map((w) => w.code)).not.toContain('MISSING_PORTAL_TYPE');
    expect(noticed.errors.map((e) => e.code)).not.toContain('MISSING_PORTAL_TYPE');
  });
});

// ---------------------------------------------------------------------------
// The lock record counts notices beside errors and warnings
// ---------------------------------------------------------------------------

describe('the lock record', () => {
  it('locks a tree whose only finding is a notice, and records the notice count', async () => {
    const dir = project({ status: 'complete' });
    const rules = rulesOf({ MISSING_ENDPOINT: 'notice' });
    const gate = validateAsComplete({ rules });
    expect(gate.valid).toBe(true);
    const record = await runLock({ yes: true }, gate);
    expect(record).not.toBeNull();
    const warnings = gate.issues.filter((i) => i.severity === 'warning').length;
    expect(record!.validationResult).toEqual({ valid: true, errors: 0, warnings, notices: 1 });
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, '.wai', 'lock.json'), 'utf8'));
    expect(onDisk.validationResult.notices).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// `wairon validate --ci`, through the real CLI: prints and counts notices, and
// never fails on them
// ---------------------------------------------------------------------------

async function validateCli(dir: string, ci: boolean): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await execFileP(process.execPath, [TSX_CLI, WAIRON_CLI, 'validate', ...(ci ? ['--ci'] : [])], {
      cwd: dir, env: { ...process.env, FORCE_COLOR: '0' },
    });
    return { code: 0, out: stdout + stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, out: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}

describe('wairon validate --ci (CLI)', () => {
  it('control: the draft MISSING_ENDPOINT warning fails --ci', async () => {
    const dir = makeProject({ status: 'draft' });
    dirs.push(dir);
    const { code, out } = await validateCli(dir, true);
    expect(code).toBe(1);
    expect(out).toContain('[MISSING_ENDPOINT]');
    expect(out).toContain('warnings are treated as errors in --ci mode');
  }, 60_000);

  it('the same finding set to notice is printed as a notice, counted, and --ci passes', async () => {
    const dir = makeProject({ status: 'draft', rules: { sddRuleSeverity: { MISSING_ENDPOINT: 'notice' } } });
    dirs.push(dir);
    const { code, out } = await validateCli(dir, true);
    expect(code).toBe(0);
    expect(out).toMatch(/notice +\[icomp-a\] \[MISSING_ENDPOINT\]/);
    expect(out).toContain('1 notice(s) reported — never part of the failure decision (--ci does not fail on notices).');
    expect(out).toContain('All checks passed');
  }, 60_000);

  it('an error-default code set to notice passes without --ci too', async () => {
    const dir = makeProject({ status: 'complete', rules: { sddRuleSeverity: { MISSING_ENDPOINT: 'notice' } } });
    dirs.push(dir);
    const { code, out } = await validateCli(dir, false);
    expect(code).toBe(0);
    expect(out).toContain('1 notice(s) reported');
  }, 60_000);
});
