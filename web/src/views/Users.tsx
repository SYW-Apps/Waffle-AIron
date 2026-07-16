import { useMemo, useState } from 'react';
import { get, post } from '../api';
import {
  AsyncButton,
  AsyncView,
  Badge,
  Button,
  ConfirmButton,
  DataTable,
  Field,
  Modal,
  Select,
  Tabs,
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
  type Role,
  type RoleBinding,
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

// ── Roles tab (role bindings per scope) ──────────────────────────────────────

function RolesTab(props: { user: HostedUserRecord; roles: Role[]; scopes: Scope[]; onChanged: () => void }) {
  const toast = useToast();
  const [roleId, setRoleId] = useState(props.roles[0]?.id ?? '');
  const [scopeKey, setScopeKey] = useState(props.scopes[0]?.key ?? 'instance:');
  const bindings = props.user.roleBindings ?? [];
  const roleName = (id: string) => props.roles.find((r) => r.id === id)?.name ?? id;

  const scope = props.scopes.find((s) => s.key === scopeKey) ?? props.scopes[0];

  async function bind() {
    if (!roleId) return;
    await post('/web/admin/roles/bind', {
      userId: props.user.id,
      roleId,
      scopeKind: scope.kind,
      scopeId: scope.kind === 'instance' ? undefined : scope.id,
    });
    toast.ok(`Assigned “${roleName(roleId)}” at ${scopeText(scope.kind, scope.id)}`);
    props.onChanged();
  }

  async function unbind(b: RoleBinding) {
    await post('/web/admin/roles/unbind', {
      userId: props.user.id,
      roleId: b.roleId,
      scopeKind: b.scopeKind ?? 'instance',
      scopeId: b.scopeId,
    });
    toast.ok('Role removed');
    props.onChanged();
  }

  return (
    <div className="stack-lg">
      <div className="panel">
        <h4>Current roles</h4>
        {bindings.length === 0 ? (
          <p className="hint">No roles assigned. Roles grant capabilities at the scope you bind them to.</p>
        ) : (
          <DataTable<RoleBinding>
            rowKey={(b) => `${b.roleId}@${b.scopeKind ?? 'instance'}:${b.scopeId ?? ''}`}
            rows={bindings}
            columns={[
              { key: 'role', header: 'Role', cell: (b) => <strong>{roleName(b.roleId)}</strong> },
              {
                key: 'scope',
                header: 'Scope',
                cell: (b) => <code>{scopeText(b.scopeKind ?? 'instance', b.scopeId)}</code>,
              },
              {
                key: 'act',
                header: '',
                width: '1%',
                cell: (b) => (
                  <AsyncButton size="sm" variant="ghost" action={() => unbind(b)} onError={toast.bad}>
                    Remove
                  </AsyncButton>
                ),
              },
            ]}
          />
        )}
      </div>

      <div className="panel">
        <h4>Assign a role</h4>
        <div className="row-form">
          <Field label="Role">
            <Select
              value={roleId}
              onChange={setRoleId}
              options={props.roles.map((r) => ({ value: r.id, label: r.name }))}
            />
          </Field>
          <Field label="Scope">
            <Select value={scopeKey} onChange={setScopeKey} options={props.scopes.map((s) => ({ value: s.key, label: s.label }))} />
          </Field>
          <div className="row-form-action">
            <AsyncButton variant="primary" action={bind} onError={toast.bad} disabled={!roleId}>
              Assign
            </AsyncButton>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Permissions tab (direct per-scope overrides) ─────────────────────────────

function PermissionsTab(props: { user: HostedUserRecord; scopes: Scope[] }) {
  const toast = useToast();
  const assignments = useAsync<{ assignments: PermissionAssignment[] }>(
    () => get(`/web/admin/permissions?subjectKind=user&subjectId=${encodeURIComponent(props.user.id)}`),
    [props.user.id],
  );
  const [scopeKey, setScopeKey] = useState(props.scopes[0]?.key ?? 'instance:');
  const [capability, setCapability] = useState<Capability>(CAPABILITIES[0]);
  const [value, setValue] = useState<PermissionValue>('yes');
  const scope = props.scopes.find((s) => s.key === scopeKey) ?? props.scopes[0];

  async function setOverride() {
    await post('/web/admin/permissions', {
      subjectKind: 'user',
      subjectId: props.user.id,
      scopeKind: scope.kind,
      scopeId: scope.kind === 'instance' ? undefined : scope.id,
      capability,
      value,
    });
    toast.ok(`${capability} = ${value} at ${scopeText(scope.kind, scope.id)}`);
    assignments.reload();
  }

  async function removeOverride(id: string) {
    await post('/web/admin/permissions/remove', { id });
    toast.ok('Override removed');
    assignments.reload();
  }

  return (
    <div className="stack-lg">
      <p className="hint">
        Direct overrides win over roles for this user. Use them to grant or explicitly deny a single capability at one
        scope — <code>no</code> denies even when a role would allow.
      </p>
      <AsyncView state={assignments}>
        {(d) => (
          <DataTable<PermissionAssignment>
            rowKey={(a) => a.id}
            empty="No direct overrides — this user's access comes entirely from roles."
            rows={d.assignments}
            columns={[
              { key: 'cap', header: 'Capability', cell: (a) => <code>{a.capability}</code> },
              { key: 'scope', header: 'Scope', cell: (a) => <code>{scopeText(a.scopeKind, a.scopeId)}</code> },
              { key: 'val', header: 'Value', cell: (a) => <PermValueBadge value={a.value} /> },
              {
                key: 'act',
                header: '',
                width: '1%',
                cell: (a) => (
                  <AsyncButton size="sm" variant="ghost" action={() => removeOverride(a.id)} onError={toast.bad}>
                    Remove
                  </AsyncButton>
                ),
              },
            ]}
          />
        )}
      </AsyncView>

      <div className="panel">
        <h4>Add / change an override</h4>
        <div className="row-form">
          <Field label="Scope">
            <Select value={scopeKey} onChange={setScopeKey} options={props.scopes.map((s) => ({ value: s.key, label: s.label }))} />
          </Field>
          <Field label="Capability">
            <Select value={capability} onChange={setCapability} options={CAPABILITIES.map((c) => ({ value: c, label: c }))} />
          </Field>
          <Field label="Value">
            <Select value={value} onChange={setValue} options={PERMISSION_VALUES.map((v) => ({ value: v, label: v }))} />
          </Field>
          <div className="row-form-action">
            <AsyncButton variant="primary" action={setOverride} onError={toast.bad}>
              Apply
            </AsyncButton>
          </div>
        </div>
      </div>
    </div>
  );
}

function PermValueBadge(props: { value: PermissionValue }) {
  const tone = props.value === 'yes' ? 'ok' : props.value === 'no' ? 'bad' : props.value === 'approval' ? 'warn' : 'neutral';
  return <Badge tone={tone}>{props.value}</Badge>;
}

// ── Access modal (roles + permissions) ───────────────────────────────────────

function AccessModal(props: {
  user: HostedUserRecord;
  roles: Role[];
  scopes: Scope[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState('roles');
  return (
    <Modal wide title={`Access · ${userLabel(props.user)}`} onClose={props.onClose} footer={<Button onClick={props.onClose}>Done</Button>}>
      <Tabs
        active={tab}
        onSelect={setTab}
        tabs={[
          { id: 'roles', label: 'Roles' },
          { id: 'permissions', label: 'Direct permissions' },
        ]}
      />
      <div className="tab-panel">
        {tab === 'roles' ? (
          <RolesTab user={props.user} roles={props.roles} scopes={props.scopes} onChanged={props.onChanged} />
        ) : (
          <PermissionsTab user={props.user} scopes={props.scopes} />
        )}
      </div>
    </Modal>
  );
}

// ── Users view ───────────────────────────────────────────────────────────────

export function Users() {
  const toast = useToast();
  const users = useAsync<{ users: HostedUserRecord[] }>(() => get('/web/admin/users'), []);
  const roles = useAsync<{ roles: Role[] }>(() => get('/web/admin/roles'), []);
  const units = useAsync<{ units: OrganizationUnitRecord[] }>(() => get('/web/admin/org/units'), []);
  const projects = useAsync<{ projects: ProjectRecord[] }>(() => get('/web/projects'), []);
  const [editingId, setEditingId] = useState<string | null>(null);
  // Derive the edited user from the live list so a role/permission change (which
  // reloads users) is reflected in the open modal instead of showing stale data.
  const editing = editingId ? (users.data?.users.find((u) => u.id === editingId) ?? null) : null;

  const scopes = useMemo(
    () => buildScopes(units.data?.units ?? [], projects.data?.projects ?? []),
    [units.data, projects.data],
  );
  const roleList = roles.data?.roles ?? [];
  const unitName = (id?: string) => (id ? units.data?.units.find((u) => u.id === id)?.name ?? id : '—');

  async function setStatus(u: HostedUserRecord, status: string) {
    await post('/web/admin/users/status', { userId: u.id, status });
    toast.ok(`${userLabel(u)} → ${status}`);
    users.reload();
  }

  return (
    <div className="view-pad">
      <div className="view-head">
        <div>
          <h2>Users</h2>
          <p className="hint">People with accounts on this instance. Assign roles and per-scope permission overrides here.</p>
        </div>
        <Button variant="ghost" onClick={users.reload}>
          Refresh
        </Button>
      </div>

      <AsyncView state={users}>
        {(d) => (
          <DataTable<HostedUserRecord>
            rowKey={(u) => u.id}
            empty="No users yet. Users are provisioned when they first sign in via SSO."
            rows={d.users}
            columns={[
              {
                key: 'name',
                header: 'User',
                cell: (u) => (
                  <div className="cell-stack">
                    <strong>{userLabel(u)}</strong>
                    {u.email && <span className="hint">{u.email}</span>}
                    <code className="subtle">{u.subject?.issuer}:{u.subject?.kind}</code>
                  </div>
                ),
              },
              {
                key: 'status',
                header: 'Status',
                cell: (u) => <Badge tone={u.status === 'active' ? 'ok' : 'neutral'}>{u.status}</Badge>,
              },
              { key: 'unit', header: 'Home unit', cell: (u) => <span>{unitName(u.unitId)}</span> },
              {
                key: 'roles',
                header: 'Roles',
                cell: (u) =>
                  (u.roleBindings ?? []).length === 0 ? (
                    <span className="hint">none</span>
                  ) : (
                    <div className="chip-row">
                      {(u.roleBindings ?? []).map((b, i) => (
                        <Badge key={i} tone="accent">
                          {roleList.find((r) => r.id === b.roleId)?.name ?? b.roleId}
                          {b.scopeKind && b.scopeKind !== 'instance' ? ` · ${b.scopeId}` : ''}
                        </Badge>
                      ))}
                    </div>
                  ),
              },
              {
                key: 'act',
                header: '',
                width: '1%',
                cell: (u) => (
                  <div className="row-actions">
                    <Button size="sm" variant="primary" onClick={() => setEditingId(u.id)}>
                      Manage access
                    </Button>
                    {u.status === 'active' ? (
                      <ConfirmButton
                        label="Deactivate"
                        title="Deactivate user"
                        message={`Deactivate ${userLabel(u)}? They keep their audit history but can no longer act.`}
                        confirmLabel="Deactivate"
                        action={() => setStatus(u, 'inactive')}
                        onError={toast.bad}
                      />
                    ) : (
                      <AsyncButton size="sm" action={() => setStatus(u, 'active')} onError={toast.bad}>
                        Reactivate
                      </AsyncButton>
                    )}
                  </div>
                ),
              },
            ]}
          />
        )}
      </AsyncView>

      {editing && (
        <AccessModal
          user={editing}
          roles={roleList}
          scopes={scopes}
          onClose={() => setEditingId(null)}
          onChanged={users.reload}
        />
      )}
    </div>
  );
}
