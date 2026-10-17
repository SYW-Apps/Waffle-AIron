// ---------------------------------------------------------------------------
// host_git_adapter — sdd_host's client hop into sdd_git: identity re-exports
// of the git portal. publish forwards the SCOPED subpath (default .wai/), so
// staging never touches a shared repository's own code.
// ---------------------------------------------------------------------------
export { enable, disable, sync, publish, status, configureSync } from '../../git/index.js';
