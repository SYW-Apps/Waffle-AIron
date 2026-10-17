import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import {
  DIST_CLI, assertDistBuilt, createScratchProject, rmrfWithRetry, authorJourneyTree,
  type ScratchProject,
} from './helpers.js';

// ---------------------------------------------------------------------------
// A confirmation nobody can answer is a refusal, and a refusal exits non-zero.
//
// `wairon lock` asks "approve this design?". With no terminal and no --yes it
// writes nothing, and a script or CI job reading the exit code must see that:
// it spawns the BUILT binary with no terminal on stdin and reads the code, the
// output and the absence of the approval file.
// ---------------------------------------------------------------------------

interface CliResult { code: number; stdout: string; stderr: string }

function runCli(cwd: string, args: string[]): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [DIST_CLI, ...args], { cwd, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error && typeof (error as unknown as { code?: unknown }).code === 'number' ? (error as unknown as { code: number }).code : error ? 1 : 0;
      resolve({ code, stdout, stderr });
    });
    child.stdin?.end(); // no terminal: stdin is a closed pipe
  });
}

describe('confirm-gated commands refuse, with a failing exit code, when there is no terminal to ask on', () => {
  let proj: ScratchProject;

  beforeAll(async () => {
    assertDistBuilt();
    proj = await createScratchProject('e2e-confirm');
    await authorJourneyTree(proj.client);
  }, 180_000);

  afterAll(async () => {
    await proj?.cleanup?.();
    if (proj?.dir) await rmrfWithRetry(proj.dir);
  });

  it('wairon lock without --yes in a non-interactive shell exits non-zero and writes no approval', async () => {
    const r = await runCli(proj.dir, ['lock']);
    expect(r.stdout + r.stderr).toMatch(/re-run with --yes/);
    expect(r.code).not.toBe(0);
    expect(fs.existsSync(path.join(proj.dir, '.wai', 'lock.json'))).toBe(false);
  });
});
