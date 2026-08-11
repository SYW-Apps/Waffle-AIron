import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import {
  createScratchProject,
  authorJourneyTree,
  DIST_CLI,
  type ScratchProject,
} from './helpers';

// ---------------------------------------------------------------------------
// The same scratch tree, driven by the BUILT CLI exactly as a human would:
// validate --ci, lock, agent brief. This is the tier that caught the "older
// CLI binary rejects spec trees using new vocabulary" incident class — the
// spec tree is authored through the live MCP server, then the CLI binary must
// accept and operate on what landed on disk.
// ---------------------------------------------------------------------------

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the built CLI (never a shell string — cross-platform paths). */
function runCli(args: string[], cwd: string): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [DIST_CLI, ...args],
      { cwd, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
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

describe('e2e CLI smoke (built binary on the journey-built project)', () => {
  let proj: ScratchProject;

  beforeAll(async () => {
    proj = await createScratchProject('cli-smoke');
    await authorJourneyTree(proj.client);
    // Release the server before the CLI operates on the same tree (Windows
    // file-lock hygiene); cleanup() closing again is a safe no-op.
    await proj.client.close();
  });

  afterAll(async () => {
    await proj?.cleanup();
  });

  it('validate --ci exits 0 on the journey-built project', async () => {
    const res = await runCli(['validate', '--ci'], proj.dir);
    expect(res.code, fullOutput(res)).toBe(0);
  });

  it('lock --yes succeeds and writes .wai/lock.json with a stateId digest', async () => {
    const res = await runCli(['lock', '--yes'], proj.dir);
    expect(res.code, fullOutput(res)).toBe(0);

    const lockPath = path.join(proj.dir, '.wai', 'lock.json');
    expect(fs.existsSync(lockPath), `missing ${lockPath}\n${fullOutput(res)}`).toBe(true);
    const record = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as {
      stateId?: { algorithm?: string; digest?: string };
      status?: string;
    };
    expect(typeof record.stateId?.algorithm).toBe('string');
    expect(typeof record.stateId?.digest).toBe('string');
    expect((record.stateId!.digest as string).length).toBeGreaterThan(0);
    expect(record.status).toBeDefined();
  });

  it('agent brief <id> prints a non-empty brief', async () => {
    const res = await runCli(['agent', 'brief', 'system-architect'], proj.dir);
    expect(res.code, fullOutput(res)).toBe(0);
    expect(res.stdout.trim().length).toBeGreaterThan(0);
    expect(res.stdout).toContain('system-architect');
  });
});
