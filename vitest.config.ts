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
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**'],
      exclude: ['src/cli/index.ts'],
    },
  },
});
