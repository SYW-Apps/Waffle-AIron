import { AgentRecord } from '../models/agent.js';
import { ProjectConfig, RulesConfig } from '../models/project.js';
import { Registry } from '../models/registry.js';
import {
  loadSystemSpec,
  loadSubsystemSpecs,
  loadComponentSpecs,
  loadInterfaceSpecs,
  loadImplementationSpecs,
  clearLoaderIssues,
  getLoaderIssues,
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

export function validateSddTree(rules?: RulesConfig): ValidationResult {
  const issues: ValidationIssue[] = [];

  // Load specs
  clearLoaderIssues();
  const system = loadSystemSpec();
  const subsystems = loadSubsystemSpecs();
  const components = loadComponentSpecs();
  const interfaces = loadInterfaceSpecs();
  const implementations = loadImplementationSpecs();

  // Retrieve any loader schema validation issues
  const loaderErrors = getLoaderIssues();
  issues.push(...loaderErrors);

  if (!system) {
    issues.push(issue('error', 'MISSING_SYSTEM_SPEC', 'L0 System specification (system.yaml) is missing.'));
    return { valid: false, issues };
  }

  const componentMap = new Map(components.map(c => [c.id, c]));
  const subsystemIds = new Set(subsystems.map(s => s.id));
  const componentIds = new Set(components.map(c => c.id));
  const interfaceIds = new Set(interfaces.map(i => i.id));

  // Helper to check if component or parent subsystem is draft/design
  const isComponentDraft = (compId: string): boolean => {
    const comp = componentMap.get(compId);
    if (!compId || !comp) return false;
    if (comp.status === 'draft' || comp.status === 'design') return true;
    
    const sub = subsystems.find(s => s.id === comp.subsystem);
    if (sub && (sub.status === 'draft' || sub.status === 'design')) return true;
    
    return false;
  };

  // Helper to determine rule severity based on user config and draft status
  const getRuleSeverity = (
    ruleCode: string,
    defaultSeverity: 'error' | 'warning',
    isDraftContext?: boolean
  ): 'error' | 'warning' | 'off' => {
    if (rules?.sddRuleSeverity?.[ruleCode]) {
      return rules.sddRuleSeverity[ruleCode];
    }

    if (isDraftContext) {
      const completenessRules = [
        'MISSING_IMPLEMENTATION_METHOD',
        'MISSING_HTTP_ENDPOINT',
        'MISSING_GRPC_ENDPOINT',
        'MISSING_EVENT_SUBSCRIPTION',
        'MISSING_PORTAL_TYPE',
        'INVALID_TARGET_METHOD_REFERENCE',
        'INVALID_TARGET_COMPONENT_REFERENCE',
        'MISSING_TARGET_METHOD',
        'MISSING_TARGET_COMPONENT',
        'UNEXPECTED_IMPLEMENTATION_METHOD',
        'INVALID_INTERFACE_REFERENCE',
        'INVALID_COMPONENT_REFERENCE',
        'INVALID_SUBSYSTEM_REFERENCE',
        'ORPHANED_SUBSYSTEM',
      ];
      if (completenessRules.includes(ruleCode)) {
        return 'warning';
      }
    }

    return defaultSeverity;
  };

  const addIssue = (
    defaultSeverity: 'error' | 'warning',
    code: string,
    message: string,
    specId?: string,
    isDraftContext?: boolean
  ) => {
    const severity = getRuleSeverity(code, defaultSeverity, isDraftContext);
    if (severity !== 'off') {
      issues.push(issue(severity, code, message, undefined, specId));
    }
  };

  // Add draft warnings for informational purposes
  for (const sub of subsystems) {
    if (sub.status === 'draft' || sub.status === 'design') {
      addIssue('warning', 'DRAFT_SUBSYSTEM_WARNING', `Subsystem "${sub.id}" is in draft/design status.`, sub.id, true);
    }
  }
  for (const comp of components) {
    if (isComponentDraft(comp.id)) {
      addIssue('warning', 'DRAFT_COMPONENT_WARNING', `Component "${comp.id}" is in draft/design status.`, comp.id, true);
    }
  }

  // 1. Hierarchy & Integrity Checks
  // Check subsystems reference parent system
  for (const sub of subsystems) {
    const isDraftCtx = sub.status === 'draft' || sub.status === 'design';
    if (!sub.parentSystem || sub.parentSystem !== system.name) {
      addIssue(
        'warning',
        'ORPHANED_SUBSYSTEM',
        `Subsystem "${sub.id}" does not reference system "${system.name}".`,
        sub.id,
        isDraftCtx
      );
    }
  }

  // Check components reference existing subsystem
  for (const comp of components) {
    const isDraftCtx = isComponentDraft(comp.id);
    if (!subsystemIds.has(comp.subsystem)) {
      addIssue(
        'error',
        'INVALID_SUBSYSTEM_REFERENCE',
        `Component "${comp.id}" references non-existent subsystem "${comp.subsystem}".`,
        comp.id,
        isDraftCtx
      );
    }
  }

  // Check interfaces reference existing component
  for (const intf of interfaces) {
    const isDraftCtx = isComponentDraft(intf.component) || intf.status === 'draft' || intf.status === 'design';
    if (!componentIds.has(intf.component)) {
      addIssue(
        'error',
        'INVALID_COMPONENT_REFERENCE',
        `Interface "${intf.id}" references non-existent component "${intf.component}".`,
        intf.id,
        isDraftCtx
      );
    }
  }

  // Check implementations reference existing interface
  for (const impl of implementations) {
    const contract = interfaces.find(i => i.id === impl.contract);
    const isDraftCtx = impl.status === 'draft' || impl.status === 'design' || (contract && (isComponentDraft(contract.component) || contract.status === 'draft' || contract.status === 'design'));
    if (!interfaceIds.has(impl.contract)) {
      addIssue(
        'error',
        'INVALID_INTERFACE_REFERENCE',
        `Implementation "${impl.id}" references non-existent interface contract "${impl.contract}".`,
        impl.id,
        isDraftCtx
      );
    }
  }

  // 2. Interface / Implementation Method Contract Validation
  const interfaceMap = new Map(interfaces.map(i => [i.id, i]));

  for (const impl of implementations) {
    const contract = interfaceMap.get(impl.contract);
    if (!contract) continue;

    const isDraftCtx = impl.status === 'draft' || impl.status === 'design' || isComponentDraft(contract.component) || contract.status === 'draft' || contract.status === 'design';

    const contractMethodNames = new Set(contract.methods.map(m => m.name));
    const implMethodNames = new Set(impl.methods.map(m => m.name));

    // Check implementation has extra methods not defined in interface
    for (const implMethod of impl.methods) {
      if (!contractMethodNames.has(implMethod.name)) {
        addIssue(
          'error',
          'UNEXPECTED_IMPLEMENTATION_METHOD',
          `Implementation "${impl.id}" implements method "${implMethod.name}" which is not defined on contract "${contract.id}".`,
          impl.id,
          isDraftCtx
        );
      }
    }

    // Check implementation is missing methods defined in interface
    for (const contractMethod of contract.methods) {
      if (!implMethodNames.has(contractMethod.name)) {
        addIssue(
          'warning',
          'MISSING_IMPLEMENTATION_METHOD',
          `Implementation "${impl.id}" is missing implementation for contract method "${contractMethod.name}" from interface "${contract.id}".`,
          impl.id,
          isDraftCtx
        );
      }
    }

    // 3. Level 5 Narrative Step Validation
    for (const implMethod of impl.methods) {
      for (const step of implMethod.narrative) {
        if (step.type === 'call') {
          if (!step.targetComponent) {
            addIssue(
              'error',
              'MISSING_TARGET_COMPONENT',
              `Method "${implMethod.name}" in implementation "${impl.id}" has a call step (${step.stepNumber}) missing "targetComponent".`,
              impl.id,
              isDraftCtx
            );
            continue;
          }

          if (!step.targetMethod) {
            addIssue(
              'error',
              'MISSING_TARGET_METHOD',
              `Method "${implMethod.name}" in implementation "${impl.id}" has a call step (${step.stepNumber}) missing "targetMethod".`,
              impl.id,
              isDraftCtx
            );
            continue;
          }

          const targetComp = componentMap.get(step.targetComponent);
          if (!targetComp) {
            addIssue(
              'error',
              'INVALID_TARGET_COMPONENT_REFERENCE',
              `Method "${implMethod.name}" in implementation "${impl.id}" calls component "${step.targetComponent}" which does not exist (step ${step.stepNumber}).`,
              impl.id,
              isDraftCtx || isComponentDraft(step.targetComponent)
            );
            continue;
          }

          // Check if calling component declares targetComponent as dependency
          const callingComponent = componentMap.get(contract.component);
          if (callingComponent && step.targetComponent !== callingComponent.id) {
            if (!callingComponent.dependsOn.includes(step.targetComponent)) {
              addIssue(
                'error',
                'UNDECLARED_DEPENDENCY_CALL',
                `Method "${implMethod.name}" in implementation "${impl.id}" (component "${callingComponent.id}") calls component "${step.targetComponent}" (step ${step.stepNumber}) but component "${callingComponent.id}" does not list "${step.targetComponent}" as a dependency.`,
                impl.id,
                isDraftCtx || isComponentDraft(callingComponent.id)
              );
            }
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
            addIssue(
              'error',
              'INVALID_TARGET_METHOD_REFERENCE',
              `Method "${implMethod.name}" in implementation "${impl.id}" calls method "${step.targetMethod}" on component "${step.targetComponent}" which is not defined on any of its interfaces (step ${step.stepNumber}).`,
              impl.id,
              isDraftCtx || isComponentDraft(step.targetComponent)
            );
          }
        }
      }
    }
  }

  // 4. Component Type Interaction Rules (Architectural Boundaries)
  for (const comp of components) {
    const isDraftCtx = isComponentDraft(comp.id);

    // Portal validations
    if (comp.componentType === 'Portal') {
      if (!comp.portalType) {
        addIssue(
          'error',
          'MISSING_PORTAL_TYPE',
          `Component "${comp.id}" has type "Portal" but is missing "portalType" field.`,
          comp.id,
          isDraftCtx
        );
      } else if (comp.portalType === 'HTTP_API') {
        const compInterfaces = interfaces.filter(i => i.component === comp.id);
        for (const intf of compInterfaces) {
          const isIntfDraft = intf.status === 'draft' || intf.status === 'design';
          for (const m of intf.methods) {
            if (!m.httpEndpoint) {
              addIssue(
                'error',
                'MISSING_HTTP_ENDPOINT',
                `Method "${m.name}" on interface "${intf.id}" (Portal HTTP_API) is missing "httpEndpoint" mapping.`,
                intf.id,
                isDraftCtx || isIntfDraft
              );
            }
          }
        }
      } else if (comp.portalType === 'gRPC') {
        const compInterfaces = interfaces.filter(i => i.component === comp.id);
        for (const intf of compInterfaces) {
          const isIntfDraft = intf.status === 'draft' || intf.status === 'design';
          for (const m of intf.methods) {
            if (!m.grpcEndpoint) {
              addIssue(
                'error',
                'MISSING_GRPC_ENDPOINT',
                `Method "${m.name}" on interface "${intf.id}" (Portal gRPC) is missing "grpcEndpoint" mapping.`,
                intf.id,
                isDraftCtx || isIntfDraft
              );
            }
          }
        }
      } else if (comp.portalType === 'MessageBus') {
        const compInterfaces = interfaces.filter(i => i.component === comp.id);
        for (const intf of compInterfaces) {
          const isIntfDraft = intf.status === 'draft' || intf.status === 'design';
          for (const m of intf.methods) {
            if (!m.eventSubscription) {
              addIssue(
                'error',
                'MISSING_EVENT_SUBSCRIPTION',
                `Method "${m.name}" on interface "${intf.id}" (Portal MessageBus) is missing "eventSubscription" mapping.`,
                intf.id,
                isDraftCtx || isIntfDraft
              );
            }
          }
        }
      }
    } else {
      if (comp.portalType !== undefined || comp.basePath !== undefined) {
        addIssue(
          'error',
          'UNEXPECTED_PORTAL_FIELD',
          `Component "${comp.id}" does not have type "Portal" but has "portalType" or "basePath" configured.`,
          comp.id,
          isDraftCtx
        );
      }
    }

    const dependencies = comp.dependsOn;
    for (const depId of dependencies) {
      const depComp = componentMap.get(depId);
      if (!depComp) {
        addIssue(
          'error',
          'INVALID_DEPENDENCY_REFERENCE',
          `Component "${comp.id}" lists dependency "${depId}" which does not exist.`,
          comp.id,
          isDraftCtx
        );
        continue;
      }

      // Check Portal/Observer dependency boundary: components cannot depend on Portals or Observers
      if (depComp.componentType === 'Portal' || depComp.componentType === 'Observer') {
        addIssue(
          'error',
          'ARCHITECTURE_VIOLATION_PORTAL_DEP',
          `Architectural violation: Component "${comp.id}" cannot depend on ${depComp.componentType} component "${depComp.id}". ${depComp.componentType}s are top-level entry points/subscribers and cannot be dependencies.`,
          comp.id,
          isDraftCtx || isComponentDraft(depComp.id)
        );
      }

      // Portal dispatches to Orchestrators (and may read Indexes); it must not reach
      // the data layer directly. Observer forwards to one Orchestrator/Supervisor and
      // may use a message-bus Adapter to subscribe.
      if (comp.componentType === 'Portal' || comp.componentType === 'Observer') {
        const forbiddenTypes = comp.componentType === 'Portal'
          ? ['Store', 'Registry', 'Repository', 'Adapter']
          : ['Store', 'Registry', 'Repository', 'Index'];
        if (forbiddenTypes.includes(depComp.componentType)) {
          addIssue(
            'error',
            'ARCHITECTURE_VIOLATION_PORTAL_FORBIDDEN_DEP',
            `Architectural violation: ${comp.componentType} component "${comp.id}" cannot depend directly on "${depComp.componentType}" component "${depComp.id}". ${comp.componentType}s coordinate through Orchestrators (and Supervisors); they do not reach the data layer directly.`,
            comp.id,
            isDraftCtx || isComponentDraft(depComp.id)
          );
        }
      }

      // Specialist rule: narrow capability. It MAY use Repositories, Indexes, and
      // Adapters, but must not own/drive bus, persistence, or runtime concerns.
      if (comp.componentType === 'Specialist') {
        const forbiddenTypes = ['Portal', 'Observer', 'Orchestrator', 'Store', 'Supervisor'];
        if (forbiddenTypes.includes(depComp.componentType)) {
          addIssue(
            'error',
            'ARCHITECTURE_VIOLATION_SPECIALIST_DEP',
            `Architectural violation: Specialist component "${comp.id}" cannot depend on "${depComp.componentType}" component "${depComp.id}". Specialists are narrow capabilities — they may use Repositories, Indexes, and Adapters, but not Orchestrators, Supervisors, Stores, Portals, or Observers.`,
            comp.id,
            isDraftCtx || isComponentDraft(depComp.id)
          );
        }
      }

      // Store rule: a Store may depend only on another Store or its backend Adapter.
      // It is depended upon by Registries/Indexes — never the reverse.
      if (comp.componentType === 'Store') {
        if (depComp.componentType !== 'Store' && depComp.componentType !== 'Adapter') {
          addIssue(
            'error',
            'ARCHITECTURE_VIOLATION_STORE_DEP',
            `Architectural violation: Store component "${comp.id}" cannot depend on "${depComp.componentType}" component "${depComp.id}". Stores may only depend on other Stores or a backend Adapter.`,
            comp.id,
            isDraftCtx || isComponentDraft(depComp.id)
          );
        }
      }

      // Adapter rule: Adapter is a sink toward the system; it cannot call Orchestrators or Stores
      if (comp.componentType === 'Adapter') {
        if (depComp.componentType === 'Orchestrator' || depComp.componentType === 'Store') {
          addIssue(
            'error',
            'ARCHITECTURE_VIOLATION_ADAPTER_DEP',
            `Architectural violation: Adapter component "${comp.id}" cannot depend on "${depComp.componentType}" component "${depComp.id}". Adapters cannot depend on Orchestrators or Stores.`,
            comp.id,
            isDraftCtx || isComponentDraft(depComp.id)
          );
        }
      }
    }
  }

  // 5. Directed Acyclic Graph (DAG) Cycle Detection
  const visited = new Set<string>();
  const recStack = new Set<string>();

  function dfs(compId: string, pathTrace: string[]): boolean {
    visited.add(compId);
    recStack.add(compId);
    pathTrace.push(compId);

    const comp = componentMap.get(compId);
    if (comp) {
      for (const depId of comp.dependsOn) {
        if (!visited.has(depId)) {
          if (dfs(depId, pathTrace)) {
            recStack.delete(compId);
            pathTrace.pop();
            return true;
          }
        } else if (recStack.has(depId)) {
          pathTrace.push(depId);
          const cyclePath = pathTrace.slice(pathTrace.indexOf(depId)).join(' -> ');
          const isDraftCtx = isComponentDraft(compId) || isComponentDraft(depId);
          addIssue(
            'error',
            'CIRCULAR_DEPENDENCY',
            `Circular dependency detected: ${cyclePath}`,
            compId,
            isDraftCtx
          );
          pathTrace.pop();
          recStack.delete(compId);
          pathTrace.pop();
          return true;
        }
      }
    }

    recStack.delete(compId);
    pathTrace.pop();
    return false;
  }

  for (const comp of components) {
    if (!visited.has(comp.id)) {
      if (dfs(comp.id, [])) {
        break;
      }
    }
  }

  return {
    valid: issues.every((i) => i.severity !== 'error'),
    issues,
  };
}
