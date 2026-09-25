// ---------------------------------------------------------------------------
// cli_skills_adapter — sdd_cli's client hop into sdd_skills: identity
// re-exports of the skills portal. `generate` and `init` export through here,
// `wairon skills` lists through here, and `doctor` checks freshness here.
// ---------------------------------------------------------------------------
export { exportSddSkills, listSkillNames, checkSkillFreshness } from '../../core/skills.js';
