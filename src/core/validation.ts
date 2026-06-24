import { AgentRecord } from '../models/agent.js';
import { ProjectConfig, RulesConfig } from '../models/project.js';
import { Registry } from '../models/registry.js';
import { SEMANTIC_GUARANTEES, Guarantee, PATTERN_TYPES } from '../models/specs.js';

// Narrative-prose keyword per recognized guarantee — the gate flags a step that uses one
// while calling a method that doesn't declare that guarantee. Keep in sync with SEMANTIC_GUARANTEES.
const GUARANTEE_KEYWORDS: Record<Guarantee, RegExp> = {
  'idempotent': /idempoten/i,
  'atomic': /\batomic/i,
  'transactional': /\btransaction/i,
  'exactly-once': /exactly[\s-]?once/i,
};
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

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const BUILTIN_TYPES = new Set([
  'string', 'str', 'number', 'boolean', 'bool', 'float', 'double', 'int', 'integer',
  'u8', 'u16', 'u32', 'u64', 'u128', 'usize',
  'i8', 'i16', 'i32', 'i64', 'i128', 'isize',
  'f32', 'f64', 'char', 'byte', 'bytes',
  'any', 'void', 'null', 'undefined', 'object',
  'date', 'datetime', 'time', 'timestamp', 'duration',
  'uuid', 'decimal', 'json',
  'list', 'vector', 'vec', 'array', 'map', 'set', 'dict', 'dictionary', 'hashmap', 'tuple',
  'result', 'option', 'box', 'arc', 'rc', 'ref', 'cell', 'refcell', 'mutex', 'rwlock', 'std',
  'promise', 'record', 'json', 'unknown', 'never', 'error', 'mcpserver'
]);

function extractTypeIdentifiers(typeStr: string): string[] {
  return typeStr.match(/[a-zA-Z0-9_-]+(?:::[a-zA-Z0-9_-]+|\.[a-zA-Z0-9_-]+)*/g) || [];
}

function extractGenericTypeVariables(signature: string): Set<string> {
  const vars = new Set<string>();
  const openParen = signature.indexOf('(');
  const beforeParen = openParen !== -1 ? signature.slice(0, openParen) : signature;
  
  const openBracket = beforeParen.indexOf('<');
  const closeBracket = beforeParen.lastIndexOf('>');
  if (openBracket !== -1 && closeBracket !== -1 && closeBracket > openBracket) {
    const varsStr = beforeParen.slice(openBracket + 1, closeBracket);
    const parsedVars = varsStr.split(',').map(v => v.trim().split(/\s+extends\s+/i)[0].split('=')[0].trim());
    for (const v of parsedVars) {
      if (v) vars.add(v);
    }
  }
  return vars;
}

function extractTypesFromSignature(signature: string, returns: string): string[] {
  const types: string[] = [];
  
  // Extract from returns, stripping property names if it's an inline type
  const returnsCleaned = returns.replace(/[a-zA-Z0-9_-]+\s*\??\s*:/g, '');
  types.push(...extractTypeIdentifiers(returnsCleaned));
  
  // Parse parameters: e.g. "listAccounts(options: { yes?: boolean })"
  const openParen = signature.indexOf('(');
  const closeParen = signature.lastIndexOf(')');
  if (openParen !== -1 && closeParen !== -1 && closeParen > openParen) {
    const paramsStr = signature.slice(openParen + 1, closeParen);
    
    let bracketDepth = 0;
    let braceDepth = 0;
    let paramStart = 0;
    const params: string[] = [];
    
    for (let i = 0; i < paramsStr.length; i++) {
      const char = paramsStr[i];
      if (char === '<') bracketDepth++;
      else if (char === '>') bracketDepth--;
      else if (char === '{') braceDepth++;
      else if (char === '}') braceDepth--;
      else if (char === ',' && bracketDepth === 0 && braceDepth === 0) {
        params.push(paramsStr.slice(paramStart, i).trim());
        paramStart = i + 1;
      }
    }
    if (paramStart < paramsStr.length) {
      params.push(paramsStr.slice(paramStart).trim());
    }
    
    for (const param of params) {
      const colonIndex = param.indexOf(':');
      if (colonIndex !== -1) {
        const paramType = param.slice(colonIndex + 1).trim();
        const paramTypeCleaned = paramType.replace(/[a-zA-Z0-9_-]+\s*\??\s*:/g, '');
        types.push(...extractTypeIdentifiers(paramTypeCleaned));
      }
    }
  }
  
  return Array.from(new Set(types));
}

function normalizePart(part: string): string {
  return part.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function matchTypeRef(ref: string, typeId: string): boolean {
  const refParts = ref.split(/::|\./).map(normalizePart).filter(Boolean);
  const typeParts = typeId.split(/::|\./).map(normalizePart).filter(Boolean);

  if (refParts.length === 0 || typeParts.length === 0) return false;
  if (refParts.length > typeParts.length) return false;

  for (let i = 1; i <= refParts.length; i++) {
    if (refParts[refParts.length - i] !== typeParts[typeParts.length - i]) {
      return false;
    }
  }
  return true;
}

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

export interface ValidationOptions {
  rules?: RulesConfig;
  projectType?: string;
  scopeSubsystem?: string;
  recursive?: boolean | number;
}

export function validateSddTree(
  rulesOrOptions?: RulesConfig | ValidationOptions,
  projectType: string = 'backend'
): ValidationResult {
  let rules = rulesOrOptions as RulesConfig | undefined;
  let scopeSubsystem: string | undefined;
  let recursive: boolean | number = true;

  if (rulesOrOptions && ('scopeSubsystem' in rulesOrOptions || 'recursive' in rulesOrOptions || 'rules' in rulesOrOptions || 'projectType' in rulesOrOptions)) {
    const opts = rulesOrOptions as ValidationOptions;
    rules = opts.rules;
    projectType = opts.projectType ?? 'backend';
    scopeSubsystem = opts.scopeSubsystem;
    recursive = opts.recursive ?? true;
  }

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

  // Helper to check if a spec ID is within the requested scopeSubsystem
  const isSpecInScope = (specId: string): boolean => {
    if (!scopeSubsystem) return true;
    if (specId === scopeSubsystem) return true;

    // Check if it is a component
    const comp = components.find(c => c.id === specId);
    if (comp) return comp.subsystem === scopeSubsystem || comp.subsystem.startsWith(`${scopeSubsystem}::`);

    // Check if it is an interface
    const intf = interfaces.find(i => i.id === specId);
    if (intf) {
      const parentComp = components.find(c => c.id === intf.component);
      return parentComp ? (parentComp.subsystem === scopeSubsystem || parentComp.subsystem.startsWith(`${scopeSubsystem}::`)) : false;
    }

    // Check if it is an implementation
    const impl = implementations.find(i => i.id === specId);
    if (impl) {
      const contractIntf = interfaces.find(i => i.id === impl.contract);
      if (contractIntf) {
        const parentComp = components.find(c => c.id === contractIntf.component);
        return parentComp ? (parentComp.subsystem === scopeSubsystem || parentComp.subsystem.startsWith(`${scopeSubsystem}::`)) : false;
      }
      return false;
    }

    // Check if it is a type
    const t = types.find(type => type.id === specId);
    if (t) return t.subsystem === scopeSubsystem || (t.subsystem ? t.subsystem.startsWith(`${scopeSubsystem}::`) : false);

    // Default prefix match fallback
    if (specId.startsWith(`${scopeSubsystem}::`)) return true;

    return false;
  };

  // Retrieve any loader schema validation issues
  const loaderErrors = getLoaderIssues();
  if (scopeSubsystem) {
    issues.push(...loaderErrors.filter(e => e.specId && isSpecInScope(e.specId)));
  } else {
    issues.push(...loaderErrors);
  }

  if (!system) {
    issues.push(issue('error', 'MISSING_SYSTEM_SPEC', 'L0 System specification (system.yaml) is missing.'));
    return { valid: false, issues };
  }

  const componentMap = new Map(components.map(c => [c.id, c]));
  const subsystemIds = new Set(subsystems.map(s => s.id));
  const componentIds = new Set(components.map(c => c.id));
  const interfaceIds = new Set(interfaces.map(i => i.id));

  // A subsystem's published public surface: the component ids bound via its
  // publicInterfaces. Cross-subsystem dependencies may only target these.
  const publicSet = new Map<string, Set<string>>();
  for (const sub of subsystems) {
    publicSet.set(
      sub.id,
      new Set(sub.publicInterfaces.map(pi => pi.component).filter((c): c is string => !!c)),
    );
  }

  // Helper to check if component or parent subsystem is draft/design
  const isComponentDraft = (compId: string): boolean => {
    const comp = componentMap.get(compId);
    if (!compId || !comp) return false;
    if (comp.status === 'draft' || comp.status === 'design') return true;
    
    const sub = subsystems.find(s => s.id === comp.subsystem);
    if (sub && (sub.status === 'draft' || sub.status === 'design')) return true;
    
    return false;
  };

  // Helper to resolve the profile of a component/subsystem
  const getComponentProfile = (compId: string): 'backend' | 'frontend-reactive' | 'frontend-controller' | 'lowlevel-os' | 'game-ecs' | 'realtime-embedded' | 'plc-cyclic' => {
    const comp = componentMap.get(compId);
    if (!comp) return 'backend';
    const sub = subsystems.find(s => s.id === comp.subsystem);
    if (sub && sub.profile) {
      return sub.profile;
    }
    const validProfiles = ['frontend-reactive', 'frontend-controller', 'lowlevel-os', 'game-ecs', 'realtime-embedded', 'plc-cyclic'];
    if (validProfiles.includes(projectType)) {
      return projectType as any;
    }
    return 'backend';
  };

  const isTypeResolved = (ref: string, methodGenerics: Set<string>): boolean => {
    const refLower = ref.toLowerCase();
    if (BUILTIN_TYPES.has(refLower)) return true;
    if (methodGenerics.has(ref)) return true;
    
    return types.some(spec => {
      const typeQualifiedId = spec.subsystem && !spec.id.startsWith(`${spec.subsystem}::`)
        ? `${spec.subsystem}::${spec.id}`
        : spec.id;
      return matchTypeRef(ref, typeQualifiedId);
    });
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
        'MISSING_ENDPOINT',
        'ENDPOINT_TRANSPORT_MISMATCH',
        'MISSING_PORTAL_TYPE',
        'UNEXPECTED_IMPLEMENTATION_METHOD',
        'ORPHANED_SUBSYSTEM',
        'PUBLIC_INTERFACE_UNBOUND',
        'PUBLIC_INTERFACE_TYPE_MISMATCH',
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
    if (scopeSubsystem && specId && !isSpecInScope(specId)) {
      return;
    }
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
    if (!sub.parentSystem || (sub.parentSystem !== system.name && !sub.id.includes('::'))) {
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

  // Check types reference existing subsystem and resolve fields
  for (const t of types) {
    const sub = subsystems.find(s => s.id === t.subsystem);
    const isDraftCtx = sub ? (sub.status === 'draft' || sub.status === 'design') : false;
    if (t.subsystem && !subsystemIds.has(t.subsystem)) {
      addIssue(
        'error',
        'INVALID_SUBSYSTEM_REFERENCE',
        `Type "${t.id}" references non-existent subsystem "${t.subsystem}".`,
        t.id,
        isDraftCtx
      );
    }

    if (t.fields) {
      for (const field of t.fields) {
        const refs = extractTypeIdentifiers(field.type);
        for (const ref of refs) {
          const refLower = ref.toLowerCase();
          if (BUILTIN_TYPES.has(refLower)) {
            continue;
          }
          const resolved = types.find(spec => {
            const typeQualifiedId = spec.subsystem && !spec.id.startsWith(`${spec.subsystem}::`)
              ? `${spec.subsystem}::${spec.id}`
              : spec.id;
            return matchTypeRef(ref, typeQualifiedId);
          });
          if (!resolved) {
            addIssue(
              'error',
              'UNDEFINED_TYPE_REFERENCE',
              `Type "${t.id}" field "${field.name}" references undefined type "${ref}" in "${field.type}".`,
              t.id,
              isDraftCtx
            );
          }
        }
      }
    }
  }

  // 1.5. Interface Method Signature Type Reference Validation
  for (const intf of interfaces) {
    const isDraftCtx = isComponentDraft(intf.component) || intf.status === 'draft' || intf.status === 'design';
    for (const m of intf.methods) {
      const methodGenerics = extractGenericTypeVariables(m.signature);
      const refs = extractTypesFromSignature(m.signature, m.returns);
      for (const ref of refs) {
        if (!isTypeResolved(ref, methodGenerics)) {
          addIssue(
            'error',
            'UNDEFINED_TYPE_REFERENCE',
            `Method "${m.name}" on interface "${intf.id}" references undefined type "${ref}" in signature.`,
            intf.id,
            isDraftCtx
          );
        }
      }
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
          'error',
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
            if (!callingComponent.dependsOn.includes(step.targetComponent) &&
                !callingComponent.owns.includes(step.targetComponent)) {
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
          let targetMethodSpec: (typeof targetInterfaces)[number]['methods'][number] | undefined;
          for (const targetIntf of targetInterfaces) {
            const found = targetIntf.methods.find(m => m.name === step.targetMethod);
            if (found) { targetMethodSpec = found; break; }
          }

          if (!targetMethodSpec) {
            addIssue(
              'error',
              'INVALID_TARGET_METHOD_REFERENCE',
              `Method "${implMethod.name}" in implementation "${impl.id}" calls method "${step.targetMethod}" on component "${step.targetComponent}" which is not defined on any of its interfaces (step ${step.stepNumber}).`,
              impl.id,
              isDraftCtx || isComponentDraft(step.targetComponent)
            );
          } else {
            // Semantic cross-check (consistency, not truth): the gate can't read prose, but
            // it CAN catch a narrative step that asserts a guarantee the contract it calls
            // doesn't declare. Data-driven over the recognized guarantee set — a step whose
            // description claims a guarantee must call a method that lists it in `guarantees`.
            // Whether the method truly delivers it is implementation correctness, not here.
            const declared = new Set(targetMethodSpec.guarantees ?? []);
            for (const g of SEMANTIC_GUARANTEES) {
              if (GUARANTEE_KEYWORDS[g].test(step.description) && !declared.has(g)) {
                addIssue(
                  'warning',
                  'NARRATIVE_SEMANTIC_UNBACKED',
                  `Step ${step.stepNumber} of "${implMethod.name}" in implementation "${impl.id}" asserts "${g}", but the method it calls — "${step.targetMethod}" on "${step.targetComponent}" — does not list "${g}" among its L3 contract guarantees. Declare it on that method (and ensure its shape can deliver it), or revise the narrative.`,
                  impl.id,
                  isDraftCtx || isComponentDraft(step.targetComponent)
                );
              }
            }
          }
        }
      }
    }
  }

  // 4. Component Type Interaction Rules (Architectural Boundaries)
  // Maps a Portal's portalType to the wire `transport` its interface methods must
  // declare on each `endpoint`. Custom is free-form (carries no endpoint obligation).
  const PORTAL_TRANSPORT: Record<string, string | undefined> = {
    HTTP_API: 'HTTP', gRPC: 'gRPC', GraphQL: 'GraphQL', MessageBus: 'MessageBus',
    NamedPipe: 'NamedPipe', IPC: 'IPC', CLI: 'CLI', Custom: undefined,
  };
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
      } else {
        // Generic endpoint check (replaces the old per-transport rules): every Portal
        // whose portalType maps to a transport requires each interface method to
        // declare a concrete `endpoint` of the MATCHING transport. One mechanism for
        // HTTP / gRPC / GraphQL / MessageBus / NamedPipe / IPC / CLI — bound via the
        // generic sdd_set_endpoints tool. Custom carries no obligation.
        const expected = PORTAL_TRANSPORT[comp.portalType];
        if (expected) {
          const compInterfaces = interfaces.filter(i => i.component === comp.id);
          for (const intf of compInterfaces) {
            const isIntfDraft = intf.status === 'draft' || intf.status === 'design';
            for (const m of intf.methods) {
              if (!m.endpoint) {
                addIssue(
                  'error',
                  'MISSING_ENDPOINT',
                  `Method "${m.name}" on interface "${intf.id}" (Portal ${comp.portalType}) is missing an "endpoint" mapping. Bind it with sdd_set_endpoints (transport "${expected}").`,
                  intf.id,
                  isDraftCtx || isIntfDraft
                );
              } else if (m.endpoint.transport !== expected) {
                addIssue(
                  'error',
                  'ENDPOINT_TRANSPORT_MISMATCH',
                  `Method "${m.name}" on interface "${intf.id}" declares a "${m.endpoint.transport}" endpoint, but its Portal "${comp.id}" is portalType "${comp.portalType}" (expects transport "${expected}").`,
                  intf.id,
                  isDraftCtx || isIntfDraft
                );
              }
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

      // Ensure non-portal components do not carry endpoints on their interface methods
      const compInterfaces = interfaces.filter(i => i.component === comp.id);
      for (const intf of compInterfaces) {
        for (const m of intf.methods) {
          if (m.endpoint) {
            addIssue(
              'error',
              'ARCHITECTURE_VIOLATION_NON_PORTAL_ENDPOINT',
              `Architectural violation: Component "${comp.id}" is a ${comp.componentType}, but method "${m.name}" on its interface "${intf.id}" declares an endpoint. Only Portal components may carry endpoints.`,
              comp.id,
              isDraftCtx
            );
          }
        }
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

      // Cross-subsystem boundary: a dependency crossing into another subsystem is
      // governed ONLY by the boundary rules below — the intra-subsystem type matrix
      // does not apply across a bounded-context boundary, where the sanctioned
      // crosser is an Adapter and the target is an explicitly published component.
      if (depComp.subsystem !== comp.subsystem) {
        const crossDraft = isDraftCtx || isComponentDraft(depComp.id);

        // "Always an Adapter": only a (local) client Adapter may reach another
        // subsystem; an Orchestrator/etc. must depend on a local Adapter that
        // abstracts the hop (in-process forwarding, REST, gRPC, IPC).
        if (comp.componentType !== 'Adapter') {
          addIssue(
            'error',
            'CROSS_SUBSYSTEM_NON_ADAPTER',
            `Boundary violation: ${comp.componentType} "${comp.id}" (subsystem "${comp.subsystem}") depends directly on "${depComp.id}" in subsystem "${depComp.subsystem}". Only a local client Adapter may cross a subsystem boundary — route this hop through an Adapter that calls "${depComp.subsystem}"'s public interface.`,
            comp.id,
            crossDraft
          );
        }

        // The target must be part of the other subsystem's published public surface,
        // AND that surface must be the subsystem's inbound Portal (its front door) — not
        // a published internal Specialist/Orchestrator/Store. The hop is always:
        // client Adapter → remote Portal → Portal dispatches inward. Allowing a non-Portal
        // target leaks the boundary and breaks the adapter→network→remote-Portal seam.
        const targetIsPublic = publicSet.get(depComp.subsystem)?.has(depComp.id) ?? false;
        if (!targetIsPublic) {
          addIssue(
            'error',
            'CROSS_SUBSYSTEM_PRIVATE_ACCESS',
            `Boundary violation: "${comp.id}" depends on "${depComp.id}", which is not part of subsystem "${depComp.subsystem}"'s published public surface. Depend on one of its publicInterfaces components instead.`,
            comp.id,
            crossDraft
          );
        } else if (depComp.componentType !== 'Portal' && depComp.componentType !== 'Gateway') {
          addIssue(
            'error',
            'CROSS_SUBSYSTEM_TARGET_NON_PORTAL',
            `Boundary violation: client Adapter "${comp.id}" enters subsystem "${depComp.subsystem}" through "${depComp.id}" (${depComp.componentType}), not its inbound Portal. A cross-subsystem hop must target the remote subsystem's Portal (its front door), which dispatches inward — publishing/depending on an internal ${depComp.componentType} leaks the boundary and breaks the distribution seam. Expose a Portal for "${depComp.subsystem}" and point this Adapter at it.`,
            comp.id,
            crossDraft
          );
        }

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
        if (depComp.componentType !== 'Store' && depComp.componentType !== 'Registry' && depComp.componentType !== 'Adapter') {
          addIssue(
            'error',
            'ARCHITECTURE_VIOLATION_STORE_DEP',
            `Architectural violation: Store component "${comp.id}" cannot depend on "${depComp.componentType}" component "${depComp.id}". Stores may only depend on other Stores, Registries, or a backend Adapter.`,
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

      // Index rule: a read projection — may depend only on its Store or a backend Adapter.
      if (comp.componentType === 'Index') {
        if (depComp.componentType !== 'Store' && depComp.componentType !== 'Adapter') {
          addIssue(
            'error',
            'ARCHITECTURE_VIOLATION_INDEX_DEP',
            `Architectural violation: Index component "${comp.id}" cannot depend on "${depComp.componentType}" component "${depComp.id}". An Index is a read projection and may depend only on its Store or a backend Adapter.`,
            comp.id,
            isDraftCtx || isComponentDraft(depComp.id)
          );
        }
      }

      // View rule: pure presenter block. Decoupled from logical execution and persistence layers.
      if (comp.componentType === 'View') {
        const forbiddenTypes = ['Store', 'Registry', 'Index', 'Adapter', 'Portal', 'Observer', 'Repository', 'Gateway', 'Orchestrator'];
        if (forbiddenTypes.includes(depComp.componentType)) {
          addIssue(
            'error',
            'ARCHITECTURE_VIOLATION_VIEW_DEP',
            `Architectural violation: View component "${comp.id}" cannot depend on "${depComp.componentType}" component "${depComp.id}". Views must remain passive UI blocks and be decoupled from logical layers.`,
            comp.id,
            isDraftCtx || isComponentDraft(depComp.id)
          );
        }
      }
    }
  }

  // 4b. Pattern / ownership rules (owns)
  const ownedBy = new Map<string, string>(); // member block id -> owning pattern id
  for (const comp of components) {
    const isDraftCtx = isComponentDraft(comp.id);
    const isPattern = PATTERN_TYPES.has(comp.componentType);

    if (isPattern && comp.owns.length === 0) {
      addIssue('error', 'EMPTY_PATTERN', `Pattern "${comp.id}" (${comp.componentType}) must own member blocks via "owns".`, comp.id, isDraftCtx);
    }
    if (!isPattern && comp.owns.length > 0) {
      addIssue('error', 'BLOCK_OWNS_MEMBERS', `Building block "${comp.id}" (${comp.componentType}) cannot own members; only patterns (${Array.from(PATTERN_TYPES).join('/')}) use "owns".`, comp.id, isDraftCtx);
    }

    for (const memberId of comp.owns) {
      const member = componentMap.get(memberId);
      if (!member) {
        addIssue('error', 'INVALID_OWNED_MEMBER', `Component "${comp.id}" owns "${memberId}" which does not exist.`, comp.id, isDraftCtx);
        continue;
      }
      if (PATTERN_TYPES.has(member.componentType)) {
        addIssue('error', 'PATTERN_OWNS_PATTERN', `Pattern "${comp.id}" owns "${memberId}", which is itself a pattern. Patterns own only building blocks — compose patterns at the subsystem (L1) level.`, comp.id, isDraftCtx);
      }
      const prev = ownedBy.get(memberId);
      if (prev && prev !== comp.id) {
        addIssue('error', 'SHARED_OWNED_MEMBER', `Block "${memberId}" is owned by both "${prev}" and "${comp.id}"; a block has exactly one owner.`, comp.id, isDraftCtx);
      }
      ownedBy.set(memberId, comp.id);
    }

    // Repository containment: only Store / Registry / Index / Adapter
    if (comp.componentType === 'Repository') {
      const allowed = new Set(['Store', 'Registry', 'Index', 'Adapter']);
      for (const memberId of comp.owns) {
        const t = componentMap.get(memberId)?.componentType;
        if (t && !allowed.has(t)) {
          addIssue('error', 'REPOSITORY_CONTAINMENT', `Repository "${comp.id}" owns "${memberId}" of type ${t}; a Repository may own only Store, Registry, Index, and (optionally) Adapter.`, comp.id, isDraftCtx);
        }
      }
    }

    // Gateway containment: only Portal / Orchestrator / Specialist
    if (comp.componentType === 'Gateway') {
      const allowed = new Set(['Portal', 'Orchestrator', 'Specialist']);
      for (const memberId of comp.owns) {
        const t = componentMap.get(memberId)?.componentType;
        if (t && !allowed.has(t)) {
          addIssue('error', 'GATEWAY_CONTAINMENT', `Gateway "${comp.id}" owns "${memberId}" of type ${t}; a Gateway may own only a Portal, Orchestrators, and Specialists.`, comp.id, isDraftCtx);
        }
      }
    }

    // FeatureComponent containment: exactly one Orchestrator and one View
    if (comp.componentType === 'FeatureComponent') {
      let hasOrchestrator = false;
      let hasView = false;
      for (const memberId of comp.owns) {
        const t = componentMap.get(memberId)?.componentType;
        if (t === 'Orchestrator') hasOrchestrator = true;
        if (t === 'View') hasView = true;
      }
      if (comp.owns.length !== 2 || !hasOrchestrator || !hasView) {
        addIssue('error', 'FEATURE_COMPONENT_CONTAINMENT', `FeatureComponent "${comp.id}" must own exactly one Orchestrator (logic side) and one View (UI side) component.`, comp.id, isDraftCtx);
      }
    }

    // RouterComponent containment: exactly one Portal facade and at least one other child component/View
    if (comp.componentType === 'RouterComponent') {
      let hasPortal = false;
      let hasChildren = false;
      for (const memberId of comp.owns) {
        const t = componentMap.get(memberId)?.componentType;
        if (t === 'Portal') hasPortal = true;
        else if (t) hasChildren = true;
      }
      if (!hasPortal) {
        addIssue('error', 'ROUTER_COMPONENT_CONTAINMENT', `RouterComponent "${comp.id}" must own exactly one Portal component to act as its facade.`, comp.id, isDraftCtx);
      }
      if (!hasChildren) {
        addIssue('error', 'ROUTER_COMPONENT_CONTAINMENT', `RouterComponent "${comp.id}" must own at least one child component/View to route to.`, comp.id, isDraftCtx);
      }
    }
  }

  // 4c. Visibility rule: a component may depend on (a) blocks within its OWN group
  // (it is the owning pattern, or a sibling member of the same pattern), (b) any
  // pattern facade, or (c) a standalone block — never on a block privately owned by
  // ANOTHER pattern.
  for (const comp of components) {
    for (const depId of comp.dependsOn) {
      const owner = ownedBy.get(depId);
      if (!owner) continue;                       // dep is a facade or standalone block — fine
      if (owner === comp.id) continue;            // the owning pattern depending on its own member — fine
      if (ownedBy.get(comp.id) === owner) continue; // a sibling member of the same group — fine
      addIssue('error', 'VISIBILITY_VIOLATION', `Component "${comp.id}" depends on "${depId}", which is privately owned by pattern "${owner}". Depend on the facade "${owner}" instead.`, comp.id, isComponentDraft(comp.id) || isComponentDraft(depId));
    }
  }

  // 4d. Architectural Profile Constraints (backend / frontend-reactive / frontend-controller validation)
  for (const comp of components) {
    const isDraftCtx = isComponentDraft(comp.id);
    const profile = getComponentProfile(comp.id);

    if (profile === 'backend' || profile === 'lowlevel-os' || profile === 'game-ecs' || profile === 'realtime-embedded' || profile === 'plc-cyclic') {
      const frontendTypes = ['View', 'FeatureComponent', 'RouterComponent'];
      if (frontendTypes.includes(comp.componentType)) {
        addIssue(
          'error',
          'FRONTEND_STEREOTYPE_IN_BACKEND',
          `Architectural violation: Component "${comp.id}" is a frontend stereotype (${comp.componentType}) but subsystem "${comp.subsystem}" is configured as a backend-oriented subsystem.`,
          comp.id,
          isDraftCtx
        );
      }

      // PLC Cyclic specific constraints
      if (profile === 'plc-cyclic') {
        if (comp.componentType === 'Actor' || comp.componentType === 'Supervisor') {
          addIssue(
            'error',
            'PLC_CYCLIC_CONCURRENCY_VIOLATION',
            `Architectural violation: Component "${comp.id}" is a concurrent stereotype (${comp.componentType}) which is forbidden in PLC Cyclic profile. PLC logic runs strictly single-threaded within the main execution scan cycle.`,
            comp.id,
            isDraftCtx
          );
        }
      }
    } else {
      const backendOnlyTypes = ['Supervisor', 'Actor'];
      if (backendOnlyTypes.includes(comp.componentType)) {
        addIssue(
          'warning',
          'BACKEND_STEREOTYPE_IN_FRONTEND',
          `Subsystem "${comp.subsystem}" is a frontend subsystem, but component "${comp.id}" is a backend stereotype (${comp.componentType}). Ensure this runtime concern is genuinely client-side.`,
          comp.id,
          isDraftCtx
        );
      }
    }
  }

  // 4e. Public interface binding: each declared publicInterface must be backed by
  // a real component in the SAME subsystem whose type can realize the declared
  // interface. This is what makes "which components are public" machine-checkable
  // (and catches a declared interface that no component actually implements).
  const pubTypeMatches = (piType: string, ct: string, portalType?: string): boolean => {
    switch (piType) {
      case 'REST':       return ct === 'Portal' && portalType === 'HTTP_API';
      case 'GraphQL':    return ct === 'Portal' && portalType === 'GraphQL';
      case 'RPC':        return ct === 'Portal' && portalType === 'gRPC';
      case 'MessageBus': return (ct === 'Portal' && portalType === 'MessageBus') || ct === 'Observer';
      case 'Custom':     return true;
      default:           return true;
    }
  };
  // Strong event/async signal words. Used only to flag a Custom-typed public
  // interface whose prose describes eventing but whose backing component can't
  // realize it (see PUBLIC_INTERFACE_EVENT_MISTYPED below).
  // Verb-form "subscribe" signals eventing; the noun "subscription" is deliberately
  // omitted — it collides with domain nouns (e.g. billing "subscription plans").
  const EVENT_VOCAB = /\b(async|asynchronous|queue|queued|queues|event|events|event-driven|listen|listens|listening|listener|subscribe|subscribes|pub\/sub|stream|streams|streaming|emit|emits|emitted|message[\s-]?bus)\b/i;
  const expectedFor = (t: string): string => {
    switch (t) {
      case 'REST':       return 'a Portal with portalType HTTP_API';
      case 'GraphQL':    return 'a Portal with portalType GraphQL';
      case 'RPC':        return 'a Portal with portalType gRPC';
      case 'MessageBus': return 'a Portal with portalType MessageBus, or an Observer';
      default:           return 'a compatible component';
    }
  };

  for (const sub of subsystems) {
    const isDraftCtx = sub.status === 'draft' || sub.status === 'design';
    for (const pi of sub.publicInterfaces) {
      if (!pi.component) {
        addIssue('error', 'PUBLIC_INTERFACE_UNBOUND', `Subsystem "${sub.id}" declares a ${pi.type} public interface with no backing component. Bind it to the component that realizes it (publicInterfaces[].component).`, sub.id, isDraftCtx);
        continue;
      }
      const backing = componentMap.get(pi.component);
      if (!backing) {
        addIssue('error', 'PUBLIC_INTERFACE_INVALID_COMPONENT', `Subsystem "${sub.id}" public interface references component "${pi.component}" which does not exist.`, sub.id, isDraftCtx);
        continue;
      }
      const isSubsystemOwner = backing.subsystem === sub.id || backing.subsystem.startsWith(sub.id + '::');
      if (!isSubsystemOwner) {
        addIssue('error', 'PUBLIC_INTERFACE_FOREIGN_COMPONENT', `Subsystem "${sub.id}" publishes component "${pi.component}", but it belongs to subsystem "${backing.subsystem}". A subsystem may only publish its own components.`, sub.id, isDraftCtx);
      }
      if (!pubTypeMatches(pi.type, backing.componentType, backing.portalType)) {
        addIssue('error', 'PUBLIC_INTERFACE_TYPE_MISMATCH', `Subsystem "${sub.id}" declares a ${pi.type} public interface backed by "${pi.component}" (${backing.componentType}${backing.portalType ? `/${backing.portalType}` : ''}), which cannot realize ${pi.type}. Expected ${expectedFor(pi.type)}.`, sub.id, isDraftCtx);
      }
      if (pi.interface) {
        const intf = interfaceMap.get(pi.interface);
        if (!intf) {
          addIssue('error', 'PUBLIC_INTERFACE_INVALID_INTERFACE', `Subsystem "${sub.id}" public interface references interface "${pi.interface}" which does not exist.`, sub.id, isDraftCtx);
        } else if (intf.component !== pi.component) {
          addIssue('error', 'PUBLIC_INTERFACE_INVALID_INTERFACE', `Subsystem "${sub.id}" binds interface "${pi.interface}" to component "${pi.component}", but that interface belongs to component "${intf.component}".`, sub.id, isDraftCtx);
        }
      }
      // Heuristic — closes the "escape to Custom" hole. `Custom` is the only public
      // interface type that carries no backing obligation, so an unrealized event
      // boundary can hide there: declare an async queue/event contract as Custom and
      // back it with an ordinary Orchestrator (a synchronous push). The type matrix
      // can't catch that, but the contradiction is legible in the prose — event/async
      // vocabulary in `details` while the backing component cannot actually realize
      // eventing. Warn so the mislabel surfaces; override via rules.sddRuleSeverity.
      if (pi.type === 'Custom' && EVENT_VOCAB.test(pi.details)) {
        const eventCapable = backing.componentType === 'Observer'
          || (backing.componentType === 'Portal' && backing.portalType === 'MessageBus');
        if (!eventCapable) {
          addIssue('warning', 'PUBLIC_INTERFACE_EVENT_MISTYPED', `Subsystem "${sub.id}" declares a Custom public interface whose description implies an event/async boundary ("${pi.details}"), but it is backed by "${pi.component}" (${backing.componentType}${backing.portalType ? `/${backing.portalType}` : ''}), which cannot realize eventing. If this is genuinely event-driven, type it MessageBus and back it with an Observer or a Portal(MessageBus); otherwise reword the description to match the synchronous contract.`, sub.id, isDraftCtx);
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
