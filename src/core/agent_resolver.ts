import * as path from 'path';
import * as fs from 'fs';
import { AgentBrief, AgentRecord } from '../models/agent.js';
// The topology configuration, through the Repository facade that owns it —
// never ../config/loader.js, which is one of its members. The narrative says
// topology_repository.loadConfig, and a namespace binding is what lets the call
// SITE say `loadConfig` too: an `as` rename compiles to the same thing, but the
// name a reader (and the conformance analysis) sees at the call is the local
// one, so the renamed form hides which contract method was reached.
import * as topology from './topology.js';
import { AI_PATHS, assertProjectInitialized } from '../config/paths.js';
import { Registry, createEmptyRegistry } from '../models/registry.js';
import { projectConfigRepository } from '../config/project-config.js';
import { getProjectRoot, pathExists, runWithProjectRoot } from '../utils/fs.js';
import { ProjectNotInitializedError, WaironError } from '../utils/errors.js';
import { loadTemplate, loadAgentOverride, renderTemplateInstructions } from './templates.js';
import { deriveExecutionProfile } from './execution_profile.js';
import { resolveBudget } from './budget_policy.js';
import {
  loadSystemSpec,
  loadSubsystemSpecs,
  loadComponentSpecs,
  loadInterfaceSpecs,
  loadImplementationSpecs,
  loadTypeSpecs,
  getSubsystemPath,
  getComponentPath,
  getInterfacePath,
  getImplementationPath,
  resolveSubprojectForNamespace,
  // The members this layer declares (stage 3: a member is not a subsystem), each
  // collapsing to one delegating owner.
  graph,
} from './specs.js';
import { ComponentSpec, implementationSourceFiles, typeSourceFiles, type ImplementationSpec } from '../models/specs.js';
import { languageOfSourcePath } from '../models/code-model.js';
import { typeMappingFor } from '../models/type-dialects.js';
import { readYamlFile } from '../utils/yaml.js';
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
  return resolveLayer(true);
}

/**
 * Step 10 of resolveAgentTopology: the ids of the agents a member's OWN layer
 * resolves, bound to the member's root and qualified `<alias>::<agentId>`. Ids
 * only, and one level: the member's own members appear as its delegating
 * owners and are never expanded further. A member that cannot resolve a
 * topology of its own (no configuration yet) delegates to nothing listed.
 */
function memberAgentIds(alias: string, memberDir: string): string[] {
  try {
    return runWithProjectRoot(memberDir, () => resolveLayer(false).map((r) => `${alias}::${r.id}`));
  } catch {
    return [];
  }
}

/** Whether `target` is `dir` or lies under it. */
function isWithinDir(dir: string, target: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * One layer's topology; `delegate` lists each member's own agents by reference.
 * `implementers` derives every component's implementer record even when
 * rules.generateComponentImplementers is off — what a per-component brief
 * composes from, so it never needs agent files or the setting.
 */
function resolveLayer(delegate: boolean, implementers = false): AgentRecord[] {
  projectFilesCache.clear();

  const system = loadSystemSpec();
  if (!system) return [];

  // LAYERED topology: generate agents ONLY for THIS project's own layer. The
  // loader reads every member project too (their specs carry the member's
  // project key as a `::` prefix); those belong to the MEMBER's layer, generated
  // in the member's own .wai. Here a member collapses to a single delegating
  // owner. A LOCAL spec id carries no `::` prefix. This keeps each
  // .claude/agents/ (and the context every session loads) proportional to one
  // layer, not the whole deep tree.
  const isLocal = (id: string): boolean => !id.includes('::');
  // Each member the bound root declares — `members` or a legacy L1 mount — is
  // one delegating owner here, shaped as the mount subsystem it used to be.
  const members = graph().nodes
    .filter((n) => n.parent === '' && n.mountAlias !== undefined)
    .map((n) => ({
      id: n.mountAlias!,
      name: n.mountAlias!,
      projectPath: path.relative(getProjectRoot(), n.directory).replace(/\\/g, '/'),
      form: n.mountForm,
      createdAt: n.legacyMount?.createdAt ?? system.createdAt,
      updatedAt: n.legacyMount?.updatedAt ?? system.updatedAt,
    }));
  const subsystems = [
    ...loadSubsystemSpecs().filter((s) => isLocal(s.id)),
    ...members,
  ] as (ReturnType<typeof loadSubsystemSpecs>[number] & { form?: 'members' | 'mount' })[];
  // Stage 8: the parts this layer declares — their subsystems are this
  // layer's own (no delegating owner); a git part's files are read-only here.
  const parts = graph().nodes.find((n) => n.namespace === '')?.parts ?? [];
  const readOnlyPartDirs = parts.filter((p) => p.storage === 'git' && p.directory !== undefined).map((p) => p.directory!);
  const partOf = new Map(parts.flatMap((p) => p.subsystems.map((s) => [s, p.storage === 'git'
    ? `Stored in the part "${p.alias}", fetched from git at ${p.commit ?? 'its pinned commit'}: read-only here — change it in its own repository, then \`wairon member update ${p.alias}\`.`
    : `Stored in the part "${p.alias}" (${p.storage === 'path' ? 'a sibling checkout' : 'its own folder'}); it is this project's own subsystem.`] as const)));
  const components = loadComponentSpecs().filter((c) => isLocal(c.id) && isLocal(c.subsystem));
  const interfaces = loadInterfaceSpecs();
  const implementations = loadImplementationSpecs();
  const types = loadTypeSpecs();
  // Which subsystems' specs name each code file — implementations through
  // their component, types directly — so a file shared across subsystems is
  // never fenced to one owner.
  const namedBy = new Map<string, Set<string>>();
  const nameFile = (file: string, subsystem: string | undefined): void => {
    if (!subsystem) return;
    const set = namedBy.get(file) ?? new Set<string>();
    set.add(subsystem);
    namedBy.set(file, set);
  };
  for (const impl of implementations) {
    const contract = interfaces.find((i) => i.id === impl.contract);
    const owner = contract ? components.find((c) => c.id === contract.component)?.subsystem : undefined;
    for (const file of codeLocationsOf(impl)) nameFile(file, owner);
  }
  for (const type of types) for (const file of typeSourceFiles(type)) nameFile(file, type.subsystem);
  // Component-variant registry (dynamic layer on top of packs) — resolved here so
  // each owner/implementer carries its variant-tagged components' guidance + siblings.
  const variantsById = new Map(loadProjectVariants().map((v) => [v.id, v]));

  const config = projectConfigRepository.load();
  if (!config) throw new ProjectNotInitializedError();
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
    // A member project collapses to ONE delegating owner: it owns only the
    // parent-side declaration and points work DOWN into the member, whose own
    // detailed agents are generated in that member's .wai (one layer deeper).
    // It never enumerates the child's internals here — that is the whole point of
    // stacking agents per layer instead of flattening the tree at the top.
    if (sub.projectPath) {
      // The declaration it owns: the legacy mount's spec file, or — declared in
      // project.yaml `members` — the member's own tree it delegates into.
      const mountSpecPath = sub.form === 'members'
        ? `${sub.projectPath}/**`
        : path.relative(getProjectRoot(), getSubsystemPath(sub.id)).replace(/\\/g, '/');
      agents.push({
        id: `${sub.id}-owner`,
        name: `${sub.name} (member project)`,
        description: `Delegates into the member project "${sub.id}" at ${sub.projectPath}. Its own agents live in that member's .wai — run \`wairon generate\` there (or spawn from ${sub.projectPath}/.claude/agents). Do not implement its internals from this layer.`,
        template: 'domain-owner',
        creationReason: `Automatically inferred from the member "${sub.id}" this project declares`,
        domainRoot: sub.id,
        ownedPaths: [mountSpecPath],
        readPaths: ['**'],
        writePaths: [mountSpecPath],
        tags: ['owner', 'subproject', 'delegate', 'sdd'],
        dependencies: [],
        // The member's own agents BY REFERENCE, never copied into this layer.
        ...(delegate ? { delegatesTo: memberAgentIds(sub.id, path.resolve(getProjectRoot(), sub.projectPath)) } : {}),
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
          // Every code location the implementation names, existing or PLANNED:
          // its own sourcePath, each method's, and its simPath harness.
          const files = codeLocationsOf(impl);
          if (files.length > 0) hasExplicitSource = true;
          for (const file of files) {
            if (!ownedPaths.includes(file)) ownedPaths.push(file);
          }
        }

        // Inference is a FALLBACK for components whose implementations name no
        // source file at all. Running it on implemented components lets a filename
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

    // The types this subsystem owns are its code too: each one's own
    // sourcePath and its methods', existing or planned. A file the specs of
    // ANOTHER subsystem name as well (a shared models module) is no single
    // owner's to fence: claiming it would give one path two owners.
    if (!config.rules.generateComponentImplementers) {
      for (const type of types.filter((t) => t.subsystem === sub.id)) {
        for (const file of typeSourceFiles(type)) {
          if ((namedBy.get(file)?.size ?? 0) > 1) continue;
          if (!ownedPaths.includes(file)) ownedPaths.push(file);
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

    // Stage 8: a part's subsystems are this project's own, so the same owner
    // covers them — its spec files where the part stores them. A part fetched
    // from git is read-only here (its files are the fetch cache's): it is read,
    // never owned, and changed in its own repository.
    const writable = ownedPaths.filter((p) => !readOnlyPartDirs.some((dir) => isWithinDir(dir, path.resolve(getProjectRoot(), p))));
    const partNote = partOf.get(sub.id);
    agents.push({
      id: `${sub.id}-owner`,
      name: `${sub.name} Owner`,
      description: `Owns the ${sub.id} subsystem. ${summarize(sub.description)}${partNote ? ` ${partNote}` : ''}`,
      template: 'domain-owner',
      creationReason: `Automatically inferred from L1 subsystem spec: ${sub.id}`,
      domainRoot: sub.id,
      ownedPaths: writable,
      readPaths: ['**'],
      writePaths: writable,
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
  if (config.rules.generateComponentImplementers || implementers) {
    for (const comp of components) {
      // Find contract interfaces for this component
      const compInterfaces = interfaces.filter((i) => i.component === comp.id);
      const compInterfaceIds = compInterfaces.map((i) => i.id);

      // Find implementations of those contracts
      const compImpls = implementations.filter((impl) => compInterfaceIds.includes(impl.contract));

      const ownedPaths: string[] = [];
      for (const impl of compImpls) {
        // Existing or PLANNED: implementation and method files and the simPath harness.
        for (const file of codeLocationsOf(impl)) {
          if (!ownedPaths.includes(file)) ownedPaths.push(file);
        }
      }
      // The types this component realizes (its componentClass) are its code too.
      for (const type of types.filter((t) => t.componentClass === comp.id && t.subsystem === comp.subsystem)) {
        for (const file of typeSourceFiles(type)) {
          if (!ownedPaths.includes(file)) ownedPaths.push(file);
        }
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
  for (const dom of topology.loadConfig().domains) {
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
    super(`Unknown agent id: "${agentId}". Known agent ids: ${knownIds.join(', ')} — or any component id of this project, which composes that component's implementer brief.`);
    this.name = 'UnknownAgentError';
  }
}

// ---------------------------------------------------------------------------
// Live delegation brief: composed on demand from the CURRENT spec tree, the
// dynamic replacement for generate-time agent files.
// ---------------------------------------------------------------------------
export function composeAgentBrief(agentId: string): AgentBrief {
  // Steps 1-4: an id qualified by a direct member's alias composes AT THE
  // MEMBER'S ROOT (brief-through-mount) — exactly the brief the member's own
  // session gets, so it never grows with the family — and comes back with its
  // fence re-expressed under the member's directory. One hop per member.
  const hop = memberHop(agentId);
  if (hop) {
    const brief = runWithProjectRoot(hop.directory, () => composeAgentBrief(hop.rest));
    return throughMount(brief, hop.alias, hop.relative);
  }

  // Always resolve against the live topology — a re-lock changes the next call.
  const records = resolveAgentTopology();
  // Step 5: the record, or — for a component id (`<component>` or
  // `<component>-implementer`) — that component's implementer record derived
  // on demand, so a per-component brief never needs agent files or a setting.
  const record = records.find((r) => r.id === agentId) ?? componentImplementer(agentId);
  if (!record) {
    throw new UnknownAgentError(agentId, records.map((r) => r.id));
  }

  // The project configuration, read once: the global templates directory the template
  // lookup consults, and the execution settings the budget is resolved from.
  const config = projectConfigRepository.load();
  if (!config) throw new ProjectNotInitializedError();
  const template = loadTemplate(record.template, config.globalTemplatesDir);
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

  // Step 13 (part): the code write fence — where this agent may write CODE —
  // ahead of the user's own guidance, which stays the last word.
  const ownFence = codeFenceOf(record);
  // A subsystem owner also owns what the whole project shares and no
  // component claims — the manifest, the compiler settings, the crate or
  // package root, the files of system-level types — so setup work has an owner.
  const shared = ownFence && isSubsystemOwner(record) ? sharedProjectFiles(ownFence) : [];
  const codeFence = ownFence ? [...ownFence, ...shared] : ownFence;
  if (codeFence) {
    // A planned file (named, not on disk yet) is marked, so the implementer
    // writes it rather than looks for it.
    const shown = (p: string): string => (/[*?]/.test(p) || fs.existsSync(path.resolve(getProjectRoot(), p))
      ? `- \`${p}\``
      : `- \`${p}\` (planned — create it)`);
    const own = ownFence ?? [];
    const sharedSection = shared.length > 0
      ? `\nShared with the other subsystem owners (the project's setup and shared code; coordinate edits):\n\n${shared.map(shown).join('\n')}\n`
      : '';
    instructions = `${instructions.trimEnd()}\n\n## Code write fence\n\n${own.length > 0
      ? `Write code only here (and tests beside it, as the project lays tests out):\n\n${own.map(shown).join('\n')}\n`
      : 'No spec names a code location yet, so no code location is declared. The spawning session should declare the planned `sourcePath` on the implementation now — it is code linkage, not part of the approval, so declaring it costs no re-lock — and that file is then this agent\'s fence.\n'}${sharedSection}`;
  }

  // Fold the optional user-owned project guidance (.wai/agents/<agentId>.md,
  // read LIVE — an edit applies on the next call) under an attributed section,
  // so the user's delta stays legible AS a delta over the inferred brief.
  const guidance = loadAgentOverride(agentId);
  if (guidance !== null) {
    instructions = `${instructions.trimEnd()}\n\n## Project guidance\n\n${guidance.trim()}\n`;
  }

  // Step 13: the type mapping — how the neutral contract types are spelled in
  // the language this agent's implementations are written in, so an
  // implementer maps list<T>, T?, async T and an enum by rule, not by guess.
  const language = implementationLanguage(record);
  const typeMapping = (language ? typeMappingFor(language) : null) ?? undefined;
  if (typeMapping) {
    instructions = `${instructions.trimEnd()}\n\n## Types in ${language}\n\nContracts speak wairon's neutral type grammar; write each type in ${language} as:\n\n${typeMapping.map((line) => `- ${line}`).join('\n')}\n`;
  }

  // The externals a consumer codes against: each other project this record's
  // components reach, the names they use, the producer's transport and abi
  // where the pin records them, and the pinned snapshot — the contract the
  // consumer codes against — which joins the read list.
  const externals = externalsUsedBy(record);
  let readPaths = record.readPaths;
  if (externals.length > 0) {
    instructions = `${instructions.trimEnd()}\n\n## Externals used\n\nThese components reach other projects through \`alias::name\`; code against the pinned snapshot, never the producer's source:\n\n${externals.map(describeExternal).join('\n')}\n`;
    readPaths = [...new Set([...record.readPaths, ...externals.map((e) => e.pin)])];
  }

  // The resource axis, resolved from the same live topology as the rest of the
  // brief. Absent at tier `off` (the default), so a consumer that never opted
  // in sees exactly the brief it saw before budgets existed.
  const profile = deriveExecutionProfile(record);
  const budget = resolveBudget(profile, config.execution, record.id);

  return {
    agentId: record.id,
    name: record.name,
    template: record.template,
    domainRoot: record.domainRoot,
    ownedPaths: record.ownedPaths,
    readPaths,
    instructions,
    variantGuidance: record.variantGuidance || undefined,
    ...(typeMapping ? { typeMapping } : {}),
    ...(codeFence ? { codeFence } : {}),
    profile: budget ? profile : undefined,
    budget,
  };
}

/**
 * A component's implementer record, derived on demand for an id naming a
 * component (`<component>` or `<component>-implementer`) of this layer — the
 * record rules.generateComponentImplementers would materialize. Null when the
 * id names no component.
 */
function componentImplementer(agentId: string): AgentRecord | null {
  const componentId = agentId.endsWith('-implementer') ? agentId.slice(0, -'-implementer'.length) : agentId;
  if (componentId === '' || componentId.includes('::')) return null;
  return resolveLayer(true, true).find((r) => r.id === `${componentId}-implementer`) ?? null;
}

/**
 * Every code location an implementation names, existing or planned: its own
 * sourcePath, each method's, then its simPath harness.
 */
function codeLocationsOf(impl: ImplementationSpec): string[] {
  const files = implementationSourceFiles(impl);
  if (impl.simPath && !files.includes(impl.simPath)) files.push(impl.simPath);
  return files;
}

/**
 * The code write fence of a record that implements components: each code
 * location it owns (existing or planned), plus the folder they share below the project root as
 * `<folder>/**` — the subsystem's code folder, so a first file beside the
 * existing ones is inside the fence. Empty when the record implements
 * components but no implementation names a file yet; null for a record that
 * implements nothing (the architect, a delegating member owner, a
 * free-standing domain).
 */
function codeFenceOf(record: AgentRecord): string[] | null {
  const implementsComponents = record.template === 'implementer'
    || (record.template === 'domain-owner' && record.creationReason.startsWith('Automatically inferred from L1'));
  if (!implementsComponents) return null;
  const files = record.ownedPaths.filter((p) => !p.startsWith('.wai/') && !p.includes('/.wai/') && !/[*?]/.test(p));
  if (files.length === 0) return [];
  const dirs = files.map((f) => path.posix.dirname(f.replace(/\\/g, '/')));
  let shared = dirs[0].split('/');
  for (const dir of dirs.slice(1)) {
    const parts = dir.split('/');
    let i = 0;
    while (i < shared.length && i < parts.length && shared[i] === parts[i]) i++;
    shared = shared.slice(0, i);
  }
  const folder = shared.join('/');
  const fence = [...files];
  if (folder !== '' && folder !== '.') fence.push(`${folder}/**`);
  return fence;
}

/**
 * The language a record's implementations are written in: a technology they
 * bind that names a language a dialect is shipped for, else the language their
 * source files are analyzed as. Undefined when the record implements nothing
 * (the architect, a delegating member owner) or no file names a language.
 */
function implementationLanguage(record: AgentRecord): string | undefined {
  const owned = new Set(record.ownedPaths);
  const implementations = loadImplementationSpecs()
    .filter((impl) => implementationSourceFiles(impl).some((file) => owned.has(file)));
  for (const impl of implementations) {
    for (const technology of impl.technologies ?? []) {
      const name = typeof technology === 'string' ? technology : technology.name;
      if (typeMappingFor(name)) return name.toLowerCase();
    }
  }
  for (const impl of implementations) {
    for (const file of implementationSourceFiles(impl)) {
      const language = languageOfSourcePath(file);
      if (language) return language;
    }
  }
  // Else the language any fenced file's extension names — a planned file
  // selects the mapping as well as an existing one.
  for (const file of record.ownedPaths.filter((p) => !p.startsWith('.wai/') && !p.includes('/.wai/'))) {
    const language = languageOfSourcePath(file);
    if (language) return language;
  }
  // Else the language the design declares: a subsystem's own targetLanguage
  // for its owner, then the L0's — a design with no code yet still says it.
  if (!implementsComponents(record)) return undefined;
  const subsystem = loadSubsystemSpecs().find((s) => record.ownedPaths.some((p) => p.includes(`/${s.id}/`) || p.endsWith(`/${s.id}.yaml`)));
  const declared = subsystem?.targetLanguage ?? loadSystemSpec()?.targetLanguage;
  return declared ? declared.toLowerCase() : undefined;
}

/** Whether a record implements components (an implementer, or a subsystem owner inferred from an L1). */
function implementsComponents(record: AgentRecord): boolean {
  return record.template === 'implementer' || isSubsystemOwner(record);
}

/** A qualified id's first hop: the direct member its alias names, and the rest of the id. */
function memberHop(agentId: string): { alias: string; rest: string; directory: string; relative: string } | null {
  const at = agentId.indexOf('::');
  if (at < 0) return null;
  const alias = agentId.slice(0, at);
  const member = graph().nodes.find((n) => n.parent === '' && n.mountAlias === alias);
  if (!member) return null; // not a direct member: an unknown agent id, reported as such
  const relative = path.relative(getProjectRoot(), member.directory).split(path.sep).join('/');
  return { alias, rest: agentId.slice(at + 2), directory: member.directory, relative };
}

/** A member's brief as seen from the asking root: paths under the member's directory, id qualified. */
function throughMount(brief: AgentBrief, alias: string, relative: string): AgentBrief {
  const under = (p: string): string => path.posix.join(relative, p);
  return {
    ...brief,
    agentId: `${alias}::${brief.agentId}`,
    ownedPaths: brief.ownedPaths.map(under),
    ...(brief.codeFence ? { codeFence: brief.codeFence.map(under) } : {}),
    ...(brief.readPaths ? { readPaths: brief.readPaths.map(under) } : {}),
    root: brief.root ? under(brief.root) : relative,
  };
}

/**
 * The derived agent topology in the Registry shape callers expect.
 *
 * There is no registry FILE: the agents come from the spec tree, and this is
 * resolveAgentTopology() wrapped for callers that still speak Registry. It
 * lived in config/loader.ts until the topology store was modelled, which is
 * why that file had to lazily require THIS one - a store calling an
 * orchestrator, through a require that existed only to break the cycle it
 * created. Derivation belongs with the deriver.
 */
export function loadRegistry(): Registry {
  assertProjectInitialized();
  if (!pathExists(AI_PATHS.specsSystem())) return createEmptyRegistry();
  return {
    schemaVersion: '1.0.0',
    agents: resolveAgentTopology(),
    updatedAt: new Date().toISOString(),
  };
}

/** Whether a record is a subsystem's owner, inferred from an L1 — the one that implements the subsystem's components. */
function isSubsystemOwner(record: AgentRecord): boolean {
  return record.template === 'domain-owner' && record.creationReason.startsWith('Automatically inferred from L1');
}

/** The project setup files a subsystem owner shares with the others when they exist: manifests, lockfiles, compiler settings. */
const SHARED_SETUP_FILES = [
  'package.json', 'package-lock.json', 'tsconfig.json', 'Cargo.toml', 'Cargo.lock',
  'pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'go.mod',
];

/** The crate or package roots a project's components are reached through, when they exist. */
const SHARED_ROOT_FILES = ['src/lib.rs', 'src/main.rs', 'src/index.ts', 'src/__init__.py'];

/**
 * The files the whole project shares and no component claims: the setup files
 * and the crate or package root that exist, and the files of system-level
 * types (planned or written) — each one no implementation names and the
 * owner's own fence does not already hold.
 */
function sharedProjectFiles(fence: string[]): string[] {
  const root = getProjectRoot();
  const claimed = new Set<string>(fence);
  for (const impl of loadImplementationSpecs()) for (const file of implementationSourceFiles(impl)) claimed.add(file);
  const out: string[] = [];
  const add = (file: string): void => {
    if (!claimed.has(file) && !out.includes(file)) out.push(file);
  };
  for (const file of [...SHARED_SETUP_FILES, ...SHARED_ROOT_FILES]) {
    if (fs.existsSync(path.join(root, file))) add(file);
  }
  for (const type of loadTypeSpecs()) {
    if (type.subsystem) continue;
    for (const file of typeSourceFiles(type)) add(file);
  }
  return out;
}

/** One other project a record's components reach: its alias, the names used, the pin and what it records of each. */
interface ExternalUse {
  alias: string;
  names: string[];
  /** The pinned snapshot, project-relative. */
  pin: string;
  /** Whether the pin is on disk. */
  pinned: boolean;
  /** The producer Portal's transport and abi per used name, where the pin records them. */
  bindings: Map<string, { transport?: string; abi?: string }>;
}

/** The components a record implements: those whose implementations name a file it owns, or the one its id names. */
function implementedComponents(record: AgentRecord): ComponentSpec[] {
  const owned = new Set(record.ownedPaths);
  const components = loadComponentSpecs();
  const contractOwner = new Map(loadInterfaceSpecs().map((i) => [i.id, i.component]));
  const ids = new Set<string>();
  for (const impl of loadImplementationSpecs()) {
    if (!implementationSourceFiles(impl).some((file) => owned.has(file))) continue;
    const component = contractOwner.get(impl.contract);
    if (component) ids.add(component);
  }
  if (record.id.endsWith('-implementer')) ids.add(record.id.slice(0, -'-implementer'.length));
  return components.filter((c) => ids.has(c.id));
}

/**
 * Every other project the record's components reach through `alias::name` —
 * a dependsOn or owns, a narrative call or declared call, a contract's
 * `implements` — with what the alias's pinned snapshot records of each name.
 */
function externalsUsedBy(record: AgentRecord): ExternalUse[] {
  const components = implementedComponents(record);
  if (components.length === 0) return [];
  const ids = new Set(components.map((c) => c.id));
  const refs: string[] = [];
  for (const c of components) refs.push(...c.dependsOn, ...(c.owns ?? []));
  const contracts = loadInterfaceSpecs().filter((i) => ids.has(i.component));
  for (const contract of contracts) if (contract.implements) refs.push(contract.implements);
  const contractIds = new Set(contracts.map((i) => i.id));
  for (const impl of loadImplementationSpecs()) {
    if (!contractIds.has(impl.contract)) continue;
    for (const method of impl.methods) {
      for (const step of method.narrative) if (step.targetComponent) refs.push(step.targetComponent);
      for (const call of method.calls ?? []) refs.push(call.slice(0, call.lastIndexOf('.')));
    }
  }
  const byAlias = new Map<string, Set<string>>();
  for (const ref of refs) {
    const cut = ref.indexOf('::');
    if (cut <= 0) continue;
    const alias = ref.slice(0, cut);
    const names = byAlias.get(alias) ?? new Set<string>();
    names.add(ref.slice(cut + 2));
    byAlias.set(alias, names);
  }
  const root = getProjectRoot();
  const out: ExternalUse[] = [];
  for (const [alias, names] of [...byAlias].sort(([a], [b]) => a.localeCompare(b))) {
    const pin = `.wai/externals/${alias}.yaml`;
    const bindings = new Map<string, { transport?: string; abi?: string }>();
    let pinned = false;
    try {
      const doc = readYamlFile(path.join(root, pin)) as { interfaces?: Array<{ id?: string; transport?: string; abi?: string }> } | null;
      pinned = !!doc;
      for (const entry of doc?.interfaces ?? []) {
        if (entry.id && names.has(entry.id)) bindings.set(entry.id, { transport: entry.transport, abi: entry.abi });
      }
    } catch { /* no pin on disk: named as unpinned */ }
    out.push({ alias, names: [...names].sort(), pin, pinned, bindings });
  }
  return out;
}

/** One external as the brief's section lists it. */
function describeExternal(use: ExternalUse): string {
  const names = use.names.map((name) => {
    const binding = use.bindings.get(name);
    const how = [binding?.transport ? `transport ${binding.transport}` : '', binding?.abi ? `abi ${binding.abi}` : ''].filter(Boolean).join(', ');
    return `\`${use.alias}::${name}\`${how ? ` (${how})` : ''}`;
  });
  return `- **${use.alias}** — uses ${names.join(', ')}; pinned snapshot \`${use.pin}\`${use.pinned ? '' : ' (not pinned yet — run `wairon externals pin` before coding against it)'}`;
}
