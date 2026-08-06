import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Golden test for examples/hosted-server — keeps the shipped hosting-server
// demo honest by running the self-verifying demo end-to-end: provision an
// isolated project, enforce data-plane auth, make a project-scoped tool call,
// and exercise the state-scoped lock / promote (including the TOCTOU guard).
//
// It must NOT build the project itself. `npm run build` runs `prebuild`
// (`npm --prefix sdk run build`), and tsup CLEANS sdk/dist — so building from
// inside a test deletes a shared artifact while ~126 other test files are
// loading in parallel workers. Any file importing `@wairon/sdk` in that window
// dies with "Cannot find module '/sdk/dist/index.js'", which is exactly the
// intermittent 6–7 server-suite failure this used to cause: invisible when the
// file runs alone, and more likely the more tests the suite gains.
//
// CI builds before `npm test`, so the artifacts are there; locally the message
// below says what to run.
// ---------------------------------------------------------------------------

const ROOT = path.resolve(process.cwd());

describe('examples/hosted-server (hosting server demo)', () => {
  it('runs the end-to-end demo to green', () => {
    // The demo drives the BUILT CLI, so require the build rather than producing
    // it — a missing build is a setup problem, not something to fix mid-suite.
    const cli = path.join(ROOT, 'dist', 'cli', 'index.js');
    const sdk = path.join(ROOT, 'sdk', 'dist', 'index.js');
    expect(
      fs.existsSync(cli) && fs.existsSync(sdk),
      `Build artifacts missing (dist/cli/index.js and sdk/dist/index.js). Run \`npm run build\` before \`npm test\`.`,
    ).toBe(true);

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
