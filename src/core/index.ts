export * from './detection.js';
export * from './domains.js';
export * from './templates.js';
export * from './validation.js';
export * from './extensions.js';
export * from './variants.js';
export * from './rules/index.js';
export * from './specs.js';
export * from './provision.js';
export * from './diagram.js';
export * from './lockfile.js';
export * from './statehash.js';
export * from './agent_resolver.js';
export * from './skills.js';
export * from './context.js';
export * from './surfaces.js';
export * from './openapi.js';
export * from './packstore.js';

// Two components legitimately expose a `loadProjectExtensions`: sdd_core's real
// pack loader (extensions.js) and sdd_skills' thin client adapter onto it
// (skills.js, named for the contract method it realizes). On the PUBLIC core
// surface the loader is the one callers mean — stated explicitly so the star
// exports above are not ambiguous.
export { loadProjectExtensions } from './extensions.js';

// Live delegation-brief composition (icore_portal composeAgentBrief) — a pure
// 1:1 forward to the agent resolver, stated explicitly for the anchored
// conformance check.
export { composeAgentBrief } from './agent_resolver.js';
