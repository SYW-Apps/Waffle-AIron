// ---------------------------------------------------------------------------
// host_surfaces_adapter — sdd_host's client hop into sdd_surfaces: surface
// artifacts generated, and externals status read, against the CURRENTLY BOUND
// project root (callers bind via runWithProjectRoot or, with the request's
// reach, runWithProjectBinding — exactly as they do for the core reads). The
// caller must gate on reach itself.
// ---------------------------------------------------------------------------
export { exportSurface, getExternalsStatus } from '../../core/surface-portal.js';
