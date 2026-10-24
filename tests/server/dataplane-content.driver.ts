import { startHostServer } from '../../src/server/http.js';

// ---------------------------------------------------------------------------
// Subprocess driver for dataplane-content.test.ts — boots the REAL hosted
// server (startHostServer: data plane + admin plane + lifecycle init) against
// a test-seeded data dir. Run under `node --import tsx` so the scoped MCP
// server's lazy CJS requires (requireSpecs & co) resolve exactly as they do in
// the shipped build — something the vitest in-process transform cannot do.
// The test process talks to it over real HTTP with real minted credentials.
// ---------------------------------------------------------------------------

// Both planes listen on port 0 (the OS picks free ports) and the bound ports are
// printed once up, so the test never probes for a free port and binds it later.
const handle = startHostServer({
  host: '127.0.0.1',
  port: 0,
  adminHost: '127.0.0.1',
  adminPort: 0,
  dataDir: process.env.DRIVER_DATA_DIR!,
  authEnabled: true,
});
void handle.listening.then((ports) => {
  console.log(`DRIVER_LISTENING ${JSON.stringify(ports)}`);
});
