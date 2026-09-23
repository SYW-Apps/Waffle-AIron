import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'child_process';
import {
  createScratchProject,
  authorJourneyTree,
  callToolOk,
  DIST_CLI,
  JOURNEY,
  type ScratchProject,
} from './helpers';

// ---------------------------------------------------------------------------
// The narrowed core surface, proven on the BUILT artifact.
//
// `src/core/index.ts` stopped republishing sixteen whole modules and now states
// each forward by name. Every one of those forwards is an identity re-export,
// which the type checker proves EXISTS and cannot prove RESOLVES through the
// bundle — the report below is composed from `getStatusReport`, `approvalVerdict`,
// `readLockState`, `captureApprovedSpecs` and `writeLockRecord`, five names that
// used to arrive on the surface through a star.
//
// So this tier drives the three readers that live on those forwards — the MCP
// status tool, `wairon status`, and the merge gate — against the real built
// server and CLI, in the order a repository meets them: before any approval,
// and after one.
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

describe('e2e core surface (the barrel forwards, on the built server and CLI)', () => {
  let proj: ScratchProject;
  let statusBeforeApproval = '';

  beforeAll(async () => {
    proj = await createScratchProject('core-surface');
    await authorJourneyTree(proj.client);
    // sdd_get_status composes the completeness report AND the approval verdict:
    // both reach sdd_core through the core portal, so a missing forward answers
    // here rather than at compile time. Asked while the server still holds the
    // tree, before the CLI takes it.
    const out = await callToolOk(proj.client, 'sdd_get_status', {});
    statusBeforeApproval = out.text;
    // Release the server before the CLI operates on the same tree (Windows
    // file-lock hygiene); cleanup() closing again is a safe no-op.
    await proj.client.close();
  });

  afterAll(async () => {
    await proj?.cleanup();
  });

  it('sdd_get_status reports the tree through the portal', () => {
    expect(statusBeforeApproval.trim().length).toBeGreaterThan(0);
    expect(statusBeforeApproval).toContain(JOURNEY.subsystem);
    expect(statusBeforeApproval).toContain(JOURNEY.orch);
    // Nothing is approved yet, so the verdict half is deliberately silent —
    // asserted here so the post-lock assertion below means something.
    expect(statusBeforeApproval.toLowerCase()).not.toContain('approved:');
  });

  it('wairon status prints the completeness graph', async () => {
    const res = await runCli(['status'], proj.dir);
    expect(res.code, fullOutput(res)).toBe(0);
    expect(res.stdout).toContain(JOURNEY.subsystem);
  });

  it('wairon lock-check passes with a notice before anything is approved', async () => {
    const res = await runCli(['lock-check'], proj.dir);
    expect(res.code, fullOutput(res)).toBe(0);
    expect(`${res.stdout}${res.stderr}`).toContain('No approval on record');
  });

  it('wairon lock --yes records an approval the gate then accepts', async () => {
    const locked = await runCli(['lock', '--yes'], proj.dir);
    expect(locked.code, fullOutput(locked)).toBe(0);

    const gate = await runCli(['lock-check'], proj.dir);
    expect(gate.code, fullOutput(gate)).toBe(0);
    expect(`${gate.stdout}${gate.stderr}`).toContain('is the approved design');
  });

  it('wairon status carries the approval verdict once there is one', async () => {
    const res = await runCli(['status'], proj.dir);
    expect(res.code, fullOutput(res)).toBe(0);
    expect(res.stdout).toContain(JOURNEY.subsystem);
    // The verdict the terminal and the MCP tool must answer alike. It reaches
    // the command through the core barrel, so a lost forward shows up here.
    expect(`${res.stdout}${res.stderr}`, fullOutput(res)).toContain('Approved:');
  });
});
