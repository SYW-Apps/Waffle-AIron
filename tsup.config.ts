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
  // swagger-ui-dist ships ~1.5 MB of prebuilt browser assets we read from disk at
  // runtime (never import) — keep it external so it isn't inlined into the bundle.
  external: ['swagger-ui-dist'],
  // @wairon/sdk is an UNPUBLISHED workspace sibling (source under sdk/). tsup
  // externalizes package.json dependencies by default, but the distributed CLI /
  // hosting image has no node_modules/@wairon/sdk to resolve at runtime — so bundle
  // it (and its pure-JS zip dep fflate) INTO dist. js-yaml stays external (a real
  // root dependency present in the runtime node_modules).
  noExternal: ['@wairon/sdk', 'fflate'],
  // Copy non-TS assets (YAML templates, bundles) into dist
  // These are referenced at runtime by the CLI
  loader: {
    '.yaml': 'copy',
    '.yml': 'copy',
    '.md': 'copy',
  },
});
