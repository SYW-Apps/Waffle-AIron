// ---------------------------------------------------------------------------
// wairon public library API
//
// This module exports the core primitives so wairon can be used
// programmatically by other tools or scripts — without going through the CLI.
// This is the foundation for a future MCP server wrapper.
// ---------------------------------------------------------------------------

import { loadProjectConfig as loadProjectConfigFromCore } from './core/index.js';
import { ProjectNotInitializedError } from './utils/errors.js';
import type { ProjectConfig } from './models/project.js';

export * from './models/index.js';
export * from './config/index.js';
export * from './core/index.js';
export * from './exporters/index.js';
export * from './utils/index.js';

/**
 * The public library's `loadProjectConfig` contract, unchanged since before stage
 * 2a-0: throws `ProjectNotInitializedError` when the bound project has no
 * configuration. This local export takes precedence over the core surface's
 * `loadProjectConfig` re-exported above (via `export * from './core/index.js'`),
 * which returns null instead.
 */
export function loadProjectConfig(): ProjectConfig {
  const config = loadProjectConfigFromCore();
  if (!config) throw new ProjectNotInitializedError();
  return config;
}

// The public library's `activeTargetTypes` stays the zero-argument read of the
// bound project's configuration; the models' pure `activeTargetTypes(config)`
// shares the name, so the intended one is chosen explicitly.
//
// Taken from ./core/skills.js rather than the core barrel because the barrel
// now publishes core's seven portal contracts and nothing else, and no contract
// names this function — none of those seven, not `iskills_portal`. Naming the module
// keeps the public library's behaviour byte-identical while making it visible
// that this export rides on code no spec designed.
export { activeTargetTypes } from './core/skills.js';

// ---------------------------------------------------------------------------
// The embedding API, named rather than inherited.
//
// `docs/extending-wairon.md` and `examples/wrapper/wrapper.js` document these
// as the way a wrapper product compiles its own doctrine into a gate binary,
// and `iextension_orchestrator.load` records that contract in the spec tree
// (`invokedBy: external` — "no internal call chain exists by design"). They
// used to arrive here inside `export * from './core/index.js'`, which is the
// wrong reason for a public API to exist: the core barrel publishes core's
// seven portal contracts, and none of these is on them. So the LIBRARY entry
// names its own surface, from the modules that hold it. Removing one from here
// is a deliberate break of a documented API; losing one because a Portal
// stopped starring a module is not.
// ---------------------------------------------------------------------------
export { validateSddTree } from './core/validation.js';
export {
  loadExtensions,
  loadExtensionPacks,
  emptyExtensions,
  globalPacksDir,
  discoverPacks,
} from './core/extensions.js';
export type { LoadedExtensions, DeclarativePack } from './core/extensions.js';

// The running MCP server asks the build ON DISK for its schema fingerprint by
// requiring this entry in a child process (src/mcp/build.ts): a server whose
// schemas differ from the rebuilt ones refuses spec writes rather than drop
// the fields only the new build knows. The export is that question's answer.
export { schemaFingerprint } from './mcp/server.js';
