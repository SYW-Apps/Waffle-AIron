// ---------------------------------------------------------------------------
// Export tables, resolved.
//
// Every level of a project exports the way a module does: a subsystem to the
// other subsystems of its project (L1 publicInterfaces), the project to other
// projects (L0 publicInterfaces). A level re-exports what a level below
// already declares instead of redeclaring it, and the export index follows
// every such chain to the item it names — the way a module resolver binds
// `export … from` to its declaration. These are the shapes it answers with.
// ---------------------------------------------------------------------------

/**
 * One resolved entry of an export table: a public name bound to its canonical
 * target after every re-export has been followed.
 */
export interface ResolvedExport {
  /** The name consumers use. */
  publicName: string;
  /** component | type */
  kind: 'component' | 'type';
  /** The subsystem that declares the exported item — where the chain ends. */
  source: string;
  /** The exported component's qualified id, for kind component. */
  component?: string;
  /** The L3 interface the export narrows to, when it narrows. */
  interface?: string;
  /** The exported type's qualified id, for kind type. */
  typeDef?: string;
  /** The exported component's stereotype. */
  componentType?: string;
  /** Transport kind, from the entry or inherited from its target's entry. */
  type?: string;
  /** Consumer-facing description, from the entry or inherited. */
  details?: string;
  /** Human-readable surface name, on project tables where the L0 entry declares one. */
  name?: string;
  /** The reach ceiling, on project tables only (default instance). */
  audience?: string;
  /** The L0 entry's authentication policy summary. */
  authPolicy?: string;
  /** The L0 entry's public contract version. */
  version?: string;
  /** The L0 entry's contract stability. */
  stability?: string;
  /** The levels the name passed through, from the table's owner to the declaring subsystem; empty for an own item. */
  via: string[];
}

/** The problem kinds the export resolver reports; the export-tables rule judges them. */
export type ExportProblemKind = 'duplicate' | 'named-cycle' | 'wildcard-cycle' | 'invalid' | 'unconsumable';

/** A fact the export resolver met while resolving one table — reported, never judged. */
export interface ExportProblem {
  kind: ExportProblemKind;
  /** The table's owner: a subsystem id, or the system name for the L0 table. */
  owner: string;
  /** The public name concerned, when there is one. */
  publicName?: string;
  /** For a duplicate, the competing targets; for a cycle, the levels on the loop. */
  targets?: string[];
  /** What is wrong, in words a finding can quote. */
  detail: string;
}

/** An export table after resolution, flattened, with the problems met on the way. */
export interface ResolvedExportTable {
  /** A subsystem id, or the system name for the project table. */
  owner: string;
  /** subsystem | project */
  level: 'subsystem' | 'project';
  entries: ResolvedExport[];
  problems: ExportProblem[];
}

/** A public name: lower-case letters, digits, `-` and `_`. */
export const PUBLIC_NAME_RE = /^[a-z0-9_-]+$/;

/** The canonical target a resolved export binds — two entries with the same key are one item. */
export function exportTargetKey(e: Pick<ResolvedExport, 'kind' | 'component' | 'interface' | 'typeDef'>): string {
  return e.kind === 'type' ? `type:${e.typeDef}` : `component:${e.component}${e.interface ? `#${e.interface}` : ''}`;
}
