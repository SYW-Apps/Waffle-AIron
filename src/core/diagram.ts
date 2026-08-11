import {
  loadSystemSpec,
  loadSubsystemSpecs,
  loadComponentSpecs,
  loadInterfaceSpecs,
  loadImplementationSpecs,
} from './specs.js';
import {
  ComponentSpec,
  SubsystemSpec,
  InterfaceSpec,
  ImplementationSpec,
  PATTERN_TYPES,
} from '../models/index.js';
import { buildCanvasModel, renderCanvasHtml, type CanvasModel } from './canvas.js';
import { generateDrawioXml, generateExcalidrawScene } from './diagram-export.js';
import { validateSddTree, type ValidationIssue } from './validation.js';
import { loadProjectConfig } from '../config/loader.js';
// Pure interface types for the web UI graph payload. Type-only import: erased at
// compile time, so this adds no runtime core→server coupling.
import type { WebGraphModel, WebGraphNode, LandscapeEdge } from '../server/types.js';

// ---------------------------------------------------------------------------
// Diagram Specialist entrypoint (sdd_core diagram_specialist)
//
// Render the current (request-scoped) project's spec tree into a diagram
// artifact STRING — the engine behind `wairon diagram`, reused by the hosting
// server's diagram endpoints. The canvas embeds the validation-issue overlay;
// all formats are self-contained.
// ---------------------------------------------------------------------------

export function renderDiagram(format: string): string {
  switch (format) {
    case 'canvas':     return renderCanvasHtml(buildCanvasModel(diagramIssues()));
    case 'mermaid':    return generateComponentDiagram();
    case 'drawio':     return generateDrawioXml(buildCanvasModel());
    case 'excalidraw': return generateExcalidrawScene(buildCanvasModel());
    default:
      throw new Error(`Unsupported diagram format "${format}" (canvas | mermaid | drawio | excalidraw).`);
  }
}

/**
 * The full CanvasModel for the current (request-scoped) project — the same model
 * `renderDiagram('canvas')` renders to the standalone HTML, but returned as data
 * so the React web app can mount the shared renderer directly (no iframe) and,
 * later, receive it in on-demand scope slices. Pure derivation, no side effects.
 */
export function buildCanvasDataModel(): CanvasModel {
  return buildCanvasModel(diagramIssues());
}

function diagramIssues(): ValidationIssue[] {
  try {
    const config = loadProjectConfig();
    return validateSddTree({ rules: config.rules, projectType: config.projectType }).issues;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Live level-of-detail graph model (project tier)
//
// A PURE projection of the current (request-scoped) project's spec tree into a
// WebGraphModel for the web UI — the live JSON sibling of renderDiagram's static
// HTML/diagram export. It reuses buildCanvasModel's spec traversal, then tags
// each node with its level-of-detail depth (subsystems 1, components 2,
// interfaces/types 3), keeps only nodes at or below the requested level, and
// wires containment/ownership/dependency edges between the surviving nodes
// (dropping any edge whose endpoint was filtered out). No side effects.
// ---------------------------------------------------------------------------

export function buildGraphModel(level: number): WebGraphModel {
  const model = buildCanvasModel();

  // The project/system root is the apex of the graph (level 0): the whole
  // project collapsed to a single node, off which every top-level subsystem
  // hangs. Level 0 yields just this node.
  const rootId = model.system.name;
  const nodes: WebGraphNode[] = [
    { id: rootId, label: model.system.name, kind: 'project', level: 0 },
  ];
  const candidates: LandscapeEdge[] = [];

  // L1 — subsystems. A nested subsystem's parent is its owning subsystem (the
  // id up to the last '::'); a top-level subsystem hangs off the project root.
  // Each carries a containment edge from that parent (project → subsystem, or
  // subsystem → nested subsystem).
  for (const s of model.subsystems) {
    const cut = s.id.lastIndexOf('::');
    const parentId = cut >= 0 ? s.id.slice(0, cut) : rootId;
    nodes.push({
      id: s.id,
      label: s.name,
      kind: 'subsystem',
      level: 1,
      parentId,
      ...(s.status ? { status: s.status } : {}),
    });
    candidates.push({ from: parentId, to: s.id, edgeKind: 'contains' });
  }

  // L2 — components (parent = their subsystem, with a containment edge).
  for (const c of model.components) {
    nodes.push({
      id: c.id,
      label: c.name,
      kind: 'component',
      level: 2,
      parentId: c.subsystem,
      ...(c.status ? { status: c.status } : {}),
    });
    candidates.push({ from: c.subsystem, to: c.id, edgeKind: 'contains' });
  }

  // L3 — interfaces (parent = their component, with an ownership edge) and types.
  for (const c of model.components) {
    for (const intf of c.interfaces) {
      nodes.push({ id: intf.id, label: intf.name, kind: 'interface', level: 3, parentId: c.id });
      candidates.push({ from: c.id, to: intf.id, edgeKind: 'owns' });
    }
  }
  for (const t of model.types) {
    nodes.push({
      id: t.id,
      label: t.name,
      kind: 'type',
      level: 3,
      ...(t.subsystem ? { parentId: t.subsystem } : {}),
    });
  }

  // L4 — implementations (parent = the component whose contract interface they
  // realize). Implementations are not on the CanvasModel, so map each back to its
  // component through contract → interface → component, with an ownership edge.
  const componentByInterface = new Map<string, string>();
  for (const c of model.components) {
    for (const intf of c.interfaces) componentByInterface.set(intf.id, c.id);
  }
  for (const impl of loadImplementationSpecs()) {
    const componentId = componentByInterface.get(impl.contract);
    if (!componentId) continue; // orphan impl — its contract is not on a known component
    nodes.push({
      id: impl.id,
      label: impl.name,
      kind: 'implementation',
      level: 4,
      parentId: componentId,
      ...(impl.status ? { status: impl.status } : {}),
    });
    candidates.push({ from: componentId, to: impl.id, edgeKind: 'owns' });
  }

  // Component → owned member-block ownership edges (e.g. a Repository over its
  // Store/Registry/Index) — the narrative's "ownership edges from a component to
  // its owned member blocks". c.owns is already filtered to real component ids.
  for (const c of model.components) {
    for (const memberId of c.owns) {
      candidates.push({ from: c.id, to: memberId, edgeKind: 'owns' });
    }
  }

  // Component → collaborator dependency edges.
  for (const e of model.edges) {
    candidates.push({ from: e.from, to: e.to, edgeKind: 'depends_on' });
  }

  // Keep only nodes at or below the requested detail level, then drop any edge
  // whose endpoint was filtered out above that level.
  const kept = nodes.filter(n => n.level <= level);
  const keptIds = new Set(kept.map(n => n.id));
  const edges = candidates.filter(e => keptIds.has(e.from) && keptIds.has(e.to));

  return {
    tier: 'project',
    nodes: kept,
    edges,
    level,
    generatedAt: new Date().toISOString(),
    scope: model.system.name,
  };
}

// ---------------------------------------------------------------------------
// Diagram generation (Mermaid)
//
// The spec tree is a typed, hierarchical graph, so diagrams are pure
// derivation — no extra modeling:
//   - component diagrams: subsystems → subgraphs, components → nodes,
//     dependsOn → edges (thick when crossing a subsystem boundary),
//     owns → dashed containment edges, public surface → bold border.
//   - sequence diagrams: L5 narratives → lifelines and arrows, with `call`
//     steps expanded recursively (cycle-guarded, depth-limited).
//
// This is stage 1 of the visualization plan (renders on GitHub / IDEs); the
// interactive compound-graph canvas consumes the same graph extraction later.
// ---------------------------------------------------------------------------

export interface DiagramFile {
  /** Path relative to the diagrams output directory, using forward slashes. */
  relPath: string;
  title: string;
  /** Raw mermaid source (no markdown fence). */
  mermaid: string;
}

interface SpecGraph {
  systemName: string;
  subsystems: SubsystemSpec[];
  components: ComponentSpec[];
  interfaces: InterfaceSpec[];
  implementations: ImplementationSpec[];
  /** Component ids published via some subsystem's publicInterfaces. */
  publicComponents: Set<string>;
}

export function loadSpecGraph(): SpecGraph {
  const system = loadSystemSpec();
  const subsystems = loadSubsystemSpecs();
  const components = loadComponentSpecs();
  const interfaces = loadInterfaceSpecs();
  const implementations = loadImplementationSpecs();
  const publicComponents = new Set<string>();
  for (const sub of subsystems) {
    for (const pi of sub.publicInterfaces) {
      if (pi.component) publicComponents.add(pi.component);
    }
  }
  return {
    systemName: system?.name ?? 'System',
    subsystems,
    components,
    interfaces,
    implementations,
    publicComponents,
  };
}

// ---------------------------------------------------------------------------
// Mermaid encoding helpers
// ---------------------------------------------------------------------------

/** Deterministic mermaid-safe node ids ('::' and '-' are not id-safe). */
class IdPool {
  private byOriginal = new Map<string, string>();
  private taken = new Set<string>();

  idFor(original: string): string {
    const existing = this.byOriginal.get(original);
    if (existing) return existing;
    const base = original.replace(/[^A-Za-z0-9_]/g, '_');
    let candidate = base;
    let n = 2;
    while (this.taken.has(candidate)) {
      candidate = `${base}_${n++}`;
    }
    this.byOriginal.set(original, candidate);
    this.taken.add(candidate);
    return candidate;
  }
}

function escapeLabel(text: string): string {
  return text.replace(/"/g, '#quot;');
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

/** Shape a node by stereotype: entrypoints stadium, state cylinder, patterns subroutine. */
function nodeDecl(id: string, label: string, comp: ComponentSpec): string {
  const l = escapeLabel(label);
  if (comp.componentType === 'Portal' || comp.componentType === 'Observer') return `${id}(["${l}"])`;
  if (comp.componentType === 'Store' || comp.componentType === 'Index') return `${id}[("${l}")]`;
  if (PATTERN_TYPES.has(comp.componentType)) return `${id}[["${l}"]]`;
  return `${id}["${l}"]`;
}

function stereotypeClass(comp: ComponentSpec): string {
  switch (comp.componentType) {
    case 'Portal':
    case 'Observer':
      return 'entry';
    case 'Store':
    case 'Index':
    case 'Registry':
      return 'data';
    case 'Adapter':
      return 'adapter';
    case 'Repository':
    case 'Gateway':
    case 'FeatureComponent':
    case 'RouterComponent':
      return 'pattern';
    default:
      return 'logic';
  }
}

const CLASS_DEFS = [
  'classDef entry fill:#eef4ff,stroke:#4a7dcf,color:#1a2b4a;',
  'classDef logic fill:#f4effd,stroke:#8a63c9,color:#2d1f45;',
  'classDef data fill:#fdf6e3,stroke:#c9963f,color:#4a3517;',
  'classDef adapter fill:#eef8f1,stroke:#4f9e6b,color:#173322;',
  'classDef pattern fill:#f6f8fa,stroke:#6a737d,color:#24292e;',
  'classDef publicSurface stroke-width:3px;',
];

// ---------------------------------------------------------------------------
// Component diagrams
// ---------------------------------------------------------------------------

export interface ComponentDiagramOptions {
  /** Scope to one subsystem (its components plus directly-connected externals). */
  subsystem?: string;
}

export function generateComponentDiagram(options?: ComponentDiagramOptions): string {
  const graph = loadSpecGraph();
  const scope = options?.subsystem;

  let components = graph.components;
  if (scope) {
    const inScope = graph.components.filter(
      c => c.subsystem === scope || c.subsystem.startsWith(`${scope}::`),
    );
    if (inScope.length === 0) {
      throw new Error(`No components found for subsystem "${scope}".`);
    }
    const scopeIds = new Set(inScope.map(c => c.id));
    // Include direct external neighbors (either direction) for boundary context.
    const neighbors = graph.components.filter(c => {
      if (scopeIds.has(c.id)) return false;
      const referencesScope = [...c.dependsOn, ...c.owns].some(d => scopeIds.has(d));
      const referencedByScope = inScope.some(s => s.dependsOn.includes(c.id) || s.owns.includes(c.id));
      return referencesScope || referencedByScope;
    });
    components = [...inScope, ...neighbors];
  }

  const componentIds = new Set(components.map(c => c.id));
  const ids = new IdPool();
  const lines: string[] = [];
  const title = scope
    ? `${graph.systemName} — ${scope} (components)`
    : `${graph.systemName} — component architecture`;
  lines.push('---');
  lines.push(`title: "${escapeLabel(title)}"`);
  lines.push('---');
  lines.push('flowchart LR');

  // Group nodes into subsystem subgraphs
  const bySubsystem = new Map<string, ComponentSpec[]>();
  for (const comp of components) {
    const list = bySubsystem.get(comp.subsystem) ?? [];
    list.push(comp);
    bySubsystem.set(comp.subsystem, list);
  }

  const classAssignments = new Map<string, string[]>(); // class -> node ids
  const assignClass = (cls: string, nodeId: string) => {
    const list = classAssignments.get(cls) ?? [];
    list.push(nodeId);
    classAssignments.set(cls, list);
  };

  for (const [subId, comps] of bySubsystem) {
    const sub = graph.subsystems.find(s => s.id === subId);
    const subLabel = escapeLabel(sub?.name ?? subId);
    lines.push(`  subgraph ${ids.idFor(`sub:${subId}`)}["${subLabel}"]`);
    for (const comp of comps) {
      const nodeId = ids.idFor(comp.id);
      const label = `${comp.name}<br/>«${comp.componentType}»`;
      lines.push(`    ${nodeDecl(nodeId, label, comp)}`);
      assignClass(stereotypeClass(comp), nodeId);
      if (graph.publicComponents.has(comp.id)) assignClass('publicSurface', nodeId);
    }
    lines.push('  end');
  }

  // Edges
  for (const comp of components) {
    const fromId = ids.idFor(comp.id);
    for (const memberId of comp.owns) {
      if (!componentIds.has(memberId)) continue;
      lines.push(`  ${fromId} -. owns .-> ${ids.idFor(memberId)}`);
    }
    for (const depId of comp.dependsOn) {
      if (!componentIds.has(depId)) continue;
      const dep = components.find(c => c.id === depId)!;
      const crossesBoundary = dep.subsystem !== comp.subsystem;
      lines.push(crossesBoundary
        ? `  ${fromId} ==> ${ids.idFor(depId)}`
        : `  ${fromId} --> ${ids.idFor(depId)}`);
    }
  }

  lines.push('');
  lines.push(...CLASS_DEFS.map(d => `  ${d}`));
  for (const [cls, nodeIds] of classAssignments) {
    lines.push(`  class ${nodeIds.join(',')} ${cls}`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Sequence diagrams (from L5 narratives)
// ---------------------------------------------------------------------------

export interface SequenceDiagramOptions {
  /** Max call-expansion depth (default 3). Depth 1 = only the method's own steps. */
  depth?: number;
}

export function generateSequenceDiagram(
  componentId: string,
  methodName: string,
  options?: SequenceDiagramOptions,
): string {
  const graph = loadSpecGraph();
  const maxDepth = options?.depth ?? 3;

  const componentById = new Map(graph.components.map(c => [c.id, c]));
  const resolveComponent = (id: string): ComponentSpec | undefined => {
    if (componentById.has(id)) return componentById.get(id);
    // Accept a bare id that suffix-matches exactly one qualified component.
    const matches = graph.components.filter(c => c.id.endsWith(`::${id}`));
    return matches.length === 1 ? matches[0] : undefined;
  };

  const entry = resolveComponent(componentId);
  if (!entry) {
    throw new Error(`Component "${componentId}" not found in the spec tree.`);
  }

  const findMethodImpl = (compId: string, method: string) => {
    const contractIds = new Set(
      graph.interfaces.filter(i => i.component === compId).map(i => i.id),
    );
    const impl = graph.implementations.find(
      im => contractIds.has(im.contract) && im.methods.some(m => m.name === method),
    );
    return impl?.methods.find(m => m.name === method) ?? null;
  };

  if (!findMethodImpl(entry.id, methodName)) {
    throw new Error(
      `No L4 narrative found for "${methodName}" on component "${entry.id}". ` +
      'Write it with sdd_write_narrative first.',
    );
  }

  const ids = new IdPool();
  const lines: string[] = [];
  lines.push('---');
  lines.push(`title: "${escapeLabel(`${entry.name}.${methodName} — narrative sequence`)}"`);
  lines.push('---');
  lines.push('sequenceDiagram');
  lines.push('  autonumber');

  const declared = new Set<string>();
  const declare = (comp: ComponentSpec): string => {
    const pid = ids.idFor(comp.id);
    if (!declared.has(pid)) {
      declared.add(pid);
      lines.push(`  participant ${pid} as ${escapeLabel(comp.name)} «${comp.componentType}»`);
    }
    return pid;
  };

  const caller = declare(entry);
  // Pre-pass declared participants lazily; mermaid allows late declaration but
  // early declarations keep lifeline order stable (callers before callees).

  const walk = (comp: ComponentSpec, method: string, depth: number, stack: Set<string>): void => {
    const key = `${comp.id}#${method}`;
    if (stack.has(key)) {
      lines.push(`  Note over ${ids.idFor(comp.id)}: ${escapeLabel(`${method}() recurses — cycle cut`)}`);
      return;
    }
    const methodImpl = findMethodImpl(comp.id, method);
    if (!methodImpl) return;

    const nextStack = new Set(stack);
    nextStack.add(key);
    const selfId = ids.idFor(comp.id);

    // Region blocks (loop / try / parallel) have an explicit endStep, so they
    // map cleanly onto Mermaid `loop` / `critical` / `par` fragments; free-form
    // jumps (branch / switch / jump / return / throw) become annotated markers —
    // the canvas flowchart is where arbitrary branching renders faithfully.
    const pendingEnds: number[] = [];
    // Open parallel regions: arms are contiguous, so each later arm entry
    // emits its `and` separator when the walk reaches that step. Block
    // reconstruction beyond endStep-bounded regions is deliberately not
    // attempted (mirrors the loop/critical approach).
    const parallelArms: { end: number; sepByStep: Map<number, string> }[] = [];
    const closeRegionsAfter = (stepNumber: number): void => {
      while (pendingEnds.length && pendingEnds[pendingEnds.length - 1] <= stepNumber) {
        pendingEnds.pop();
        lines.push('  end');
      }
      while (parallelArms.length && parallelArms[parallelArms.length - 1].end <= stepNumber) {
        parallelArms.pop();
      }
    };

    const steps = [...methodImpl.narrative].sort((a, b) => a.stepNumber - b.stepNumber);
    for (const step of steps) {
      // Reaching a later arm's entry inside an open `par` fragment starts its
      // `and` block (arm entries never collide across nesting levels).
      for (const par of parallelArms) {
        const sep = par.sepByStep.get(step.stepNumber);
        if (sep !== undefined) lines.push(`  and ${escapeLabel(sep)}`);
      }
      switch (step.type) {
        case 'local':
          lines.push(`  Note over ${selfId}: ${escapeLabel(truncate(step.description, 70))}`);
          break;
        case 'branch':
          lines.push(`  Note over ${selfId}: ${escapeLabel(truncate(`◇ if ${step.condition ?? step.description}${step.onFalseStep !== undefined ? ` — else → step ${step.onFalseStep}` : ''}`, 80))}`);
          break;
        case 'switch':
          lines.push(`  Note over ${selfId}: ${escapeLabel(truncate(`◇ switch on ${step.on ?? step.description} (${step.cases?.length ?? 0} cases)`, 80))}`);
          break;
        case 'loop':
          if (step.endStep !== undefined) {
            lines.push(`  loop ${escapeLabel(truncate(step.over ?? step.condition ?? step.description, 60))}`);
            pendingEnds.push(step.endStep);
          } else {
            lines.push(`  Note over ${selfId}: ${escapeLabel(truncate(`⟳ ${step.description}`, 70))}`);
          }
          break;
        case 'try':
          if (step.endStep !== undefined) {
            lines.push(`  critical ${escapeLabel(truncate(step.description, 60))}`);
            pendingEnds.push(step.endStep);
          }
          for (const c of step.catches ?? []) {
            lines.push(`  Note over ${selfId}: ${escapeLabel(truncate(`⚠ on ${c.error} → step ${c.step}`, 70))}`);
          }
          break;
        case 'parallel': {
          const arms = step.branches ?? [];
          if (step.endStep !== undefined && arms.length >= 2) {
            const head = truncate(step.description, 60) + (arms[0].name ? ` — ${arms[0].name}` : '');
            lines.push(`  par ${escapeLabel(head)}`);
            const sepByStep = new Map<number, string>();
            arms.slice(1).forEach((b, i) => sepByStep.set(b.step, b.name ?? `arm ${i + 2}`));
            parallelArms.push({ end: step.endStep, sepByStep });
            pendingEnds.push(step.endStep);
          } else {
            lines.push(`  Note over ${selfId}: ${escapeLabel(truncate(`∥ ${step.description}`, 70))}`);
          }
          break;
        }
        case 'jump':
          lines.push(`  Note over ${selfId}: ${escapeLabel(`↷ → step ${step.toStep}`)}`);
          break;
        case 'return':
          lines.push(`  Note over ${selfId}: ${escapeLabel(truncate(`⏎ return${step.outcome ? ` — ${step.outcome}` : ''}`, 70))}`);
          break;
        case 'throw':
          lines.push(`  Note over ${selfId}: ${escapeLabel(truncate(`⚡ throw${step.error ? ` ${step.error}` : ''}`, 70))}`);
          break;
        case 'dispatch': {
          if (!step.targetComponent) break;
          const portal = componentById.get(step.targetComponent);
          if (!portal) {
            lines.push(`  Note over ${selfId}: ${escapeLabel(`dispatches via unknown "${step.targetComponent}"`)}`);
            break;
          }
          const portalId = declare(portal);
          // A detached dispatch fires asynchronously (open arrow, no wait);
          // the portal's own routing to the bound server stays synchronous.
          lines.push(step.detach
            ? `  ${selfId}-)${portalId}: ${escapeLabel(`⟨${step.capability ?? '?'}⟩`)} — detached`
            : `  ${selfId}->>${portalId}: ${escapeLabel(`⟨${step.capability ?? '?'}⟩`)}`);
          // Follow the table binding so the diagram shows the real server —
          // and keep walking its narrative, exactly like a call step, so the
          // downstream flow doesn't silently truncate at the dispatch hop.
          const binding = portal.dispatch?.find(b => b.capability === step.capability);
          const server = binding ? componentById.get(binding.component) : undefined;
          if (binding && server) {
            const serverId = declare(server);
            const expandable = depth < maxDepth
              && !!findMethodImpl(server.id, binding.method)
              && server.id !== comp.id;
            if (expandable) {
              lines.push(`  ${portalId}->>+${serverId}: ${escapeLabel(binding.method)}()`);
              walk(server, binding.method, depth + 1, nextStack);
              lines.push(`  ${serverId}-->>-${portalId}: return`);
            } else {
              lines.push(`  ${portalId}->>${serverId}: ${escapeLabel(binding.method)}()`);
            }
          }
          break;
        }
        case 'register': {
          // Runtime-callback handoff: a dashed arrow labeled "register", no
          // activation and no walk — registration is not an invocation, so the
          // callback's own flow is not part of this sequence.
          if (!step.targetComponent || !step.targetMethod) break;
          const regTarget = componentById.get(step.targetComponent);
          if (!regTarget) {
            lines.push(`  Note over ${selfId}: ${escapeLabel(`registers callback on unknown "${step.targetComponent}"`)}`);
            break;
          }
          const regTargetId = declare(regTarget);
          lines.push(`  ${selfId}--)${regTargetId}: ${escapeLabel(`register ${step.targetMethod}()`)}`);
          break;
        }
        case 'call': {
          if (!step.targetComponent || !step.targetMethod) break;
          const target = componentById.get(step.targetComponent);
          if (!target) {
            lines.push(`  Note over ${selfId}: ${escapeLabel(`calls unknown "${step.targetComponent}"`)}`);
            break;
          }
          const targetId = declare(target);
          const expandable = depth < maxDepth
            && !!findMethodImpl(target.id, step.targetMethod)
            && target.id !== comp.id;
          if (step.detach) {
            // Fire-and-forget: async open arrow, no activation, NO return —
            // the caller continues immediately and the callee's failure does
            // not propagate back into this flow.
            lines.push(`  ${selfId}-)${targetId}: ${escapeLabel(step.targetMethod)}() — detached`);
            if (expandable) walk(target, step.targetMethod, depth + 1, nextStack);
          } else if (expandable) {
            lines.push(`  ${selfId}->>+${targetId}: ${escapeLabel(step.targetMethod)}()`);
            walk(target, step.targetMethod, depth + 1, nextStack);
            lines.push(`  ${targetId}-->>-${selfId}: return`);
          } else {
            lines.push(`  ${selfId}->>${targetId}: ${escapeLabel(step.targetMethod)}()`);
          }
          break;
        }
      }
      closeRegionsAfter(step.stepNumber);
    }
    // Force-close any region whose endStep pointed past the last step.
    while (pendingEnds.length) { pendingEnds.pop(); lines.push('  end'); }
  };

  lines.push(`  Note over ${caller}: ${escapeLabel(`${methodName}()`)}`);
  walk(entry, methodName, 1, new Set());

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Full diagram set (for `wairon diagram --all`)
// ---------------------------------------------------------------------------

export function generateDiagramSet(): DiagramFile[] {
  const graph = loadSpecGraph();
  const files: DiagramFile[] = [];

  files.push({
    relPath: 'system.md',
    title: `${graph.systemName} — component architecture`,
    mermaid: generateComponentDiagram(),
  });

  for (const sub of graph.subsystems) {
    const hasComponents = graph.components.some(
      c => c.subsystem === sub.id || c.subsystem.startsWith(`${sub.id}::`),
    );
    if (!hasComponents) continue;
    files.push({
      relPath: `subsystems/${sub.id.replace(/::/g, '--')}.md`,
      title: `${sub.name} — components`,
      mermaid: generateComponentDiagram({ subsystem: sub.id }),
    });
  }

  // Sequences for every entrypoint (Portal/Observer/public) method with a narrative.
  const roots = graph.components.filter(
    c => c.componentType === 'Portal' || c.componentType === 'Observer' || graph.publicComponents.has(c.id),
  );
  const seen = new Set<string>();
  for (const root of roots) {
    if (seen.has(root.id)) continue;
    seen.add(root.id);
    const contractIds = new Set(graph.interfaces.filter(i => i.component === root.id).map(i => i.id));
    const impls = graph.implementations.filter(im => contractIds.has(im.contract));
    for (const impl of impls) {
      for (const m of impl.methods) {
        if (!m.narrative.length) continue;
        files.push({
          relPath: `sequences/${root.id.replace(/::/g, '--')}.${m.name}.md`,
          title: `${root.name}.${m.name} — narrative sequence`,
          mermaid: generateSequenceDiagram(root.id, m.name),
        });
      }
    }
  }

  return files;
}

/** Wrap raw mermaid in a titled markdown document (renders on GitHub / IDEs). */
export function toMarkdown(file: DiagramFile): string {
  return `# ${file.title}\n\n> Generated by \`wairon diagram\` from \`.wai/specs/\` — do not edit; regenerate instead.\n\n\`\`\`mermaid\n${file.mermaid}\n\`\`\`\n`;
}

/** Index README linking every generated diagram. */
export function diagramSetIndex(files: DiagramFile[], systemName: string): string {
  const lines: string[] = [];
  lines.push(`# ${systemName} — architecture diagrams`);
  lines.push('');
  lines.push('> Generated by `wairon diagram --all` from `.wai/specs/` — living documentation derived');
  lines.push('> from the same source of truth as the conformance gate. Regenerate after spec changes.');
  lines.push('');
  for (const f of files) {
    lines.push(`- [${f.title}](${f.relPath.replace(/\\/g, '/')})`);
  }
  lines.push('');
  return lines.join('\n');
}
