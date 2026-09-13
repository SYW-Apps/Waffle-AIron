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
