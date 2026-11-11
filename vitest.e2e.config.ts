import { defineConfig } from 'vitest/config';
import * as os from 'node:os';
import * as path from 'node:path';

// Black-box e2e tier: spawns the REAL built server/CLI (dist/cli/index.js) as
// subprocesses and asserts tool results + on-disk YAML. Kept out of the unit
// config (`npm test`) — run with `npm run test:e2e`, AFTER `npm run build`.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/e2e/**/*.test.ts'],
    // Subprocess spawns + full journeys are slow by design; no coverage — the
    // subject under test is the built artifact, not importable source.
    testTimeout: 120_000,
    // wairon's user cache (validation results, git producer clones) goes to a
    // throwaway folder, never the developer's real cache: every fixture root
    // would otherwise leave a results file there.
    env: { WAIRON_CACHE_DIR: process.env.WAIRON_TEST_CACHE_DIR ?? path.join(os.tmpdir(), 'wairon-test-cache') },
    hookTimeout: 120_000,
  },
});
