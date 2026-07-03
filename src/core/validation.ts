import { AgentRecord } from '../models/agent.js';
import { ProjectConfig, RulesConfig } from '../models/project.js';
import { Registry } from '../models/registry.js';

import {
  loadSystemSpec,
  loadSubsystemSpecs,
  loadComponentSpecs,
  loadInterfaceSpecs,
  loadImplementationSpecs,
  loadTypeSpecs,
  clearLoaderIssues,
  getLoaderIssues,
  scanAllSpecs,
} from './specs.js';
import { buildRuleContext, composeRuleSequence, makeScopeFilter } from './rules/index.js';
import { LoadedExtensions, loadProjectExtensions } from './extensions.js';

// ---------------------------------------------------------------------------
// Validation
//
// The SDD conformance checks themselves live in ./rules/ as a registry of
// documented SddRule modules (the "custom linter"). This module is the public
// entry point: it loads the spec tree, surfaces loader issues, builds the rule
// context, and runs the registry. Registry/topology and project-config
// validation (non-SDD) also live here.
// ---------------------------------------------------------------------------

export interface ValidationIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  /** Optional: agent id related to the issue */
  agentId?: string;
  specId?: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

function issue(
  severity: ValidationIssue['severity'],
  code: string,
  message: string,
  agentId?: string,
  specId?: string,
): ValidationIssue {
  return { severity, code, message, agentId, specId };
}

// ---------------------------------------------------------------------------
// Registry validation
// ---------------------------------------------------------------------------

export function validateRegistry(registry: Registry, rules: RulesConfig): ValidationResult {
  const issues: ValidationIssue[] = [];

  // Duplicate agent ids
  const idCounts = new Map<string, number>();
  for (const agent of registry.agents) {
    idCounts.set(agent.id, (idCounts.get(agent.id) ?? 0) + 1);
  }
  for (const [id, count] of idCounts) {
    if (count > 1) {
      issues.push(issue('error', 'DUPLICATE_AGENT_ID', `Duplicate agent id: "${id}"`, id));
    }
  }

  // Per-agent checks
  for (const agent of registry.agents) {
    validateAgent(agent, rules, issues);
  }

  // Overlapping ownership
  if (rules.noOverlappingOwnership) {
    checkOverlappingOwnership(registry.agents, issues);
  }

  return {
    valid: issues.every((i) => i.severity !== 'error'),
    issues,
  };
}

function validateAgent(
  agent: AgentRecord,
  rules: RulesConfig,
  issues: ValidationIssue[],
): void {
  const isMeta = agent.tags.some((t) => rules.metaAgentTags.includes(t));

  if (rules.requireOwnedPaths && !isMeta && agent.ownedPaths.length === 0) {
    issues.push(
      issue(
        'warning',
        'NO_OWNED_PATHS',
        `Agent "${agent.id}" has no ownedPaths. Add paths or tag as meta/guardian.`,
        agent.id,
      ),
    );
  }

  if (agent.targets.length === 0) {
    issues.push(
      issue('warning', 'NO_TARGETS', `Agent "${agent.id}" has no output targets configured.`, agent.id),
    );
  }
}

function checkOverlappingOwnership(agents: AgentRecord[], issues: ValidationIssue[]): void {
  // Simple exact-match check — a full glob overlap check is a future improvement
  const pathToAgents = new Map<string, string[]>();

  for (const agent of agents) {
    for (const p of agent.ownedPaths) {
      const owners = pathToAgents.get(p) ?? [];
      owners.push(agent.id);
      pathToAgents.set(p, owners);
    }
  }

  for (const [p, owners] of pathToAgents) {
    if (owners.length > 1) {
      issues.push(
        issue(
          'error',
          'OVERLAPPING_OWNERSHIP',
          `Path "${p}" is claimed by multiple agents: ${owners.join(', ')}`,
        ),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Project config validation
// ---------------------------------------------------------------------------

export function validateProjectConfig(config: ProjectConfig): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (config.targets.length === 0) {
    issues.push(issue('error', 'NO_TARGETS', 'No output targets configured in project.yaml'));
  }

  const enabled = config.targets.filter((t) => {
    if (typeof t === 'string') return true;
    return t.enabled !== false;
  });

  if (enabled.length === 0) {
    issues.push(issue('error', 'NO_ENABLED_TARGETS', 'All configured targets are disabled'));
  }

  return {
    valid: issues.every((i) => i.severity !== 'error'),
    issues,
  };
}

// ---------------------------------------------------------------------------
// SDD Spec Tree Validation (rule registry entry point)
// ---------------------------------------------------------------------------

export interface ValidationOptions {
  rules?: RulesConfig;
  projectType?: string;
  scopeSubsystem?: string;
  recursive?: boolean | number;
  /**
   * Pre-loaded extension packs (the programmatic-wrapper path). When omitted,
   * the packs declared in the project's own config are loaded — so CLI and
   * MCP callers get pack rules/profiles/languages without passing anything.
   */
  extensions?: LoadedExtensions;
}

export function validateSddTree(
  rulesOrOptions?: RulesConfig | ValidationOptions,
  projectType: string = 'backend'
): ValidationResult {
  let rules = rulesOrOptions as RulesConfig | undefined;
  let scopeSubsystem: string | undefined;
  let recursive: boolean | number = true;
  let extensions: LoadedExtensions | undefined;

  if (rulesOrOptions && ('scopeSubsystem' in rulesOrOptions || 'recursive' in rulesOrOptions || 'rules' in rulesOrOptions || 'projectType' in rulesOrOptions || 'extensions' in rulesOrOptions)) {
    const opts = rulesOrOptions as ValidationOptions;
    rules = opts.rules;
    projectType = opts.projectType ?? 'backend';
    scopeSubsystem = opts.scopeSubsystem;
    recursive = opts.recursive ?? true;
    extensions = opts.extensions;
  }
  extensions ??= loadProjectExtensions();

  // Configure spec loader recursion
  scanAllSpecs({ recursive });

  const issues: ValidationIssue[] = [];

  // Load specs
  clearLoaderIssues();
  const system = loadSystemSpec();
  const subsystems = loadSubsystemSpecs();
  const components = loadComponentSpecs();
  const interfaces = loadInterfaceSpecs();
  const implementations = loadImplementationSpecs();
  const types = loadTypeSpecs();

  // Retrieve any loader schema validation issues
  const isSpecInScope = makeScopeFilter({ components, interfaces, implementations, types, scopeSubsystem });
  const loaderErrors = getLoaderIssues();
  if (scopeSubsystem) {
    issues.push(...loaderErrors.filter(e => e.specId && isSpecInScope(e.specId)));
  } else {
    issues.push(...loaderErrors);
  }

  if (!system) {
    issues.push(issue('error', 'MISSING_SYSTEM_SPEC', 'L0 System specification (.system.yaml) is missing.'));
    return { valid: false, issues };
  }

  // A pack that fails to load is an error, never a silent skip — otherwise
  // the gate would quietly run without the doctrine the project declared.
  for (const err of extensions.errors) {
    issues.push(issue('error', 'EXTENSION_LOAD_ERROR', err));
  }

  const ctx = buildRuleContext({
    system,
    subsystems,
    components,
    interfaces,
    implementations,
    types,
    rules,
    projectType,
    scopeSubsystem,
    extensions,
    issues,
  });

  for (const rule of composeRuleSequence(extensions.rules)) {
    rule.check(ctx);
  }

  return {
    valid: issues.every((i) => i.severity !== 'error'),
    issues,
  };
}
