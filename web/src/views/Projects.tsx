import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
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
  TextInput,
  useAsync,
  useToast,
} from '../ui';
import { UnitSelect } from '../components/UnitSelect';
import { familyOrder, PackImpactSummary, type FamilyRow } from './ProjectOps';
import type { GovernedProjectCreation, OrganizationUnitRecord, ProjectRecord } from '../types';

function statusTone(status: string): 'ok' | 'warn' | 'neutral' {
  if (status === 'ready') return 'ok';
  if (status === 'locked') return 'warn';
  return 'neutral';
}

function CreateProjectModal(props: {
  units: OrganizationUnitRecord[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const toast = useToast();
  const [id, setId] = useState('');
  const [unitId, setUnitId] = useState(props.units[0]?.id ?? '');
  // What the instance policy applied at creation. The policy's packs are not the
  // user's choice to confirm, so they are shown afterwards rather than asked about.
  const [created, setCreated] = useState<GovernedProjectCreation | null>(null);

  async function create() {
    const creation = await post<GovernedProjectCreation>('/web/projects', { id, unitId });
    toast.ok(`Project “${id}” created`);
    props.onCreated();
    const applied = (creation.packImpacts?.length ?? 0) > 0 || creation.profileImpact !== undefined;
    if (applied) setCreated(creation);
    else props.onClose();
  }

  if (created) {
    return (
      <Modal
        title={`Project “${created.record.id}” created`}
        wide
        onClose={props.onClose}
        footer={
          <Button variant="primary" onClick={props.onClose}>
            Done
          </Button>
        }
      >
        <div className="stack-lg">
          <p className="hint">
            The instance pack policy applied these at creation, each measured before it was written. Changes are stated, never
            judged — packs exist to adjust wairon's checks.
          </p>
          {created.packImpacts.length > 0 && (
            <div className="stack-sm">
              <strong>Packs applied</strong>
              {created.packImpacts.map((impact) => (
                <PackImpactSummary key={impact.pack} impact={impact} />
              ))}
            </div>
          )}
          {created.profileImpact && (
            <div className="stack-sm">
              <strong>Governing profile</strong>
              <PackImpactSummary impact={created.profileImpact} />
            </div>
          )}
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title="New project"
      onClose={props.onClose}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <AsyncButton variant="primary" action={create} onError={toast.bad} disabled={!id || !unitId}>
            Create
          </AsyncButton>
        </>
      }
    >
      <div className="stack-lg">
        <Field label="Project id" hint="Lowercase identifier, unique on this instance.">
          <TextInput value={id} onChange={(v) => setId(v.toLowerCase())} placeholder="billing" />
        </Field>
        <Field label="Owner unit" hint="Every project belongs to an organization unit.">
          {props.units.length === 0 ? (
            <span className="hint">No units exist yet — create one under Organization first.</span>
          ) : (
            <UnitSelect units={props.units} value={unitId} onChange={setUnitId} allowEmpty={false} placeholder="Choose the owner unit…" />
          )}
        </Field>
      </div>
    </Modal>
  );
}

export function Projects() {
  const toast = useToast();
  const nav = useNavigate();
  const projects = useAsync<{ projects: ProjectRecord[] }>(() => get('/web/projects'), [], ['projects']);
  // Units are only listable by admins; a non-admin creator sees an empty picker
  // rather than a failed load, so tolerate a 403 here.
  const units = useAsync<{ units: OrganizationUnitRecord[] }>(
    () => get<{ units: OrganizationUnitRecord[] }>('/web/admin/org/units').catch(() => ({ units: [] as OrganizationUnitRecord[] })),
    [],
  );
  const [creating, setCreating] = useState(false);
  const [placing, setPlacing] = useState<ProjectRecord | null>(null);

  async function lock(id: string) {
    await post('/web/projects/lock', { projectId: id });
    toast.ok(`Locked ${id}`);
    projects.reload();
  }
  async function destroy(id: string) {
    await post('/web/projects/destroy', { id });
    toast.ok(`Destroyed ${id}`);
    projects.reload();
  }

  return (
    <div className="view-pad">
      <div className="view-head">
        <div>
          <h2>Projects</h2>
          <p className="hint">Every project you can read, write, or administer. Open one to see its architecture canvas.</p>
        </div>
        <Button variant="primary" onClick={() => setCreating(true)}>
          + New project
        </Button>
      </div>

      <AsyncView state={projects}>
        {(d) => (
          <DataTable<FamilyRow>
            rowKey={(r) => r.project.id}
            empty="No projects in your scope yet."
            rows={familyOrder(d.projects)}
            columns={[
              {
                key: 'id',
                header: 'Project',
                cell: ({ project: p, depth }) => (
                  <div className="cell-stack" style={{ paddingLeft: depth * 18 }}>
                    <strong>{depth > 0 ? '↳ ' : ''}{p.id}</strong>
                    {p.parentProjectId && (
                      <span className="hint">
                        member of {d.projects.some((x) => x.id === p.parentProjectId) ? p.parentProjectId : 'a project outside your view'}
                        {p.memberPath ? <> at <code className="subtle">{p.memberPath}</code></> : null}
                      </span>
                    )}
                  </div>
                ),
              },
              {
                key: 'status',
                header: 'Status',
                cell: ({ project: p }) => (
                  <>
                    <Badge tone={statusTone(p.status)}>{p.status}</Badge>
                    {p.status === 'disabled' && p.disabledReason ? <span className="hint"> {p.disabledReason}</span> : null}
                  </>
                ),
              },
              {
                key: 'unit',
                header: 'Unit',
                cell: ({ project: p }) =>
                  p.parentProjectId ? (
                    // A member takes its units from its family root: it is never placed itself.
                    <span className="hint">from its family root</span>
                  ) : (
                    <button className="btn btn-ghost btn-sm" onClick={() => setPlacing(p)} title="Place this project in an organization unit">
                      {p.unitId ? <code className="subtle">{p.unitId}</code> : <span className="hint">— set unit</span>}
                    </button>
                  ),
              },
              {
                key: 'act',
                header: '',
                cell: ({ project: p }) => (
                  <div className="row-actions">
                    <Button size="sm" variant="primary" onClick={() => nav(`/canvas/${encodeURIComponent(p.id)}`)}>
                      Open canvas
                    </Button>
                    <Button size="sm" onClick={() => nav(`/projects/${encodeURIComponent(p.id)}`)}>
                      Ops
                    </Button>
                    <AsyncButton size="sm" action={() => lock(p.id)} onError={toast.bad}>
                      Lock
                    </AsyncButton>
                    <ConfirmButton
                      label="Destroy"
                      title="Destroy project"
                      message={`Deregister project “${p.id}”? This removes it from the instance.`}
                      confirmLabel="Destroy"
                      action={() => destroy(p.id)}
                      onError={toast.bad}
                    />
                  </div>
                ),
              },
            ]}
          />
        )}
      </AsyncView>

      {creating && (
        <CreateProjectModal units={units.data?.units ?? []} onClose={() => setCreating(false)} onCreated={projects.reload} />
      )}
      {placing && (
        <PlaceModal
          project={placing}
          units={units.data?.units ?? []}
          onClose={() => setPlacing(null)}
          onPlaced={() => {
            setPlacing(null);
            projects.reload();
          }}
        />
      )}
    </div>
  );
}

/** Place (or move) a project into an organization unit. */
function PlaceModal(props: {
  project: ProjectRecord;
  units: OrganizationUnitRecord[];
  onClose: () => void;
  onPlaced: () => void;
}) {
  const toast = useToast();
  const [unitId, setUnitId] = useState(props.project.unitId ?? props.units[0]?.id ?? '');

  async function place() {
    await post('/web/admin/org/placements', { projectId: props.project.id, unitId });
    toast.ok(`Placed “${props.project.id}” in ${unitId}`);
    props.onPlaced();
  }

  return (
    <Modal
      title={`Place · ${props.project.id}`}
      onClose={props.onClose}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <AsyncButton variant="primary" action={place} onError={toast.bad} disabled={!unitId}>
            Place
          </AsyncButton>
        </>
      }
    >
      <div className="stack-lg">
        <Field label="Organization unit" hint="Requires admin. Placing a project in a unit makes it visible in that unit's scope.">
          {props.units.length === 0 ? (
            <span className="hint">No units exist (or you can't list them). Create one under Organization first.</span>
          ) : (
            <UnitSelect units={props.units} value={unitId} onChange={setUnitId} allowEmpty={false} placeholder="Choose a unit…" />
          )}
        </Field>
      </div>
    </Modal>
  );
}
