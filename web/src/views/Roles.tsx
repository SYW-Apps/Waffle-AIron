import { useState } from 'react';
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
  TextInput,
  useAsync,
  useToast,
} from '../ui';
import { CAPABILITIES, type Capability, type PermissionValue, type Role, type RolePermission } from '../types';

/** Roles grant only, so the editable values are the granting three; a role never
 *  denies (`no` is non-deciding during resolution). */
const ROLE_VALUES: PermissionValue[] = ['inherit', 'approval', 'yes'];

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function RoleModal(props: { mode: 'create' | 'edit'; existing?: Role; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const isEdit = props.mode === 'edit';
  const [name, setName] = useState(props.existing?.name ?? '');
  const [description, setDescription] = useState(props.existing?.description ?? '');
  const [perms, setPerms] = useState<Record<Capability, PermissionValue>>(() => {
    const base = Object.fromEntries(CAPABILITIES.map((c) => [c, 'inherit'])) as Record<Capability, PermissionValue>;
    for (const p of props.existing?.permissions ?? []) base[p.capability] = p.value;
    return base;
  });

  async function save() {
    const permissions: RolePermission[] = CAPABILITIES.filter((c) => perms[c] !== 'inherit').map((c) => ({
      capability: c,
      value: perms[c],
    }));
    const role: Partial<Role> = isEdit
      ? { ...props.existing!, name, description, permissions }
      : { id: slugify(name), name, description, permissions };
    await post(isEdit ? '/web/admin/roles/update' : '/web/admin/roles', role);
    toast.ok(isEdit ? 'Role updated' : `Role “${name}” created`);
    props.onSaved();
    props.onClose();
  }

  return (
    <Modal
      title={isEdit ? `Edit role · ${props.existing!.name}` : 'New role'}
      onClose={props.onClose}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <AsyncButton variant="primary" action={save} onError={toast.bad} disabled={!name}>
            {isEdit ? 'Save' : 'Create'}
          </AsyncButton>
        </>
      }
    >
      <div className="stack-lg">
        <Field label="Name">
          <TextInput value={name} onChange={setName} placeholder="Project owner" />
        </Field>
        {!isEdit && (
          <Field label="Id (computed)">
            <code className="preview-id">{slugify(name) || '—'}</code>
          </Field>
        )}
        <Field label="Description">
          <TextInput value={description} onChange={setDescription} placeholder="Full control of assigned projects" />
        </Field>
        <div className="panel">
          <h4>Granted capabilities</h4>
          <p className="hint">Roles grant only — leave a capability on “inherit” to not confer it.</p>
          {CAPABILITIES.map((c) => (
            <div className="row-form" key={c}>
              <code className="cap-name">{c}</code>
              <Select
                value={perms[c]}
                onChange={(v) => setPerms((p) => ({ ...p, [c]: v }))}
                options={ROLE_VALUES.map((v) => ({ value: v, label: v }))}
              />
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}

export function Roles() {
  const toast = useToast();
  const roles = useAsync<{ roles: Role[] }>(() => get('/web/admin/roles'), [], ['roles']);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Role | null>(null);

  async function remove(id: string) {
    await post('/web/admin/roles/remove', { id });
    toast.ok('Role deleted');
    roles.reload();
  }

  return (
    <div className="view-pad">
      <div className="view-head">
        <div>
          <h2>Roles</h2>
          <p className="hint">Reusable permission templates. Assign them to users per scope from the Users page.</p>
        </div>
        <Button variant="primary" onClick={() => setCreating(true)}>
          + New role
        </Button>
      </div>

      <AsyncView state={roles}>
        {(d) => (
          <DataTable<Role>
            rowKey={(r) => r.id}
            rows={d.roles}
            columns={[
              {
                key: 'name',
                header: 'Role',
                cell: (r) => (
                  <div className="cell-stack">
                    <strong>
                      {r.name} {r.builtin && <Badge tone="accent">built-in</Badge>}
                    </strong>
                    {r.description && <span className="hint">{r.description}</span>}
                    <code className="subtle">{r.id}</code>
                  </div>
                ),
              },
              {
                key: 'perms',
                header: 'Grants',
                cell: (r) =>
                  r.permissions.length === 0 ? (
                    <span className="hint">none</span>
                  ) : (
                    <div className="chip-row">
                      {r.permissions.map((p) => (
                        <Badge key={p.capability} tone={p.value === 'yes' ? 'ok' : 'warn'}>
                          {p.capability}={p.value}
                        </Badge>
                      ))}
                    </div>
                  ),
              },
              {
                key: 'act',
                header: '',
                width: '1%',
                cell: (r) =>
                  r.builtin ? (
                    <span className="hint">locked</span>
                  ) : (
                    <div className="row-actions">
                      <Button size="sm" variant="ghost" onClick={() => setEditing(r)}>
                        Edit
                      </Button>
                      <ConfirmButton
                        label="Delete"
                        title="Delete role"
                        message={`Delete role “${r.name}”? Existing bindings to it become inert.`}
                        action={() => remove(r.id)}
                        onError={toast.bad}
                      />
                    </div>
                  ),
              },
            ]}
          />
        )}
      </AsyncView>

      {creating && <RoleModal mode="create" onClose={() => setCreating(false)} onSaved={roles.reload} />}
      {editing && <RoleModal mode="edit" existing={editing} onClose={() => setEditing(null)} onSaved={roles.reload} />}
    </div>
  );
}
