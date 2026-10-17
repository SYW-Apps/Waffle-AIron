import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import Ajv from 'ajv';
import {
  createScratchProject,
  authorJourneyTree,
  DIST_CLI,
  REPO_ROOT,
  JOURNEY,
  type ScratchProject,
} from './helpers';

// ---------------------------------------------------------------------------
// `wairon export` against the BUILT CLI: a tree authored through the live MCP
// server is exported to stdout, and the JSON is validated against the JSON
// Schema the package SHIPS (schemas/design-export-2.json) — the contract a
// consumer validates against, not the zod schema it was generated from.
// ---------------------------------------------------------------------------

interface CliResult { code: number; stdout: string; stderr: string }

function runCli(args: string[], cwd: string): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(process.execPath, [DIST_CLI, ...args], { cwd, timeout: 120_000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error && typeof (error as unknown as { code?: unknown }).code === 'number'
        ? (error as unknown as { code: number }).code
        : error ? 1 : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

const SHIPPED_SCHEMA = path.join(REPO_ROOT, 'schemas', 'design-export-2.json');

describe('e2e design export (built CLI)', () => {
  let proj: ScratchProject;

  beforeAll(async () => {
    proj = await createScratchProject('design-export');
    await authorJourneyTree(proj.client);
  });

  afterAll(async () => {
    await proj?.cleanup();
  });

  it('prints JSON that validates against the shipped JSON Schema, and nothing else', async () => {
    const r = await runCli(['export'], proj.dir);
    expect(r.code, r.stderr).toBe(0);
    const design = JSON.parse(r.stdout);

    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(JSON.parse(fs.readFileSync(SHIPPED_SCHEMA, 'utf8')));
    expect(validate(design), JSON.stringify(validate.errors?.slice(0, 5))).toBe(true);

    expect(design.format).toBe('wairon-design');
    expect(design.source.approval).toBe('unlocked');
    expect(design.source.approved).toBe(false);
    expect(design.components.map((c: { key: string }) => c.key)).toEqual(expect.arrayContaining([JOURNEY.orch, JOURNEY.worker]));
  });

  it('is byte-identical run to run, and --out writes the same bytes', async () => {
    const a = await runCli(['export'], proj.dir);
    const b = await runCli(['export'], proj.dir);
    expect(b.stdout).toBe(a.stdout);
    const out = path.join(proj.dir, 'out', 'design.json');
    const w = await runCli(['export', '--out', out], proj.dir);
    expect(w.code, w.stderr).toBe(0);
    expect(fs.readFileSync(out, 'utf8')).toBe(a.stdout);
    expect(w.stdout).toContain('approval: unlocked');
  });

  it('refuses a directory with no spec tree', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-e2e-empty-'));
    const r = await runCli(['export'], empty);
    fs.rmSync(empty, { recursive: true, force: true });
    expect(r.code).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/Nothing to export/);
  });
});
