import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

// The hosted UI is served SELF-CONTAINED by the node host server (one document,
// all JS/CSS inlined) so the strict same-origin CSP and the single-image
// deployment model are preserved — no external asset loads, no separate
// frontend service. `vite build` emits web/dist/index.html; the root build step
// copies it to dist/webapp.html, which web_portal.serveApp serves.
//
// During frontend dev, `npm run dev` (in web/) runs the Vite dev server and
// proxies the API to a locally running host server so the React app talks to
// the real /web + /mcp endpoints.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: 'dist',
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 100_000_000,
    cssCodeSplit: false,
    reportCompressedSize: false,
  },
  server: {
    port: 5199,
    proxy: {
      '/web': { target: 'http://127.0.0.1:8080', changeOrigin: true },
      '/mcp': { target: 'http://127.0.0.1:8080', changeOrigin: true },
      '/view': { target: 'http://127.0.0.1:8080', changeOrigin: true },
    },
  },
});
