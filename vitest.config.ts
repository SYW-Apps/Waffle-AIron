import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // The black-box e2e tier (spawns the BUILT dist/ server + CLI) has its own
    // config: vitest.e2e.config.ts (`npm run test:e2e`). Excluded here so the
    // default `npm test` stays unit-scope and needs no prior build.
    exclude: [...configDefaults.exclude, 'tests/e2e/**'],
    // Several integration-ish files (git subprocesses, MCP skill servers,
    // producers) sit just under the 5s default per-test timeout and flake
    // under full parallel load — and the rule-matrix tier grew the suite
    // enough to tip them regularly. 15s is margin, not license: a test that
    // NEEDS it should still be investigated.
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**'],
      exclude: ['src/cli/index.ts'],
      // Coverage RATCHET floors (apply to `npm run test:coverage` only; plain
      // `npm test` runs without coverage). Set ~1pt under the measured
      // baseline of 2026-08-11 and moved DELIBERATELY, by humans, as coverage
      // rises — never autoUpdate. The rules directory carries its own, higher
      // floor: it is the enforcement engine the rule-matrix tier
      // (tests/rules-matrix/) exists to pin. NOTE: vitest removes files
      // matched by a glob threshold from the global pool, so the global floor
      // is measured EXCLUDING src/core/rules/** (measured then:
      // statements 37.62 / branches 32.18 / functions 42.77 / lines 69.49;
      // rules dir: 90.98 / 82.91 / 94.53 / 94.45).
      thresholds: {
        statements: 36.6,
        branches: 31.2,
        functions: 41.8,
        lines: 68.5,
        'src/core/rules/**': {
          statements: 90.0,
          branches: 81.9,
          functions: 93.5,
          lines: 93.4,
        },
      },
    },
  },
});
