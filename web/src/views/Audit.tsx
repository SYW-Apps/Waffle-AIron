import { useState } from 'react';
import { get } from '../api';
import { AsyncView, Badge, Button, DataTable, Field, Select, TextInput, useAsync } from '../ui';
import { subjectLabel, type AuditEvent } from '../types';

const LEVELS = ['', 'info', 'warning', 'error', 'security'];

function outcomeTone(o: string): 'ok' | 'warn' | 'bad' | 'neutral' {
  if (o === 'success') return 'ok';
  if (o === 'denied' || o === 'failed') return 'bad';
  if (o === 'skipped') return 'warn';
  return 'neutral';
}

/** The scoped, redacted audit-log viewer — filtered server-side to the caller's
 *  project:admin-visible scopes. Never shows raw tokens/secrets. */
export function Audit() {
  const [projectId, setProjectId] = useState('');
  const [minimumLevel, setMinimumLevel] = useState('');
  const [limit, setLimit] = useState('100');
  // Applied filters (the query actually run); editing the inputs doesn't refetch
  // until "Apply" so a big log isn't re-queried on every keystroke.
  const [applied, setApplied] = useState({ projectId: '', minimumLevel: '', limit: '100' });

  const query = new URLSearchParams();
  if (applied.projectId) query.set('projectId', applied.projectId);
  if (applied.minimumLevel) query.set('minimumLevel', applied.minimumLevel);
  if (applied.limit) query.set('limit', applied.limit);
  const events = useAsync<{ events: AuditEvent[] }>(
    () => get(`/web/admin/audit?${query.toString()}`).then((d) => d as { events: AuditEvent[] }),
    [applied.projectId, applied.minimumLevel, applied.limit],
  );

  return (
    <div className="view-pad" style={{ maxWidth: 1320 }}>
      <div className="view-head">
        <div>
          <h2>Audit log</h2>
          <p className="hint">Redacted security &amp; activity events in your scope.</p>
        </div>
        <Button variant="ghost" onClick={events.reload}>
          Refresh
        </Button>
      </div>

      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="row-form">
          <Field label="Project id">
            <TextInput value={projectId} onChange={setProjectId} placeholder="(all)" />
          </Field>
          <Field label="Minimum level">
            <Select
              value={minimumLevel}
              onChange={setMinimumLevel}
              options={LEVELS.map((l) => ({ value: l, label: l || '(any)' }))}
            />
          </Field>
          <Field label="Limit">
            <TextInput value={limit} onChange={setLimit} />
          </Field>
          <div className="row-form-action">
            <Button variant="primary" onClick={() => setApplied({ projectId, minimumLevel, limit })}>
              Apply
            </Button>
          </div>
        </div>
      </div>

      <AsyncView state={events}>
        {(d) => (
          <DataTable<AuditEvent>
            rowKey={(e) => e.id}
            empty="No audit events match."
            rows={d.events ?? []}
            columns={[
              { key: 'ts', header: 'Time', cell: (e) => <span className="hint">{new Date(e.timestamp).toLocaleString()}</span> },
              { key: 'lvl', header: 'Level', cell: (e) => <Badge tone={e.level === 'security' ? 'accent' : e.level === 'error' ? 'bad' : e.level === 'warning' ? 'warn' : 'neutral'}>{e.level}</Badge> },
              { key: 'action', header: 'Action', cell: (e) => <code>{e.action}</code> },
              { key: 'outcome', header: 'Outcome', cell: (e) => <Badge tone={outcomeTone(e.outcome)}>{e.outcome}</Badge> },
              { key: 'actor', header: 'Actor', cell: (e) => <span>{subjectLabel(e.actor)}</span> },
              { key: 'target', header: 'Target', cell: (e) => <code className="subtle">{e.projectId ? `${e.projectId} · ` : ''}{e.target ?? '—'}</code> },
            ]}
          />
        )}
      </AsyncView>
    </div>
  );
}
