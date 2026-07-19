import { startHostServer } from '../../src/server/http.js';

// ---------------------------------------------------------------------------
// Subprocess driver for dataplane-content.test.ts — boots the REAL hosted
// server (startHostServer: data plane + admin plane + lifecycle init) against
// a test-seeded data dir. Run under `node --import tsx` so the scoped MCP
// server's lazy CJS requires (requireSpecs & co) resolve exactly as they do in
// the shipped build — something the vitest in-process transform cannot do.
// The test process talks to it over real HTTP with real minted credentials.
// ---------------------------------------------------------------------------

startHostServer({
  host: '127.0.0.1',
  port: Number(process.env.DRIVER_PORT),
  adminHost: '127.0.0.1',
  adminPort: Number(process.env.DRIVER_ADMIN_PORT),
  dataDir: process.env.DRIVER_DATA_DIR!,
  authEnabled: true,
});
