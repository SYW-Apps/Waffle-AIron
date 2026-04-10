import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'cli/index': 'src/cli/index.ts',
    index: 'src/index.ts',
  },
  format: ['cjs'],
  target: 'node18',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: false,
  bundle: true,
  // Copy non-TS assets (YAML templates, bundles) into dist
  // These are referenced at runtime by the CLI
  loader: {
    '.yaml': 'copy',
    '.yml': 'copy',
    '.md': 'copy',
  },
});
