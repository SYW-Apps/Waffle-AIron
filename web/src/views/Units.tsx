import { useMemo, useState } from 'react';
import { get, post } from '../api';
import {
  AsyncButton,
  AsyncView,
  Badge,
  Button,
  Field,
  Modal,
  Select,
  TextInput,
  useAsync,
  useToast,
} from '../ui';
import type { OrganizationUnitRecord } from '../types';

interface TreeNode {
  unit: OrganizationUnitRecord;
  children: TreeNode[];
}

function buildTree(units: OrganizationUnitRecord[]): TreeNode[] {
  const byId = new Map<string, TreeNode>();
  for (const u of units) byId.set(u.id, { unit: u, children: [] });
  const roots: TreeNode[] = [];
  for (const node of byId.values()) {
    const parent = node.unit.parentId ? byId.get(node.unit.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sortRec = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => a.unit.slug.localeCompare(b.unit.slug));
    nodes.forEach((n) => sortRec(n.children));
  };
  sortRec(roots);
  return roots;
}

const UNIT_KINDS = ['business_entity', 'department', 'team', 'portfolio', 'group'];

// ── Create / edit unit modal ─────────────────────────────────────────────────

function UnitModal(props: {
  mode: 'create' | 'edit';
  existing?: OrganizationUnitRecord;
  units: OrganizationUnitRecord[];
  defaultParentId?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(props.existing?.name ?? '');
  const [kind, setKind] = useState(props.existing?.kind ?? 'team');
  const [slug, setSlug] = useState(props.existing?.slug ?? '');
  const [parentId, setParentId] = useState(props.existing?.parentId ?? props.defaultParentId ?? '');
  const [visibility, setVisibility] = useState(props.existing?.visibility ?? 'inherit');
  const isEdit = props.mode === 'edit';

  const parentOptions = [
    { value: '', label: '(top-level / tenant root)' },
    ...props.units
      .filter((u) => u.id !== props.existing?.id)
      .map((u) => ({ value: u.id, label: `${u.name} (${u.id})` })),
  ];

  const previewId = isEdit ? props.existing!.id : parentId ? `${parentId}.${slug}` : slug;

  async function save() {
    const record: Partial<OrganizationUnitRecord> = isEdit
      ? { id: props.existing!.id, name, kind, slug: props.existing!.slug, parentId: props.existing!.parentId, visibility }
      : { name, kind, slug, parentId: parentId || undefined, visibility };
    await post('/web/admin/org/units', record);
    toast.ok(isEdit ? 'Unit updated' : `Unit “${name}” created`);
    props.onSaved();
    props.onClose();
  }

  return (
    <Modal
      title={isEdit ? `Edit unit · ${props.existing!.name}` : 'New organization unit'}
      onClose={props.onClose}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <AsyncButton variant="primary" action={save} onError={toast.bad} disabled={!name || (!isEdit && !slug)}>
            {isEdit ? 'Save' : 'Create'}
          </AsyncButton>
        </>
      }
    >
      <div className="stack-lg">
        <Field label="Display name">
          <TextInput value={name} onChange={setName} placeholder="Platform Team" />
        </Field>
        <Field label="Kind">
          <Select value={kind} onChange={setKind} options={UNIT_KINDS.map((k) => ({ value: k, label: k }))} />
        </Field>
        {!isEdit && (
          <>
            <Field label="Slug" hint="Lowercase [a-z0-9-], no dots. Unique among siblings.">
              <TextInput value={slug} onChange={(v) => setSlug(v.toLowerCase())} placeholder="platform" />
            </Field>
            <Field label="Parent unit">
              <Select value={parentId} onChange={setParentId} options={parentOptions} />
            </Field>
            <Field label="Qualified id (computed)">
              <code className="preview-id">{previewId || '—'}</code>
            </Field>
          </>
        )}
        <Field label="Visibility" hint="'inherit' takes the parent's posture; 'closed' hides placements outside this subtree.">
          <Select
            value={visibility}
            onChange={setVisibility}
            options={['inherit', 'open', 'closed'].map((v) => ({ value: v, label: v }))}
          />
        </Field>
      </div>
    </Modal>
  );
}

// ── Remove unit modal (disposition) ──────────────────────────────────────────

function RemoveUnitModal(props: {
  unit: OrganizationUnitRecord;
  units: OrganizationUnitRecord[];
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [kind, setKind] = useState<'absorb' | 'migrate' | 'alternative' | 'cascade'>('absorb');
  const [targetUnitId, setTargetUnitId] = useState('');
  const [newSlug, setNewSlug] = useState('');
  const isRoot = !props.unit.parentId;

  // Migration targets exclude this unit and its descendants.
  const descendants = useMemo(() => {
    const set = new Set<string>([props.unit.id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const u of props.units) {
        if (u.parentId && set.has(u.parentId) && !set.has(u.id)) {
          set.add(u.id);
          grew = true;
        }
      }
    }
    return set;
  }, [props.unit, props.units]);
  const targetOptions = props.units.filter((u) => !descendants.has(u.id)).map((u) => ({ value: u.id, label: `${u.name} (${u.id})` }));

  async function remove() {
    const disposition: Record<string, unknown> = { kind };
    if (kind === 'migrate') disposition.targetUnitId = targetUnitId;
    if (kind === 'alternative') disposition.newSlug = newSlug;
    await post('/web/admin/org/units/remove', { unitId: props.unit.id, disposition });
    toast.ok(`Removed unit ${props.unit.id} (${kind})`);
    props.onDone();
    props.onClose();
  }

  const valid = kind === 'absorb' || kind === 'cascade' || (kind === 'migrate' && targetUnitId) || (kind === 'alternative' && newSlug);

  return (
    <Modal
      title={`Remove unit · ${props.unit.name}`}
      onClose={props.onClose}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <AsyncButton variant="danger" action={remove} onError={toast.bad} disabled={!valid}>
            Remove
          </AsyncButton>
        </>
      }
    >
      <div className="stack-lg">
        <p className="hint">
          A unit is never silently cascade-deleted. Choose what happens to its child units, placements, and the
          permission scopes anchored to it.
        </p>
        <Field label="Disposition">
          <Select
            value={kind}
            onChange={(v) => setKind(v as typeof kind)}
            options={[
              { value: 'absorb', label: 'Absorb — move content up to the parent' },
              { value: 'migrate', label: 'Migrate — move content to another existing unit' },
              { value: 'alternative', label: 'Alternative — create a replacement sibling' },
              { value: 'cascade', label: 'Cascade — delete this unit and its whole subtree' },
            ].filter((o) => !(o.value === 'absorb' && isRoot))}
          />
        </Field>
        {kind === 'migrate' && (
          <Field label="Destination unit">
            <Select value={targetUnitId} onChange={setTargetUnitId} options={[{ value: '', label: '(choose…)' }, ...targetOptions]} />
          </Field>
        )}
        {kind === 'alternative' && (
          <Field label="Replacement slug" hint="A fresh sibling under the same parent; content moves into it.">
            <TextInput value={newSlug} onChange={(v) => setNewSlug(v.toLowerCase())} placeholder="platform-v2" />
          </Field>
        )}
        {kind === 'cascade' && (
          <p className="error-note">
            This permanently deletes the subtree, its placements, and permission assignments scoped into it.
          </p>
        )}
      </div>
    </Modal>
  );
}

// ── Unit tree rows (collapsible, default open) ───────────────────────────────

function UnitRow(props: {
  node: TreeNode;
  depth: number;
  onEdit: (u: OrganizationUnitRecord) => void;
  onRemove: (u: OrganizationUnitRecord) => void;
  onAddChild: (parentId: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const { unit, children } = props.node;
  const hasKids = children.length > 0;
  return (
    <>
      <div className="tree-row" style={{ paddingLeft: 8 + props.depth * 20 }}>
        <button className="twist" onClick={() => setOpen((o) => !o)} aria-label={open ? 'Collapse' : 'Expand'}>
          {hasKids ? (open ? '▾' : '▸') : '·'}
        </button>
        <div className="tree-main">
          <strong>{unit.name}</strong>
          <Badge tone="neutral">{unit.kind}</Badge>
          {unit.visibility && unit.visibility !== 'inherit' && <Badge tone="warn">{unit.visibility}</Badge>}
          <code className="subtle">{unit.id}</code>
        </div>
        <div className="row-actions">
          <Button size="sm" variant="ghost" onClick={() => props.onAddChild(unit.id)}>
            + Sub-unit
          </Button>
          <Button size="sm" variant="ghost" onClick={() => props.onEdit(unit)}>
            Edit
          </Button>
          <Button size="sm" variant="ghost" onClick={() => props.onRemove(unit)}>
            Remove
          </Button>
        </div>
      </div>
      {open &&
        children.map((c) => (
          <UnitRow
            key={c.unit.id}
            node={c}
            depth={props.depth + 1}
            onEdit={props.onEdit}
            onRemove={props.onRemove}
            onAddChild={props.onAddChild}
          />
        ))}
    </>
  );
}

// ── Units view ───────────────────────────────────────────────────────────────

export function Units() {
  const units = useAsync<{ units: OrganizationUnitRecord[] }>(() => get('/web/admin/org/units'), []);
  const [creating, setCreating] = useState<{ parentId?: string } | null>(null);
  const [editing, setEditing] = useState<OrganizationUnitRecord | null>(null);
  const [removing, setRemoving] = useState<OrganizationUnitRecord | null>(null);
  const list = units.data?.units ?? [];
  const tree = useMemo(() => buildTree(list), [list]);

  return (
    <div className="view-pad">
      <div className="view-head">
        <div>
          <h2>Organization units</h2>
          <p className="hint">Hierarchical grouping of projects and the scopes permissions anchor to. Rows are collapsible.</p>
        </div>
        <Button variant="primary" onClick={() => setCreating({})}>
          + New unit
        </Button>
      </div>

      <AsyncView state={units}>
        {() =>
          tree.length === 0 ? (
            <div className="empty-state">No organization units yet. Create one to start grouping projects.</div>
          ) : (
            <div className="tree">
              {tree.map((n) => (
                <UnitRow
                  key={n.unit.id}
                  node={n}
                  depth={0}
                  onEdit={setEditing}
                  onRemove={setRemoving}
                  onAddChild={(parentId) => setCreating({ parentId })}
                />
              ))}
            </div>
          )
        }
      </AsyncView>

      {creating && (
        <UnitModal
          mode="create"
          units={list}
          defaultParentId={creating.parentId}
          onClose={() => setCreating(null)}
          onSaved={units.reload}
        />
      )}
      {editing && (
        <UnitModal mode="edit" existing={editing} units={list} onClose={() => setEditing(null)} onSaved={units.reload} />
      )}
      {removing && (
        <RemoveUnitModal unit={removing} units={list} onClose={() => setRemoving(null)} onDone={units.reload} />
      )}
    </div>
  );
}
