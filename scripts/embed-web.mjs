// Copy the built self-contained React web UI (web/dist/index.html) to
// dist/webapp.html, which the host server (web_portal.serveApp) serves. Run
// AFTER `tsup` (so dist/ exists) and after the web build.
//
// Two modes:
//   - Development (default): when the web bundle is absent (e.g. a backend-only
//     build), this is a no-op and the server falls back to the legacy embedded
//     UI, so a local `npm run build` never needs the web toolchain.
//   - Release (`--require`, or WAIRON_REQUIRE_WEBAPP=1): a missing bundle FAILS
//     the build. The npm publish and binary release workflows set this, so a
//     package can never ship without dist/webapp.html again.
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'web', 'dist', 'index.html');
const destDir = resolve(root, 'dist');
const dest = resolve(destDir, 'webapp.html');
const required = process.argv.includes('--require') || /^(1|true|yes)$/i.test(process.env.WAIRON_REQUIRE_WEBAPP ?? '');

if (!existsSync(src)) {
  if (required) {
    console.error('[embed-web] ERROR: web/dist/index.html not found, and this is a release build (WAIRON_REQUIRE_WEBAPP / --require).');
    console.error('[embed-web] Run `npm run build:web` before `npm run build` (or use `npm run build:all`). Refusing to ship without dist/webapp.html.');
    process.exit(1);
  }
  console.log('[embed-web] web/dist/index.html not found — skipping (server falls back to the legacy UI). Run `npm run build:web` first.');
  process.exit(0);
}
mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log('[embed-web] embedded web/dist/index.html -> dist/webapp.html');
