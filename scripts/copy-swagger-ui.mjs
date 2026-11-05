// Copy the Swagger UI browser assets the hosted server serves (src/server/swagger.ts)
// from the swagger-ui-dist devDependency into dist/swagger-ui/, together with the
// license texts Apache-2.0 asks to travel with them. Run AFTER `tsup` (which cleans
// dist/); `npm run build` does. The package ships these copies, so installing
// @wairon/cli needs swagger-ui-dist (and the package it brings along) no longer.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = dirname(createRequire(import.meta.url).resolve('swagger-ui-dist/package.json'));
const destDir = resolve(root, 'dist', 'swagger-ui');

// The two files the viewer inlines, then the license, notice and bundled third-party license list.
const FILES = ['swagger-ui.css', 'swagger-ui-bundle.js', 'LICENSE', 'NOTICE', 'swagger-ui-bundle.js.LICENSE.txt'];

mkdirSync(destDir, { recursive: true });
for (const name of FILES) {
  const from = resolve(srcDir, name);
  if (!existsSync(from)) {
    console.error(`[copy-swagger-ui] ERROR: ${from} not found — is the swagger-ui-dist devDependency installed?`);
    process.exit(1);
  }
  copyFileSync(from, resolve(destDir, name));
}
console.log(`[copy-swagger-ui] copied ${FILES.length} files to ${destDir}`);
