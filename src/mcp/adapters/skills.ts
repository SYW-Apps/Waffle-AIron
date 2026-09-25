// ---------------------------------------------------------------------------
// mcp_skills_adapter — sdd_mcp's client hop into sdd_skills: identity
// re-exports of the skills portal. The skill resources resolve relative to the
// package; the server instructions read the request-scoped project root.
// ---------------------------------------------------------------------------
export { listResources, readResource, buildServerInstructions } from '../../core/skills.js';
