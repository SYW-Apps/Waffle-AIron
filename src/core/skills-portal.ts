// ---------------------------------------------------------------------------
// skills_portal — sdd_skills' published entry point: one-to-one forwards to
// the skills workflows in ./skills.ts (the export, listing and freshness
// workflow, and the MCP resource workflow).
//
// A module of its own so the portal -> orchestrator hop is a real import edge.
// When the portal's methods were the orchestrators' own functions, every
// collaborator those functions reached (skill_resources, server_instructions)
// counted as an undeclared hop of the portal. Client adapters import from
// here, never from ./skills.ts.
// ---------------------------------------------------------------------------
import * as skillsOrchestrator from './skills.js';
import type { SkillFreshness, SkillResourceDescriptor, SkillsExportResult } from './skills.js';

export function exportSddSkills(targetTypes?: string[]): SkillsExportResult {
  return skillsOrchestrator.exportSddSkills(targetTypes);
}

export function listSkillNames(): string[] {
  return skillsOrchestrator.listSkillNames();
}

export function checkSkillFreshness(type: string): SkillFreshness {
  return skillsOrchestrator.checkSkillFreshness(type);
}

export function listResources(): SkillResourceDescriptor[] {
  return skillsOrchestrator.listResources();
}

export function readResource(resourceId: string): string {
  return skillsOrchestrator.readResource(resourceId);
}

export function buildServerInstructions(): string {
  return skillsOrchestrator.buildServerInstructions();
}
