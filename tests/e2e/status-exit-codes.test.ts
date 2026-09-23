import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { DIST_CLI, assertDistBuilt, rmrfWithRetry } from './helpers';

// ---------------------------------------------------------------------------
// `wairon status` over a tree it cannot read, on the BUILT CLI.
//
// The exit code is the whole feature, and nothing that imports source can see
// it: a unit test calling runStatus() would take `process.exit` with it. So
// this tier spawns the real binary and reads the three things a script reads —
// the code, stdout and stderr.
//
// It exists because all three were silently lost. `wairon status` was collapsed
// onto the shared core renderer, correctly; but the renderer answered ONE
// string carrying a dashboard, a parse failure and "there is no system here",
// so the command could not tell them apart. Both refusals became report body
// on stdout under a heading, with exit 0. A script over a broken tree read it
// as healthy, and no test in the suite covered either path.
// ---------------------------------------------------------------------------

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the built CLI's status command with colour forced on (never a shell string). */
function runStatus(cwd: string): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [DIST_CLI, 'status'],
      {
        cwd,
        timeout: 120_000,
        maxBuffer: 16 * 1024 * 1024,
        // The FORCE_COLOR=1 case, decided at import time in a real terminal:
        // the colours are part of what must not have changed.
        env: { ...process.env, FORCE_COLOR: '1' },
      },
      (error, stdout, stderr) => {
        const code = error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
          ? (error as unknown as { code: number }).code
          : error ? 1 : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

const fullOutput = (r: CliResult): string => `exit ${r.code}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`;

const STAMP = "'2026-06-10T22:00:00Z'";

const SYSTEM_SPEC = [
  'schemaVersion: 1.0.0',
  'name: TestSystem',
  'vision: A system for testing',
  `createdAt: ${STAMP}`,
  `updatedAt: ${STAMP}`,
  '',
].join('\n');

/** Every scratch dir this file made, removed once at the end. */
const scratchDirs: string[] = [];

/**
 * A minimal wairon project on disk — no MCP server involved, because the
 * subject here is a tree the loader REFUSES, which no authoring tool would
 * write.
 */
function scratchTree(kind: 'healthy' | 'unparseable' | 'no-system'): string {
  assertDistBuilt();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-status-exit-'));
  scratchDirs.push(dir);

  const specs = path.join(dir, '.wai', 'specs');
  fs.mkdirSync(specs, { recursive: true });
  for (const sub of ['subsystems', 'components', 'interfaces', 'implementations']) {
    fs.mkdirSync(path.join(specs, sub));
  }
  fs.writeFileSync(path.join(dir, '.wai', 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0',
    name: 'status-exit-codes',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
  }));

  if (kind !== 'no-system') {
    fs.writeFileSync(path.join(specs, '.index.yaml'), SYSTEM_SPEC);
  }

  if (kind === 'unparseable') {
    // A flow collection that never closes: the YAML parser throws before any
    // schema is consulted, which is the loader issue a human actually hits.
    fs.writeFileSync(path.join(specs, 'components', 'broken.yaml'), 'id: broken\nname: [unclosed\n');
  }

  if (kind === 'healthy') {
    fs.writeFileSync(path.join(specs, 'subsystems', 'sub-a.yaml'), [
      'schemaVersion: 1.0.0',
      'id: sub-a',
      'name: SubsystemA',
      'description: Subsystem A description',
      'parentSystem: TestSystem',
      'status: complete',
      `createdAt: ${STAMP}`,
      `updatedAt: ${STAMP}`,
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(specs, 'components', 'comp-a.yaml'), [
      'schemaVersion: 1.0.0',
      'id: comp-a',
      'name: ComponentA',
      'description: A component',
      'subsystem: sub-a',
      'componentType: Orchestrator',
      'status: complete',
      `createdAt: ${STAMP}`,
      `updatedAt: ${STAMP}`,
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(specs, 'interfaces', 'icomp-a.yaml'), [
      'schemaVersion: 1.0.0',
      'id: icomp-a',
      'name: IComponentA',
      'description: The contract',
      'component: comp-a',
      'status: complete',
      'methods:',
      '  - name: run',
      '    description: Run it once',
      "    signature: 'run(): void'",
      '    returns: void',
      `createdAt: ${STAMP}`,
      `updatedAt: ${STAMP}`,
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(specs, 'implementations', 'comp-a-impl.yaml'), [
      'schemaVersion: 1.0.0',
      'id: comp-a-impl',
      'name: ComponentA Impl',
      'description: The realization',
      'contract: icomp-a',
      'status: complete',
      'sourcePath: src/one.ts',
      'methods:',
      '  - name: run',
      '    narrative:',
      '      - stepNumber: 1',
      '        description: Step',
      '        type: local',
      `createdAt: ${STAMP}`,
      `updatedAt: ${STAMP}`,
      '',
    ].join('\n'));
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'one.ts'), '// one');
  }

  return dir;
}

// The escape sequences are written out literally rather than rebuilt with
// chalk: composing the expectation from the same library that produced the
// output would pass whatever that library did.
const ESC = String.fromCharCode(27);
const bold = (text: string): string => `${ESC}[1m${text}${ESC}[22m`;
const colour = (code: number, text: string): string => `${ESC}[${code}m${text}${ESC}[39m`;
const gray = (text: string): string => colour(90, text);

const HEADING = 'Architecture Status Dashboard';

/**
 * Exactly what the healthy tree printed before the report grew its second
 * field — captured from the built CLI at 5432fb29 and pinned here. The happy
 * path is the half of this change that must NOT move: only the two refusals
 * were restored.
 */
const HEALTHY_STDOUT = [
  '',
  bold(colour(37, HEADING)),
  gray('─'.repeat(HEADING.length)),
  '',
  `${bold(colour(34, '● System:'))} ${bold('TestSystem')} ${colour(32, '(100% Complete)')}`,
  `${gray('└── ')}${bold(colour(36, '[Subsystem] sub-a'))} ${colour(32, '(100%)')}`,
  `${gray('    └── ')}${colour(35, '[Component: Orchestrator] comp-a')} ${colour(32, '(100%)')}`,
  `${gray('        ├── ')}${colour(34, 'Interface: icomp-a')} (1 methods)`,
  `${gray('        └── ')}${colour(32, 'Implementation: comp-a-impl')}${colour(32, ' -> src/one.ts')}`,
  '',
  '',
].join('\n');

describe('e2e wairon status exit codes (built binary)', () => {
  afterAll(async () => {
    for (const dir of scratchDirs) await rmrfWithRetry(dir);
  });

  it('exits non-zero on an unparseable spec file, and explains on stderr', async () => {
    const res = await runStatus(scratchTree('unparseable'));

    // The exit code is the only part of this a script sees.
    expect(res.code, fullOutput(res)).not.toBe(0);
    expect(res.stderr, fullOutput(res)).toContain('Failed to parse specification files:');
    expect(res.stderr, fullOutput(res)).toContain('broken.yaml');
    // And it is a refusal, not a dashboard: no heading, nothing on stdout.
    expect(res.stdout, fullOutput(res)).not.toContain('Failed to parse');
    expect(res.stdout, fullOutput(res)).not.toContain(HEADING);
  });

  it('exits non-zero with no system spec, and names `wairon init`', async () => {
    const res = await runStatus(scratchTree('no-system'));

    expect(res.code, fullOutput(res)).not.toBe(0);
    expect(res.stderr, fullOutput(res)).toContain('L0 System specification (system.yaml) is missing.');
    // The hint is the terminal's own — a person here can act on it in the next
    // second, and it is the sentence this command printed before the collapse.
    expect(res.stderr, fullOutput(res)).toContain('Run `wairon init` first.');
    expect(res.stdout, fullOutput(res)).not.toContain(HEADING);
  });

  it('exits 0 on a healthy tree, byte-identical to before the report gained its fact', async () => {
    const res = await runStatus(scratchTree('healthy'));

    expect(res.code, fullOutput(res)).toBe(0);
    // Byte equality, not containment: restoring two refusals must not have
    // touched a single escape sequence of the report a person actually reads.
    expect(res.stdout).toBe(HEALTHY_STDOUT);
    expect(res.stderr).toBe('');
  });
});
