import type { ProjectConfig } from '../../models/project.js';
import { loadProjectConfig as coreLoadProjectConfig } from '../index.js';

// ---------------------------------------------------------------------------
// authoring_core_adapter — sdd_authoring's client hop into sdd_core.
//
// Identity re-exports of the core portals, plus the one forward that is more
// than a name: the configuration read.
// ---------------------------------------------------------------------------
export {
  updateSpec,
  moveMethods,
  loadSpec,
  saveSpec,
  deleteSpec,
  createChainedSubsystem,
} from '../index.js';

/**
 * authoring_core_adapter.loadProjectConfig — the bound project's configuration,
 * or null when it has none OR cannot be read. A configuration read must never be
 * the thing that fails a write closed, so an unreadable project answers like an
 * uninitialized one and the gate judges at the default severities.
 */
export function loadProjectConfig(): ProjectConfig | null {
  try {
    return coreLoadProjectConfig();
  } catch {
    return null;
  }
}
