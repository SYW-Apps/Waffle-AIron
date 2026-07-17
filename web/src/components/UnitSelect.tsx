import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { OrganizationUnitRecord } from '../types';

/**
 * A hierarchical unit picker: instead of a free-text unit id or a flat dropdown,
 * it shows the org tree as a collapsible list (twist per branch), so a unit is
 * chosen by where it sits in the hierarchy. Reused everywhere a unit id is asked
 * for (backup scope, project placement, parent unit, move target). A lightweight
 * filter flattens to matching subtrees. Renders inline (in normal flow) so it is
 * never clipped by a modal body's scroll.
 */

interface TreeNode {
  unit: OrganizationUnitRecord;
  children: TreeNode[];
}

/** Build the unit forest, optionally dropping a unit and its whole subtree (used
 *  by parent / move-target pickers, which must not point into themselves). */
function buildUnitTree(units: OrganizationUnitRecord[], excludeSubtreeOf?: string): TreeNode[] {
  let pool = units;
  if (excludeSubtreeOf) {
    const excluded = new Set<string>([excludeSubtreeOf]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const u of units) {
        if (u.parentId && excluded.has(u.parentId) && !excluded.has(u.id)) {
          excluded.add(u.id);
          grew = true;
        }
      }
    }
    pool = units.filter((u) => !excluded.has(u.id));
  }
  const byId = new Map<string, TreeNode>();
  for (const u of pool) byId.set(u.id, { unit: u, children: [] });
  const roots: TreeNode[] = [];
  for (const node of byId.values()) {
    const parent = node.unit.parentId ? byId.get(node.unit.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sortRec = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => (a.unit.slug || a.unit.name).localeCompare(b.unit.slug || b.unit.name));
    nodes.forEach((n) => sortRec(n.children));
  };
  sortRec(roots);
  return roots;
}

export function UnitSelect(props: {
  units: OrganizationUnitRecord[];
  value: string;
  onChange: (id: string) => void;
  /** Text on the trigger when nothing is chosen (and empty isn't allowed). */
  placeholder?: string;
  /** Offer an explicit "no unit" choice (default true). */
  allowEmpty?: boolean;
  emptyLabel?: string;
  /** Exclude this unit and its descendants from the choices. */
  excludeSubtreeOf?: string;
  disabled?: boolean;
}) {
  const {
    units,
    value,
    onChange,
    placeholder = 'Select a unit…',
    allowEmpty = true,
    emptyLabel = '(none)',
    excludeSubtreeOf,
    disabled,
  } = props;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const rootRef = useRef<HTMLDivElement | null>(null);

  const tree = useMemo(() => buildUnitTree(units, excludeSubtreeOf), [units, excludeSubtreeOf]);
  const selected = units.find((u) => u.id === value);

  // Close on outside click / Escape (Escape is caught in capture so it closes the
  // picker before the enclosing modal).
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
        e.stopPropagation();
      }
    }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  function toggle(id: string) {
    setCollapsed((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }
  function choose(id: string) {
    onChange(id);
    setOpen(false);
    setQuery('');
  }

  const q = query.trim().toLowerCase();
  const matches = (u: OrganizationUnitRecord) => !q || u.name.toLowerCase().includes(q) || u.id.toLowerCase().includes(q);
  const subtreeMatches = (node: TreeNode): boolean => matches(node.unit) || node.children.some(subtreeMatches);

  function renderNodes(nodes: TreeNode[], depth: number): ReactNode[] {
    const out: ReactNode[] = [];
    for (const node of nodes) {
      if (q && !subtreeMatches(node)) continue;
      const hasKids = node.children.length > 0;
      const isCollapsed = collapsed.has(node.unit.id) && !q;
      out.push(
        <div
          key={node.unit.id}
          className={`unitsel-row ${node.unit.id === value ? 'sel' : ''}`}
          style={{ paddingLeft: 6 + depth * 18 }}
        >
          <button
            type="button"
            className="unitsel-twist"
            onClick={(e) => {
              e.stopPropagation();
              if (hasKids) toggle(node.unit.id);
            }}
            aria-label={hasKids ? (isCollapsed ? 'Expand' : 'Collapse') : undefined}
          >
            {hasKids ? (isCollapsed ? '▸' : '▾') : '·'}
          </button>
          <button type="button" className="unitsel-label" onClick={() => choose(node.unit.id)}>
            <span className="unitsel-name">{node.unit.name}</span>
            <span className="unitsel-kind">{node.unit.kind}</span>
            <code className="unitsel-id">{node.unit.id}</code>
          </button>
        </div>,
      );
      if (hasKids && !isCollapsed) out.push(...renderNodes(node.children, depth + 1));
    }
    return out;
  }

  return (
    <div className="unitsel" ref={rootRef}>
      <button
        type="button"
        className="input unitsel-trigger"
        disabled={disabled}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {selected ? (
          <span className="unitsel-current">
            <span className="unitsel-name">{selected.name}</span>
            <code className="unitsel-id">{selected.id}</code>
          </span>
        ) : value ? (
          // A value we can't resolve to a known unit (e.g. typed elsewhere) — show it raw.
          <code className="unitsel-id">{value}</code>
        ) : (
          <span className="unitsel-ph">{allowEmpty ? emptyLabel : placeholder}</span>
        )}
        <span className="unitsel-caret" aria-hidden>
          ▾
        </span>
      </button>
      {open && (
        <div className="unitsel-pop">
          <input
            className="input unitsel-search"
            autoFocus
            placeholder="Filter units…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="unitsel-list">
            {allowEmpty && !q && (
              <div className={`unitsel-row ${!value ? 'sel' : ''}`}>
                <span className="unitsel-twist">·</span>
                <button type="button" className="unitsel-label" onClick={() => choose('')}>
                  <span className="unitsel-ph">{emptyLabel}</span>
                </button>
              </div>
            )}
            {tree.length === 0 ? (
              <div className="unitsel-empty">No units available.</div>
            ) : (
              renderNodes(tree, 0)
            )}
          </div>
        </div>
      )}
    </div>
  );
}
