import { AgentRecord } from '../models/agent.js';
import { ProjectConfig, RulesConfig } from '../models/project.js';
import { Registry } from '../models/registry.js';
import {
  loadSystemSpec,
  loadSubsystemSpecs,
  loadComponentSpecs,
  loadInterfaceSpecs,
  loadImplementationSpecs,
} from './specs.js';

// ---------------------------------------------------------------------------
// Validation
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
// SDD Spec Tree Validation
// ---------------------------------------------------------------------------

export function validateSddTree(): ValidationResult {
  const issues: ValidationIssue[] = [];

  // Load specs
  const system = loadSystemSpec();
  if (!system) {
    issues.push(issue('error', 'MISSING_SYSTEM_SPEC', 'L0 System specification (system.yaml) is missing.'));
    return { valid: false, issues };
  }

  const subsystems = loadSubsystemSpecs();
  const components = loadComponentSpecs();
  const interfaces = loadInterfaceSpecs();
  const implementations = loadImplementationSpecs();

  // 1. Hierarchy & Integrity Checks
  const subsystemIds = new Set(subsystems.map(s => s.id));
  const componentIds = new Set(components.map(c => c.id));
  const interfaceIds = new Set(interfaces.map(i => i.id));

  // Check subsystems reference parent system
  for (const sub of subsystems) {
    if (!sub.parentSystem || sub.parentSystem !== system.name) {
      issues.push(issue(
        'warning',
        'ORPHANED_SUBSYSTEM',
        `Subsystem "${sub.id}" does not reference system "${system.name}".`,
        undefined,
        sub.id
      ));
    }
  }

  // Check components reference existing subsystem
  for (const comp of components) {
    if (!subsystemIds.has(comp.subsystem)) {
      issues.push(issue(
        'error',
        'INVALID_SUBSYSTEM_REFERENCE',
        `Component "${comp.id}" references non-existent subsystem "${comp.subsystem}".`,
        undefined,
        comp.id
      ));
    }
  }

  // Check interfaces reference existing component
  for (const intf of interfaces) {
    if (!componentIds.has(intf.component)) {
      issues.push(issue(
        'error',
        'INVALID_COMPONENT_REFERENCE',
        `Interface "${intf.id}" references non-existent component "${intf.component}".`,
        undefined,
        intf.id
      ));
    }
  }

  // Check implementations reference existing interface
  for (const impl of implementations) {
    if (!interfaceIds.has(impl.contract)) {
      issues.push(issue(
        'error',
        'INVALID_INTERFACE_REFERENCE',
        `Implementation "${impl.id}" references non-existent interface contract "${impl.contract}".`,
        undefined,
        impl.id
      ));
    }
  }

  // 2. Interface / Implementation Method Contract Validation
  const interfaceMap = new Map(interfaces.map(i => [i.id, i]));
  const componentMap = new Map(components.map(c => [c.id, c]));

  for (const impl of implementations) {
    const contract = interfaceMap.get(impl.contract);
    if (!contract) continue;

    const contractMethodNames = new Set(contract.methods.map(m => m.name));
    const implMethodNames = new Set(impl.methods.map(m => m.name));

    // Check implementation has extra methods not defined in interface
    for (const implMethod of impl.methods) {
      if (!contractMethodNames.has(implMethod.name)) {
        issues.push(issue(
          'error',
          'UNEXPECTED_IMPLEMENTATION_METHOD',
          `Implementation "${impl.id}" implements method "${implMethod.name}" which is not defined on contract "${contract.id}".`,
          undefined,
          impl.id
        ));
      }
    }

    // Check implementation is missing methods defined in interface
    for (const contractMethod of contract.methods) {
      if (!implMethodNames.has(contractMethod.name)) {
        issues.push(issue(
          'warning',
          'MISSING_IMPLEMENTATION_METHOD',
          `Implementation "${impl.id}" is missing implementation for contract method "${contractMethod.name}" from interface "${contract.id}".`,
          undefined,
          impl.id
        ));
      }
    }

    // 3. Level 5 Narrative Step Validation
    for (const implMethod of impl.methods) {
      for (const step of implMethod.narrative) {
        if (step.type === 'call') {
          if (!step.targetComponent) {
            issues.push(issue(
              'error',
              'MISSING_TARGET_COMPONENT',
              `Method "${implMethod.name}" in implementation "${impl.id}" has a call step (${step.stepNumber}) missing "targetComponent".`,
              undefined,
              impl.id
            ));
            continue;
          }

          if (!step.targetMethod) {
            issues.push(issue(
              'error',
              'MISSING_TARGET_METHOD',
              `Method "${implMethod.name}" in implementation "${impl.id}" has a call step (${step.stepNumber}) missing "targetMethod".`,
              undefined,
              impl.id
            ));
            continue;
          }

          const targetComp = componentMap.get(step.targetComponent);
          if (!targetComp) {
            issues.push(issue(
              'error',
              'INVALID_TARGET_COMPONENT_REFERENCE',
              `Method "${implMethod.name}" in implementation "${impl.id}" calls component "${step.targetComponent}" which does not exist (step ${step.stepNumber}).`,
              undefined,
              impl.id
            ));
            continue;
          }

          // Check if target component has an interface containing targetMethod
          const targetInterfaces = interfaces.filter(i => i.component === step.targetComponent);
          let methodFound = false;
          for (const targetIntf of targetInterfaces) {
            if (targetIntf.methods.some(m => m.name === step.targetMethod)) {
              methodFound = true;
              break;
            }
          }

          if (!methodFound) {
            issues.push(issue(
              'error',
              'INVALID_TARGET_METHOD_REFERENCE',
              `Method "${implMethod.name}" in implementation "${impl.id}" calls method "${step.targetMethod}" on component "${step.targetComponent}" which is not defined on any of its interfaces (step ${step.stepNumber}).`,
              undefined,
              impl.id
            ));
          }
        }
      }
    }
  }

  // 4. Component Type Interaction Rules (Architectural Boundaries)
  for (const comp of components) {
    const dependencies = comp.dependencies;
    for (const depId of dependencies) {
      const depComp = componentMap.get(depId);
      if (!depComp) {
        issues.push(issue(
          'error',
          'INVALID_DEPENDENCY_REFERENCE',
          `Component "${comp.id}" lists dependency "${depId}" which does not exist.`,
          undefined,
          comp.id
        ));
        continue;
      }

      // Check Component boundaries:
      // Store rule: Store can only depend on other Store components or Registry
      if (comp.componentType === 'Store') {
        if (depComp.componentType !== 'Store' && depComp.componentType !== 'Registry') {
          issues.push(issue(
            'error',
            'ARCHITECTURE_VIOLATION_STORE_DEP',
            `Architectural violation: Store component "${comp.id}" cannot depend on "${depComp.componentType}" component "${depComp.id}". Stores may only depend on other Stores or Registries.`,
            undefined,
            comp.id
          ));
        }
      }

      // Repository rule: Repository can only depend on Store, Repository, or Adapter
      if (comp.componentType === 'Repository') {
        const allowedTypes = ['Store', 'Repository', 'Adapter'];
        if (!allowedTypes.includes(depComp.componentType)) {
          issues.push(issue(
            'error',
            'ARCHITECTURE_VIOLATION_REPO_DEP',
            `Architectural violation: Repository component "${comp.id}" cannot depend on "${depComp.componentType}" component "${depComp.id}". Repositories may only depend on Store, Repository, or Adapter.`,
            undefined,
            comp.id
          ));
        }
      }

      // Adapter rule: Adapter should act as a leaf node; it cannot call Orchestrators or Stores
      if (comp.componentType === 'Adapter') {
        if (depComp.componentType === 'Orchestrator' || depComp.componentType === 'Store') {
          issues.push(issue(
            'error',
            'ARCHITECTURE_VIOLATION_ADAPTER_DEP',
            `Architectural violation: Adapter component "${comp.id}" cannot depend on "${depComp.componentType}" component "${depComp.id}". Adapters cannot depend on Orchestrators or Stores.`,
            undefined,
            comp.id
          ));
        }
      }
    }
  }

  return {
    valid: issues.every((i) => i.severity !== 'error'),
    issues,
  };
}
