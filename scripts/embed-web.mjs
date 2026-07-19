// Copy the built self-contained React web UI (web/dist/index.html) to
// dist/webapp.html, which the host server (web_portal.serveApp) serves. Run
// AFTER `tsup` (so dist/ exists) and after the web build. When the web bundle is
// absent (e.g. a backend-only build), this is a no-op and the server falls back
// to the legacy embedded UI — nothing breaks.
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'web', 'dist', 'index.html');
const destDir = resolve(root, 'dist');
const dest = resolve(destDir, 'webapp.html');

if (!existsSync(src)) {
  console.log('[embed-web] web/dist/index.html not found — skipping (server falls back to the legacy UI). Run `npm run build:web` first.');
  process.exit(0);
}
mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log('[embed-web] embedded web/dist/index.html -> dist/webapp.html');
