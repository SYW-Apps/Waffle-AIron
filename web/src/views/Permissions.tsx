import { useMemo, useState } from 'react';
import { get, post } from '../api';
import {
  AsyncButton,
  AsyncView,
  Badge,
  Button,
  DataTable,
  Field,
  Select,
  useAsync,
  useToast,
} from '../ui';
import {
  CAPABILITIES,
  PERMISSION_VALUES,
  userLabel,
  type Capability,
  type HostedUserRecord,
  type OrganizationUnitRecord,
  type PermissionAssignment,
  type PermissionValue,
  type ProjectRecord,
  type ScopeKind,
} from '../types';

/** A selectable authorization scope: the instance root, an org unit, or a
 *  project. The composite key encodes kind+id so a single <select> drives it. */
interface Scope {
  key: string;
  kind: ScopeKind;
  id: string;
  label: string;
}

function buildScopes(units: OrganizationUnitRecord[], projects: ProjectRecord[]): Scope[] {
  const scopes: Scope[] = [{ key: 'instance:', kind: 'instance', id: '', label: 'Instance (everywhere)' }];
  for (const u of [...units].sort((a, b) => a.id.localeCompare(b.id))) {
    scopes.push({ key: `unit:${u.id}`, kind: 'unit', id: u.id, label: `Unit · ${u.name} (${u.id})` });
  }
  for (const p of [...projects].sort((a, b) => a.id.localeCompare(b.id))) {
    scopes.push({ key: `project:${p.id}`, kind: 'project', id: p.id, label: `Project · ${p.id}` });
  }
  return scopes;
}

function scopeText(kind: ScopeKind, id: string | undefined): string {
  if (kind === 'instance') return 'instance';
  return `${kind}:${id ?? ''}`;
}

/**
 * Resolve a grid subject id to its user record. The canonical grid key is the
 * SUBJECT userId (the id a live Principal carries), but legacy rows may still be
 * keyed by a diverged user RECORD id — so a row's key must be matched against
 * BOTH, never assuming record id == grid key.
 */
function resolveUser(users: HostedUserRecord[], subjectId: string): HostedUserRecord | undefined {
  return users.find((u) => u.subject?.userId === subjectId) ?? users.find((u) => u.id === subjectId);
}

function SubjectCell(props: { assignment: PermissionAssignment; users: HostedUserRecord[] }) {
  const a = props.assignment;
  if (a.subjectKind === 'everyone') {
    return (
      <div className="cell-stack">
        <strong>Everyone</strong>
        <span className="hint">scope default</span>
      </div>
    );
  }
  const id = a.subjectId ?? '';
  const user = resolveUser(props.users, id);
  // Keyed by a diverged record id: the resolver honors it via the alias path,
  // but the canonical key for this user is their subject userId.
  const legacyKey = !!user && user.subject?.userId !== id;
  return (
    <div className="cell-stack">
      <strong>{user ? userLabel(user) : 'Unknown subject'}</strong>
      <code className="subtle">{id}</code>
      {legacyKey && <Badge tone="warn">legacy key</Badge>}
    </div>
  );
}

function PermValueBadge(props: { value: PermissionValue }) {
  const tone =
    props.value === 'yes' ? 'ok' : props.value === 'no' ? 'bad' : props.value === 'approval' ? 'warn' : 'neutral';
  return <Badge tone={tone}>{props.value}</Badge>;
}

// ── Set-assignment form ──────────────────────────────────────────────────────

function AssignmentForm(props: {
  users: HostedUserRecord[];
  scopes: Scope[];
  onSaved: () => void;
}) {
  const toast = useToast();
  const [subjectKind, setSubjectKind] = useState<'user' | 'everyone'>('user');
  // The users list arrives async after first render, so derive the default
  // selection instead of baking it into initial state.
  const [userId, setUserId] = useState('');
  const effectiveUserId = userId || (props.users[0]?.id ?? '');
  const [scopeKey, setScopeKey] = useState(props.scopes[0]?.key ?? 'instance:');
  const [capability, setCapability] = useState<Capability>(CAPABILITIES[0]);
  const [value, setValue] = useState<PermissionValue>('yes');
  const scope = props.scopes.find((s) => s.key === scopeKey) ?? props.scopes[0];

  async function apply() {
    // The user select carries the RECORD id (what the Users list shows); the
    // server canonicalizes user-subject keys to the subject userId on save.
    await post('/web/admin/permissions', {
      subjectKind,
      ...(subjectKind === 'user' ? { subjectId: effectiveUserId } : {}),
      scopeKind: scope.kind,
      scopeId: scope.kind === 'instance' ? undefined : scope.id,
      capability,
      value,
    });
    toast.ok(
      `${subjectKind === 'everyone' ? 'Everyone' : 'User'}: ${capability} = ${value} at ${scopeText(scope.kind, scope.id)}`,
    );
    props.onSaved();
  }

  return (
    <div className="panel">
      <h4>Set an assignment</h4>
      <p className="hint">
        One cell of the grid: subject × scope × capability → value. “Everyone” sets the scope's default for all
        users; a direct user row wins over roles and defaults at the same scope.
      </p>
      <div className="row-form">
        <Field label="Subject">
          <Select
            value={subjectKind}
            onChange={(v) => setSubjectKind(v as 'user' | 'everyone')}
            options={[
              { value: 'user', label: 'A user' },
              { value: 'everyone', label: 'Everyone (scope default)' },
            ]}
          />
        </Field>
        {subjectKind === 'user' && (
          <Field label="User">
            <Select
              value={effectiveUserId}
              onChange={setUserId}
              options={props.users.map((u) => ({ value: u.id, label: userLabel(u) }))}
            />
          </Field>
        )}
        <Field label="Scope">
          <Select
            value={scopeKey}
            onChange={setScopeKey}
            options={props.scopes.map((s) => ({ value: s.key, label: s.label }))}
          />
        </Field>
        <Field label="Capability">
          <Select
            value={capability}
            onChange={(v) => setCapability(v as Capability)}
            options={CAPABILITIES.map((c) => ({ value: c, label: c }))}
          />
        </Field>
        <Field label="Value">
          <Select
            value={value}
            onChange={(v) => setValue(v as PermissionValue)}
            options={PERMISSION_VALUES.map((v) => ({ value: v, label: v }))}
          />
        </Field>
        <div className="row-form-action">
          <AsyncButton
            variant="primary"
            action={apply}
            onError={toast.bad}
            disabled={subjectKind === 'user' && !effectiveUserId}
          >
            Apply
          </AsyncButton>
        </div>
      </div>
    </div>
  );
}

// ── Permissions view (the whole assignment grid) ─────────────────────────────

export function Permissions() {
  const toast = useToast();
  // Permission mutations broadcast on the roles+users channels; scope pickers
  // follow their own collections.
  const assignments = useAsync<{ assignments: PermissionAssignment[] }>(
    () => get('/web/admin/permissions'),
    [],
    ['roles', 'users'],
  );
  const users = useAsync<{ users: HostedUserRecord[] }>(() => get('/web/admin/users'), [], ['users']);
  const units = useAsync<{ units: OrganizationUnitRecord[] }>(() => get('/web/admin/org/units'), [], ['units']);
  const projects = useAsync<{ projects: ProjectRecord[] }>(() => get('/web/projects'), [], ['projects']);

  const [scopeFilter, setScopeFilter] = useState('all');
  const [subjectFilter, setSubjectFilter] = useState('all');

  const userList = users.data?.users ?? [];
  const scopes = useMemo(
    () => buildScopes(units.data?.units ?? [], projects.data?.projects ?? []),
    [units.data, projects.data],
  );

  const rows = useMemo(() => {
    const all = assignments.data?.assignments ?? [];
    return all.filter((a) => {
      if (scopeFilter !== 'all') {
        const s = scopes.find((sc) => sc.key === scopeFilter);
        if (!s || a.scopeKind !== s.kind || (a.scopeId ?? '') !== s.id) return false;
      }
      if (subjectFilter === 'everyone') {
        if (a.subjectKind !== 'everyone') return false;
      } else if (subjectFilter !== 'all') {
        // The filter carries a user RECORD id; a row may be keyed by either the
        // record id or the canonical subject userId — match both.
        if (a.subjectKind !== 'user') return false;
        const u = userList.find((x) => x.id === subjectFilter);
        const keys = new Set([subjectFilter, u?.subject?.userId].filter(Boolean));
        if (!keys.has(a.subjectId ?? '')) return false;
      }
      return true;
    });
  }, [assignments.data, scopeFilter, subjectFilter, scopes, userList]);

  const defaults = useMemo(
    () => (assignments.data?.assignments ?? []).filter((a) => a.subjectKind === 'everyone'),
    [assignments.data],
  );

  async function remove(id: string) {
    await post('/web/admin/permissions/remove', { id });
    toast.ok('Assignment removed');
    assignments.reload();
  }

  const columns = [
    {
      key: 'subject',
      header: 'Subject',
      cell: (a: PermissionAssignment) => <SubjectCell assignment={a} users={userList} />,
    },
    {
      key: 'scope',
      header: 'Scope',
      cell: (a: PermissionAssignment) => <code>{scopeText(a.scopeKind, a.scopeId)}</code>,
    },
    { key: 'cap', header: 'Capability', cell: (a: PermissionAssignment) => <code>{a.capability}</code> },
    { key: 'val', header: 'Value', cell: (a: PermissionAssignment) => <PermValueBadge value={a.value} /> },
    {
      key: 'act',
      header: '',
      width: '1%',
      cell: (a: PermissionAssignment) => (
        <AsyncButton size="sm" variant="ghost" action={() => remove(a.id)} onError={toast.bad}>
          Remove
        </AsyncButton>
      ),
    },
  ];

  return (
    <div className="view-pad">
      <div className="view-head">
        <div>
          <h2>Permissions</h2>
          <p className="hint">
            The assignment grid: subject × scope × capability → value. Resolution walks the target's ancestor
            chain leaf→root and stops at the nearest decisive scope; within a scope, direct user &gt; role &gt;
            everyone-default.
          </p>
        </div>
        <Button variant="ghost" onClick={assignments.reload}>
          Refresh
        </Button>
      </div>

      <AssignmentForm
        users={userList}
        scopes={scopes}
        onSaved={assignments.reload}
      />

      <div className="panel">
        <h4>Scope defaults (everyone)</h4>
        <p className="hint">
          What every authenticated user gets at a scope unless a nearer decision applies. No defaults means the
          instance root falls back to <code>no</code> for non-admins.
        </p>
        <AsyncView state={assignments}>
          {() => (
            <DataTable<PermissionAssignment>
              rowKey={(a) => a.id}
              empty="No scope defaults set — access comes entirely from roles and direct user assignments."
              rows={defaults}
              columns={columns.filter((c) => c.key !== 'subject')}
            />
          )}
        </AsyncView>
      </div>

      <div className="panel">
        <div className="view-head">
          <h4>All assignments</h4>
          <div className="row-form">
            <Field label="Scope">
              <Select
                value={scopeFilter}
                onChange={setScopeFilter}
                options={[{ value: 'all', label: 'All scopes' }, ...scopes.map((s) => ({ value: s.key, label: s.label }))]}
              />
            </Field>
            <Field label="Subject">
              <Select
                value={subjectFilter}
                onChange={setSubjectFilter}
                options={[
                  { value: 'all', label: 'All subjects' },
                  { value: 'everyone', label: 'Everyone (defaults)' },
                  ...userList.map((u) => ({ value: u.id, label: userLabel(u) })),
                ]}
              />
            </Field>
          </div>
        </div>
        <AsyncView state={assignments}>
          {() => (
            <DataTable<PermissionAssignment>
              rowKey={(a) => a.id}
              empty="No assignments match the filter."
              rows={rows}
              columns={columns}
            />
          )}
        </AsyncView>
      </div>
    </div>
  );
}
