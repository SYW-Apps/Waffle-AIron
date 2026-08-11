import { defineConfig } from 'vitest/config';

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
    hookTimeout: 120_000,
  },
});
