import * as path from 'path';
import * as fs from 'fs';
import { AgentBrief, AgentRecord } from '../models/agent.js';
import { loadProjectConfig, AI_PATHS, loadTopologyConfig } from '../config/loader.js';
import { getProjectRoot, pathExists } from '../utils/fs.js';
import { WaironError } from '../utils/errors.js';
import { loadTemplate, loadAgentOverride, renderTemplateInstructions } from './templates.js';
import { deriveExecutionProfile } from './execution_profile.js';
import { resolveBudget } from './budget_policy.js';
import {
  loadSystemSpec,
  loadSubsystemSpecs,
  loadComponentSpecs,
  loadInterfaceSpecs,
  loadImplementationSpecs,
  getSubsystemPath,
  getComponentPath,
  getInterfacePath,
  getImplementationPath,
  resolveSubprojectForNamespace,
} from './specs.js';
import { ComponentSpec } from '../models/specs.js';
import { loadProjectVariants, composeVariantGuidance, type VariantDef } from './variants.js';

// Cache for project files relative to the system root
const projectFilesCache = new Map<string, string[]>();

function listFilesRecursiveSafe(dirPath: string, ext: string): string[] {
  if (!fs.existsSync(dirPath)) return [];
  const nameLower = path.basename(dirPath).toLowerCase();
  const IGNORED_DIRS = new Set([
    'node_modules',
    'target',
    'dist',
    'build',
    '.git',
    '.wai',
    '.claude',
    '.gemini',
    '.codex',
    '.agents',
    '.vscode',
  ]);
  if (IGNORED_DIRS.has(nameLower)) return [];

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursiveSafe(fullPath, ext));
    } else if (entry.isFile() && entry.name.endsWith(ext)) {
      files.push(fullPath);
    }
  }
  return files;
}

function getProjectFiles(projectDir: string): string[] {
  let files = projectFilesCache.get(projectDir);
  if (!files) {
    files = [];
    const srcDir = path.join(projectDir, 'src');
    const legacySrcDir = path.join(projectDir, 'legacy-src');
    
    let searchDir = projectDir;
    if (pathExists(srcDir)) {
      searchDir = srcDir;
    } else if (pathExists(legacySrcDir)) {
      searchDir = legacySrcDir;
    } else if (projectDir === getProjectRoot()) {
      // Avoid scanning the entire monorepo root recursively
      projectFilesCache.set(projectDir, []);
      return [];
    }
    
    const extensions = ['.rs', '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.c', '.cpp', '.cs', '.java', '.kt', '.swift', '.rb', '.php', '.lua'];
    for (const ext of extensions) {
      files.push(...listFilesRecursiveSafe(searchDir, ext));
    }
    const rootDir = getProjectRoot();
    files = files.map(f => path.relative(rootDir, f).replace(/\\/g, '/'));
    projectFilesCache.set(projectDir, files);
  }
  return files;
}

function inferSourcePathForComponent(comp: ComponentSpec, subsystems: any[]): string | null {
  try {
    const projectDir = resolveSubprojectForNamespace(comp.subsystem) || getProjectRoot();
    const files = getProjectFiles(projectDir);
    if (files.length === 0) return null;

    const compRelativeId = comp.id.split('::').pop() || comp.id;
    const subRelativeId = comp.subsystem.split('::').pop() || comp.subsystem;

    let cleanName = compRelativeId;
    if (cleanName.startsWith(`${subRelativeId}-`)) {
      cleanName = cleanName.slice(subRelativeId.length + 1);
    }

    const candidates = new Set<string>();
    candidates.add(cleanName.toLowerCase());
    candidates.add(cleanName.replace(/-/g, '_').toLowerCase());
    candidates.add(compRelativeId.toLowerCase());
    candidates.add(compRelativeId.replace(/-/g, '_').toLowerCase());
    candidates.add(comp.componentType.toLowerCase());

    let bestFile: string | null = null;
    let bestScore = -1;

    for (const f of files) {
      const ext = path.extname(f);
      const base = path.basename(f, ext).toLowerCase();
      if (candidates.has(base)) {
        let score = 0;
        const normalizedPath = f.toLowerCase();
        
        // Match directory to subsystem name or its segments
        const subPattern1 = `/${subRelativeId.toLowerCase()}/`;
        const subPattern2 = `/${subRelativeId.replace(/-/g, '_').toLowerCase()}/`;
        const hasSubsystemSegmentMatch = subRelativeId
          .split(/[-_]/)
          .some((seg: string) => seg.length >= 3 && normalizedPath.includes(`/${seg.toLowerCase()}/`));

        const hasSubsystemMatch = normalizedPath.includes(subPattern1) || 
                                  normalizedPath.includes(subPattern2) || 
                                  hasSubsystemSegmentMatch;

        if (hasSubsystemMatch) {
          score += 10;
        }

        // Deduct points or skip if file belongs to another subsystem folder
        let belongsToOtherSubsystem = false;
        for (const otherSub of subsystems) {
          if (otherSub.id === comp.subsystem) continue;
          const otherSubRelativeId = otherSub.id.split('::').pop() || otherSub.id;
          const otherPattern1 = `/${otherSubRelativeId.toLowerCase()}/`;
          const otherPattern2 = `/${otherSubRelativeId.replace(/-/g, '_').toLowerCase()}/`;
          const otherSegmentMatch = otherSubRelativeId
            .split(/[-_]/)
            .some((seg: string) => seg.length >= 3 && normalizedPath.includes(`/${seg.toLowerCase()}/`));

          if (normalizedPath.includes(otherPattern1) || 
              normalizedPath.includes(otherPattern2) || 
              otherSegmentMatch) {
            belongsToOtherSubsystem = true;
            break;
          }
        }
        if (belongsToOtherSubsystem) {
          continue; // Skip this file because it belongs to another subsystem
        }

        // Exact match of clean name
        const isCleanNameMatch = base === cleanName.toLowerCase() || base === cleanName.replace(/-/g, '_').toLowerCase();
        if (isCleanNameMatch) {
          score += 5;
        }

        // Exact match of component ID
        const isIdMatch = base === compRelativeId.toLowerCase() || base === compRelativeId.replace(/-/g, '_').toLowerCase();
        if (isIdMatch) {
          score += 3;
        }

        // A specific name match means it matches the clean name and that clean name is not just the generic component type
        const isSpecificNameMatch = isCleanNameMatch && cleanName.toLowerCase() !== comp.componentType.toLowerCase();

        // Reject matches that don't have any specific relation to the component or subsystem
        if (!hasSubsystemMatch && !isSpecificNameMatch && !isIdMatch) {
          continue;
        }

        // Under src or legacy-src folder
        if (normalizedPath.startsWith('src/') || normalizedPath.includes('/src/') ||
            normalizedPath.startsWith('legacy-src/') || normalizedPath.includes('/legacy-src/')) {
          score += 2;
        }

        // Match component type suffix
        if (base === comp.componentType.toLowerCase()) {
          score += 1;
        }

        if (score > bestScore) {
          bestScore = score;
          bestFile = f;
        }
      }
    }

    return bestFile;
  } catch {
    return null;
  }
}

/**
 * Compact one-line summary for agent descriptions. Descriptions are loaded
 * into EVERY session's agent list by the host tool — at scale (a hundred-plus
 * agents) an uncapped multi-sentence description per agent is a permanent
 * token tax. First sentence, hard-capped, single line.
 */
function summarize(text: string, max = 140): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  const period = clean.indexOf('. ');
  const firstSentence = period > 0 ? clean.slice(0, period + 1) : clean;
  if (firstSentence.length <= max) return firstSentence;
  return `${firstSentence.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The "Component variants" guidance block for an owner/implementer agent.
 * Composition lives in core/variants.ts so the generated-agent renderer and the
 * MCP `sdd_get_spec` path share ONE implementation — a hosted agent and a local
 * session are told the same thing about a variant, by construction.
 */
function buildVariantGuidance(
  comps: ComponentSpec[],
  allComponents: ComponentSpec[],
  variantsById: Map<string, VariantDef>,
): string {
  return composeVariantGuidance(comps, allComponents, variantsById);
}

// ---------------------------------------------------------------------------
// Topology Resolver: Translates SDD Spec Tree into Agent Topology
// ---------------------------------------------------------------------------
export function resolveAgentTopology(): AgentRecord[] {
  projectFilesCache.clear();

  const system = loadSystemSpec();
  if (!system) return [];

  // LAYERED topology: generate agents ONLY for THIS project's own layer. The
  // loader federates every chained subproject recursively (their specs carry a
  // `::` namespace prefix); those belong to the SUBPROJECT's layer, generated in
  // the subproject's own .wai. Here a chained subproject collapses to a single
  // delegating owner. A LOCAL spec id carries no `::` prefix. This keeps each
  // .claude/agents/ (and the context every session loads) proportional to one
  // layer, not the whole deep tree.
  const isLocal = (id: string): boolean => !id.includes('::');
  const subsystems = loadSubsystemSpecs().filter((s) => isLocal(s.id));
  const components = loadComponentSpecs().filter((c) => isLocal(c.id) && isLocal(c.subsystem));
  const interfaces = loadInterfaceSpecs();
  const implementations = loadImplementationSpecs();
  // Component-variant registry (dynamic layer on top of packs) — resolved here so
  // each owner/implementer carries its variant-tagged components' guidance + siblings.
  const variantsById = new Map(loadProjectVariants().map((v) => [v.id, v]));

  const config = loadProjectConfig();
  const activeTargets = config.targets
    .filter((t) => !('enabled' in t) || t.enabled)
    .map((t) => typeof t === 'string' ? t : t.type) as AgentRecord['targets'];

  const agents: AgentRecord[] = [];

  // 1. Global System Architect
  agents.push({
    id: 'system-architect',
    name: `${system.name} Architect`,
    description: `Global architect for ${system.name} — owns the spec tree and topology. ${summarize(system.vision)}`,
    template: 'architect',
    creationReason: 'Automatically inferred from L0 system spec',
    ownedPaths: ['.wai/specs/**'],
    readPaths: ['**'],
    writePaths: ['.wai/specs/**'],
    tags: ['architect', 'global', 'sdd'],
    dependencies: subsystems.map((s) => `${s.id}-owner`),
    status: 'active',
    targets: activeTargets,
    createdAt: system.createdAt,
    updatedAt: system.updatedAt,
  });

  // 2. Subsystem Owners (Domain Owners)
  for (const sub of subsystems) {
    // A chained subproject collapses to ONE delegating owner: it owns only the
    // parent-side mount spec and points work DOWN into the subproject, whose own
    // detailed agents are generated in that subproject's .wai (one layer deeper).
    // It never enumerates the child's internals here — that is the whole point of
    // stacking agents per layer instead of flattening the tree at the top.
    if (sub.projectPath) {
      const mountSpecPath = path.relative(getProjectRoot(), getSubsystemPath(sub.id)).replace(/\\/g, '/');
      agents.push({
        id: `${sub.id}-owner`,
        name: `${sub.name} (chained subproject)`,
        description: `Delegates into the "${sub.id}" chained subproject at ${sub.projectPath}. Its own agents live in that subproject's .wai — run \`wairon generate\` there (or spawn from ${sub.projectPath}/.claude/agents). Do not implement its internals from this layer.`,
        template: 'domain-owner',
        creationReason: `Automatically inferred from a chained subproject subsystem: ${sub.id}`,
        domainRoot: sub.id,
        ownedPaths: [mountSpecPath],
        readPaths: ['**'],
        writePaths: [mountSpecPath],
        tags: ['owner', 'subproject', 'delegate', 'sdd'],
        dependencies: [],
        status: 'active',
        targets: activeTargets,
        createdAt: sub.createdAt,
        updatedAt: sub.updatedAt,
      });
      continue;
    }

    const subComponents = components.filter((c) => c.subsystem === sub.id);

    const ownedPaths: string[] = [];
    // Subsystem Owners own subsystem specification and component specifications under their domain
    ownedPaths.push(path.relative(getProjectRoot(), getSubsystemPath(sub.id)).replace(/\\/g, '/'));
    for (const c of subComponents) {
      ownedPaths.push(path.relative(getProjectRoot(), getComponentPath(c.id, sub.id)).replace(/\\/g, '/'));
    }

    if (!config.rules.generateComponentImplementers) {
      // Aggregate all component implementation source paths under the subsystem owner.
      // Several spec-level roles may be realized in one shared module, so dedupe —
      // an owner claiming the same path twice would trip OVERLAPPING_OWNERSHIP.
      for (const comp of subComponents) {
        // Find contract interfaces for this component
        const compInterfaces = interfaces.filter((i) => i.component === comp.id);
        const compInterfaceIds = compInterfaces.map((i) => i.id);

        // Find implementations of those contracts
        const compImpls = implementations.filter((impl) => compInterfaceIds.includes(impl.contract));

        let hasExplicitSource = false;
        for (const impl of compImpls) {
          if (impl.sourcePath) {
            hasExplicitSource = true;
            if (!ownedPaths.includes(impl.sourcePath)) ownedPaths.push(impl.sourcePath);
          }
        }

        // Inference is a FALLBACK for components whose implementations declare
        // no sourcePath. Running it on implemented components lets a filename
        // that matches the component TYPE claim a foreign file — e.g. a
        // Repository facade realized in specs.ts inferring rules/repository.ts
        // owned by another subsystem — tripping OVERLAPPING_OWNERSHIP.
        if (!hasExplicitSource) {
          const inferred = inferSourcePathForComponent(comp, subsystems);
          if (inferred && !ownedPaths.includes(inferred)) {
            ownedPaths.push(inferred);
          }
        }
      }
    }

    let dependencies: string[] = [];
    if (config.rules.generateComponentImplementers) {
      dependencies = subComponents.map((c) => `${c.id}-implementer`);
    } else {
      // Subsystem depends on other subsystem owners that its components depend on
      const depSubsystems = new Set<string>();
      for (const c of subComponents) {
        for (const depId of c.dependsOn) {
          const depComp = components.find((other) => other.id === depId);
          if (depComp && depComp.subsystem !== sub.id) {
            depSubsystems.add(`${depComp.subsystem}-owner`);
          }
        }
      }
      dependencies = Array.from(depSubsystems);
    }

    agents.push({
      id: `${sub.id}-owner`,
      name: `${sub.name} Owner`,
      description: `Owns the ${sub.id} subsystem. ${summarize(sub.description)}`,
      template: 'domain-owner',
      creationReason: `Automatically inferred from L1 subsystem spec: ${sub.id}`,
      domainRoot: sub.id,
      ownedPaths,
      readPaths: ['**'],
      writePaths: ownedPaths,
      tags: ['owner', 'domain', 'sdd'],
      dependencies,
      variantGuidance: buildVariantGuidance(subComponents, components, variantsById),
      status: 'active',
      targets: activeTargets,
      createdAt: sub.createdAt,
      updatedAt: sub.updatedAt,
    });
  }

  // 3. Component Implementers
  if (config.rules.generateComponentImplementers) {
    for (const comp of components) {
      // Find contract interfaces for this component
      const compInterfaces = interfaces.filter((i) => i.component === comp.id);
      const compInterfaceIds = compInterfaces.map((i) => i.id);

      // Find implementations of those contracts
      const compImpls = implementations.filter((impl) => compInterfaceIds.includes(impl.contract));

      const ownedPaths: string[] = [];
      for (const impl of compImpls) {
        if (impl.sourcePath) ownedPaths.push(impl.sourcePath);
      }

      if (ownedPaths.length === 0) {
        const inferred = inferSourcePathForComponent(comp, subsystems);
        if (inferred) {
          ownedPaths.push(inferred);
        }
      }

      const dependencies = comp.dependsOn.map((depId) => `${depId}-implementer`);

      // An implementer needs to read specs, interfaces, and direct dependency component files
      const readPaths = [
        path.relative(getProjectRoot(), AI_PATHS.specsSystem()).replace(/\\/g, '/'),
        path.relative(getProjectRoot(), getComponentPath(comp.id, comp.subsystem)).replace(/\\/g, '/'),
        ...compInterfaces.map((i) => path.relative(getProjectRoot(), getInterfacePath(i.id, comp.id)).replace(/\\/g, '/')),
        ...compImpls.map((impl) => path.relative(getProjectRoot(), getImplementationPath(impl.id, impl.contract)).replace(/\\/g, '/')),
      ];

      agents.push({
        id: `${comp.id}-implementer`,
        name: `${comp.name} Implementer`,
        description: `Developer agent implementing ${comp.name} (${comp.componentType})`,
        template: 'implementer',
        creationReason: `Automatically inferred from L2 component spec: ${comp.id}`,
        domainRoot: comp.subsystem,
        ownedPaths,
        readPaths,
        writePaths: ownedPaths,
        tags: ['implementer', 'component', 'sdd', comp.componentType.toLowerCase()],
        dependencies,
        variantGuidance: buildVariantGuidance([comp], components, variantsById),
        status: 'active',
        targets: activeTargets,
        createdAt: comp.createdAt,
        updatedAt: comp.updatedAt,
      });
    }
  }


  // 4. Free-standing domain owners (declared in .wai/topology.yaml)
  const now = new Date().toISOString();
  for (const dom of loadTopologyConfig().domains) {
    agents.push({
      id: `${dom.id}-owner`,
      name: `${dom.name ?? dom.id} Owner`,
      description: dom.description ? summarize(dom.description) : `Owner agent for the free-standing "${dom.id}" domain.`,
      template: 'domain-owner',
      creationReason: 'Inferred from a free-standing domain in .wai/topology.yaml',
      domainRoot: dom.id,
      ownedPaths: dom.ownedPaths,
      readPaths: ['**'],
      writePaths: dom.ownedPaths,
      tags: ['owner', 'domain'],
      dependencies: [],
      status: 'active',
      targets: activeTargets,
      createdAt: now,
      updatedAt: now,
    });
  }

  return agents;
}

/** Thrown when composeAgentBrief is asked for an id the current topology does not resolve. */
export class UnknownAgentError extends WaironError {
  constructor(agentId: string, knownIds: string[]) {
    super(`Unknown agent id: "${agentId}". Known agent ids: ${knownIds.join(', ')}`);
    this.name = 'UnknownAgentError';
  }
}

// ---------------------------------------------------------------------------
// Live delegation brief: composed on demand from the CURRENT spec tree, the
// dynamic replacement for generate-time agent files.
// ---------------------------------------------------------------------------
export function composeAgentBrief(agentId: string): AgentBrief {
  // Always resolve against the live topology — a re-lock changes the next call.
  const records = resolveAgentTopology();
  const record = records.find((r) => r.id === agentId);
  if (!record) {
    throw new UnknownAgentError(agentId, records.map((r) => r.id));
  }

  const template = loadTemplate(record.template, loadProjectConfig().globalTemplatesDir);
  // The same variable map the generate-time exporter feeds templates (see
  // exporters/generate.ts buildVars) — duplicated here because core must not
  // import exporters.
  let instructions = renderTemplateInstructions(template, {
    agentId: record.id,
    agentName: record.name,
    agentDescription: record.description,
    ownedPaths: record.ownedPaths.join('\n'),
    tags: record.tags.join(', '),
    renderContext: 'root',
    contextNote: '',
    domainPath: '.',
    domainName: '',
    variantGuidance: record.variantGuidance ?? '',
  });

  // Fold the optional user-owned project guidance (.wai/agents/<agentId>.md,
  // read LIVE — an edit applies on the next call) under an attributed section,
  // so the user's delta stays legible AS a delta over the inferred brief.
  const guidance = loadAgentOverride(agentId);
  if (guidance !== null) {
    instructions = `${instructions.trimEnd()}\n\n## Project guidance\n\n${guidance.trim()}\n`;
  }

  // The resource axis, resolved from the same live topology as the rest of the
  // brief. Absent at tier `off` (the default), so a consumer that never opted
  // in sees exactly the brief it saw before budgets existed.
  const config = loadProjectConfig();
  const profile = deriveExecutionProfile(record);
  const budget = resolveBudget(profile, config.execution, record.id);

  return {
    agentId: record.id,
    name: record.name,
    template: record.template,
    domainRoot: record.domainRoot,
    ownedPaths: record.ownedPaths,
    readPaths: record.readPaths,
    instructions,
    variantGuidance: record.variantGuidance || undefined,
    profile: budget ? profile : undefined,
    budget,
  };
}
