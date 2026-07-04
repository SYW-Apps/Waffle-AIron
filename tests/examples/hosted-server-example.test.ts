import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Golden test for examples/hosted-server — keeps the shipped hosting-server
// demo honest. It builds the project first (so a fresh clone with no dist/
// still works), then runs the self-verifying demo end-to-end: provision an
// isolated project, enforce data-plane auth, make a project-scoped tool call,
// and exercise the state-scoped lock / promote (including the TOCTOU guard).
// ---------------------------------------------------------------------------

const ROOT = path.resolve(process.cwd());

describe('examples/hosted-server (hosting server demo)', () => {
  it('builds, then runs the end-to-end demo to green', () => {
    // Build first — a fresh clone has no dist/, and the demo drives the built CLI.
    // Single command string + shell:true so Windows resolves npm.cmd (Node won't
    // run .cmd files directly) without tripping the args+shell deprecation.
    const build = spawnSync('npm run build', { cwd: ROOT, encoding: 'utf8', shell: true });
    expect(build.status, build.stderr || build.stdout).toBe(0);

    // Randomize ports so a co-running dev server (default 8987/8988) can't clash.
    const port = 8900 + Math.floor(Math.random() * 90);
    const demo = spawnSync('node', [path.join('examples', 'hosted-server', 'demo.mjs')], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, DEMO_PORT: String(port), DEMO_ADMIN_PORT: String(port + 1000) },
    });

    if (demo.status !== 0) console.error(demo.stdout, demo.stderr);
    expect(demo.status).toBe(0);
    expect(demo.stdout).toContain('all checks passed');
  }, 180_000);
});
