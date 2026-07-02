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

    for (const step of methodImpl.narrative) {
      if (step.type === 'local') {
        lines.push(`  Note over ${selfId}: ${escapeLabel(truncate(step.description, 70))}`);
        continue;
      }
      if (!step.targetComponent || !step.targetMethod) continue;
      const target = componentById.get(step.targetComponent);
      if (!target) {
        lines.push(`  Note over ${selfId}: ${escapeLabel(`calls unknown "${step.targetComponent}"`)}`);
        continue;
      }
      const targetId = declare(target);
      const expandable = depth < maxDepth
        && !!findMethodImpl(target.id, step.targetMethod)
        && target.id !== comp.id;
      if (expandable) {
        lines.push(`  ${selfId}->>+${targetId}: ${escapeLabel(step.targetMethod)}()`);
        walk(target, step.targetMethod, depth + 1, nextStack);
        lines.push(`  ${targetId}-->>-${selfId}: return`);
      } else {
        lines.push(`  ${selfId}->>${targetId}: ${escapeLabel(step.targetMethod)}()`);
      }
    }
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
