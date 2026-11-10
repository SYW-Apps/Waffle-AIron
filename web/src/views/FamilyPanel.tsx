import { useState } from 'react';
import { get, post } from '../api';
import { AsyncButton, AsyncView, Badge, Button, Checkbox, ErrorNote, Field, Modal, Select, TextInput, useAsync, useToast } from '../ui';
import type { DevCommandResult, ExternalStatus } from '../types';
import type { NetworkViewModel } from './NetworkView';
import {
  FAMILY_ACTIONS,
  driftNotices,
  emptyForm,
  externalTone,
  formArgs,
  formOptions,
  formProblem,
  memberRows,
  type CanvasSubsystemLike,
  type FamilyActionDef,
  type FamilyActionId,
  type FamilyForm,
  type MemberRow,
} from './familyPanelLogic';

export { externalTone };

/**
 * The family panel: a project's members, its externals with relation health, and its network state.
 * One component for both surfaces - the hosted Relations tab (read-only, `actions` off) and the dev
 * page's Family tab (`actions` on). The actions run through POST /web/dev/family.
 */

interface Request {
  action: FamilyActionId;
  preset?: Record<string, string>;
}

export function FamilyPanel(props: { projectId: string; actions: boolean }) {
  const { projectId, actions } = props;
  const enc = encodeURIComponent(projectId);
  const channels = [`project:${projectId}`, 'projects'];
  const externals = useAsync<{ externals: ExternalStatus[] }>(
    () => get(`/web/projects/externals?projectId=${enc}`),
    [projectId],
    [...channels, 'externals'],
  );
  const network = useAsync<NetworkViewModel>(() => get(`/web/projects/network?projectId=${enc}`), [projectId], channels);
  const model = useAsync<{ subsystems?: CanvasSubsystemLike[] }>(() => get(`/web/canvas-model?projectId=${enc}`), [projectId], channels);
  const [req, setReq] = useState<Request | null>(null);
  const open = (action: FamilyActionId, preset?: Record<string, string>) => setReq({ action, preset });
  const reloadAll = () => {
    externals.reload();
    network.reload();
    model.reload();
  };
  const notices = driftNotices(externals.data?.externals ?? []);

  return (
    <div className="stack">
      {notices.length > 0 && (
        <div className="syw-card stack-sm" role="status">
          {notices.map((n) => (
            <div key={n.alias} className="row-actions" style={{ justifyContent: 'space-between' }}>
              <span>
                <strong>{n.alias}</strong> is {n.label}.
                {n.reasons.map((r, i) => (
                  <span key={i} className="hint">
                    {' '}
                    {r}.
                  </span>
                ))}
              </span>
              {actions && (
                <Button size="sm" variant="primary" onClick={() => open('externals-pin', { alias: n.alias })}>
                  Pin
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      <section className="stack-sm">
        <div className="row-actions" style={{ justifyContent: 'space-between' }}>
          <h3>Members</h3>
          {actions && (
            <span className="row-actions">
              <Button size="sm" onClick={() => open('member-add')}>
                Add member
              </Button>
              <Button size="sm" onClick={() => open('member-attach')}>
                Attach existing project
              </Button>
            </span>
          )}
        </div>
        <AsyncView state={model}>
          {(m) => {
            const rows = memberRows(m.subsystems ?? []);
            return rows.length === 0 ? <p className="hint">This project has no members.</p> : <MemberList rows={rows} actions={actions} open={open} />;
          }}
        </AsyncView>
      </section>

      <section className="stack-sm">
        <div className="row-actions" style={{ justifyContent: 'space-between' }}>
          <h3>Externals</h3>
          {actions && (
            <span className="row-actions">
              <Button size="sm" onClick={() => open('externals-status')}>
                Check live
              </Button>
              <Button size="sm" onClick={() => open('externals-pin')}>
                Pin all
              </Button>
            </span>
          )}
        </div>
        <AsyncView state={externals}>
          {(d) =>
            d.externals.length === 0 ? (
              <p className="hint">This project declares no externals.</p>
            ) : (
              <div className="stack-sm">
                {d.externals.map((s) => (
                  <ExternalRow key={s.alias} s={s} actions={actions} open={open} />
                ))}
              </div>
            )
          }
        </AsyncView>
      </section>

      <section className="stack-sm">
        <div className="row-actions" style={{ justifyContent: 'space-between' }}>
          <h3>Network</h3>
          {actions && network.data && (
            <span className="row-actions">
              {network.data.networks.some((n) => n.id === '') ? (
                <Button size="sm" onClick={() => open('network-undeclare')}>
                  Remove
                </Button>
              ) : (
                <Button size="sm" onClick={() => open('network-declare')}>
                  Declare
                </Button>
              )}
            </span>
          )}
        </div>
        <AsyncView state={network}>
          {(vm) => {
            const root = vm.networks.find((n) => n.id === '');
            return root ? (
              <div className="syw-card stack-sm">
                <div>
                  <Badge tone="ok">declared</Badge>
                  {root.description ? <span className="hint"> {root.description}</span> : null}
                </div>
                <div className="hint">
                  Gateways: {root.gateways.length === 0 ? 'none' : root.gateways.map((g) => <code key={g}>{g} </code>)}
                </div>
              </div>
            ) : (
              <p className="hint">
                <Badge tone="neutral">not declared</Badge> This project declares no network.
              </p>
            );
          }}
        </AsyncView>
      </section>

      {req && (
        <ActionModal
          key={req.action + JSON.stringify(req.preset ?? {})}
          def={FAMILY_ACTIONS[req.action]}
          preset={req.preset}
          onClose={() => setReq(null)}
          onApplied={reloadAll}
        />
      )}
    </div>
  );
}

function ExternalRow(props: { s: ExternalStatus; actions: boolean; open: (a: FamilyActionId, p?: Record<string, string>) => void }) {
  const { s } = props;
  const health = externalTone(s);
  return (
    <details className="syw-card">
      <summary>
        <strong>{s.alias}</strong> <span className="subtle">→ {s.project}</span> <Badge tone={health.tone}>{health.label}</Badge>{' '}
        <span className="hint">{s.sourceKind}</span>
      </summary>
      {s.detail && <p className="hint">{s.detail}</p>}
      {s.uses.length > 0 && (
        <ul className="finding-list">
          {s.uses.map((u, i) => (
            <li key={i}>
              <code>{[u.publicName, u.member].filter(Boolean).join('.') || '(the external)'}</code> — {u.state}
              {u.detail ? <span className="hint"> — {u.detail}</span> : null}
            </li>
          ))}
        </ul>
      )}
      {props.actions && (
        <div className="row-actions">
          <Button size="sm" onClick={() => props.open('externals-pin', { alias: s.alias })}>
            Pin
          </Button>
          {(s.sourceKind === 'path' || s.sourceKind === 'family') && (
            <Button size="sm" onClick={() => props.open('member-adopt', { alias: s.alias })}>
              Adopt as member
            </Button>
          )}
        </div>
      )}
    </details>
  );
}

function MemberList(props: { rows: MemberRow[]; actions: boolean; open: (a: FamilyActionId, p?: Record<string, string>) => void }) {
  return (
    <div className="stack-sm">
      {props.rows.map((r) => {
        const p = { alias: r.alias };
        return (
          <div key={`${r.kind}:${r.alias}`} className="syw-card stack-sm">
            <div>
              <strong>{r.alias}</strong> <Badge tone={r.kind === 'project' ? 'accent' : 'neutral'}>{r.kind}</Badge>{' '}
              {r.storage && <code className="subtle">{r.storage}</code>}
            </div>
            {r.description && <p className="hint">{r.description}</p>}
            {r.subsystems.length > 0 && <p className="hint">Subsystems: {r.subsystems.join(', ')}</p>}
            {props.actions && (
              <div className="row-actions" style={{ flexWrap: 'wrap' }}>
                <Button size="sm" onClick={() => props.open('member-update', p)}>Update</Button>
                <Button size="sm" onClick={() => props.open('member-move', p)}>Move</Button>
                <Button size="sm" onClick={() => props.open('member-rename-alias', { old: r.alias })}>Rename</Button>
                <Button size="sm" onClick={() => props.open('member-internalize', p)}>Fold in</Button>
                {r.kind === 'project' ? (
                  <>
                    <Button size="sm" onClick={() => props.open('member-detach', p)}>Detach</Button>
                    <Button size="sm" onClick={() => props.open('member-demote', p)}>Demote</Button>
                  </>
                ) : (
                  <Button size="sm" onClick={() => props.open('member-promote', p)}>Promote</Button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── The action form ──────────────────────────────────────────────────────────

function ActionModal(props: { def: FamilyActionDef; preset?: Record<string, string>; onClose: () => void; onApplied: () => void }) {
  const { def } = props;
  const toast = useToast();
  const [form, setForm] = useState<FamilyForm>(() => emptyForm(def, props.preset));
  const [result, setResult] = useState<(DevCommandResult & { applied: boolean }) | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const problem = formProblem(def, form);

  const edit = (next: FamilyForm) => {
    setForm(next);
    setResult(null);
    setConfirming(false);
    setError(undefined);
  };

  async function run(report: boolean) {
    setError(undefined);
    try {
      const r = await post<DevCommandResult>('/web/dev/family', {
        action: def.id,
        args: formArgs(def, form),
        options: formOptions(def, form),
        report,
      });
      setResult({ ...r, applied: !report });
      setConfirming(false);
      if (!report && r.ok) {
        props.onApplied();
        if (def.readOnly) return;
        toast.ok(`${def.label} done.`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const needsConfirm = !def.preview && !def.readOnly;
  const done = result?.applied && result.ok && !def.readOnly;
  const footer = (
    <>
      <Button onClick={props.onClose}>{done ? 'Close' : 'Cancel'}</Button>
      {!done && def.preview && (
        <AsyncButton action={() => run(true)} disabled={!!problem}>
          Preview
        </AsyncButton>
      )}
      {!done && needsConfirm && confirming ? (
        <>
          <span className="hint">Are you sure?</span>
          <Button onClick={() => setConfirming(false)}>No</Button>
          <AsyncButton variant="primary" action={() => run(false)}>
            Yes, {def.label.toLowerCase()}
          </AsyncButton>
        </>
      ) : (
        !done &&
        (needsConfirm ? (
          <Button variant="primary" disabled={!!problem} onClick={() => setConfirming(true)}>
            Apply
          </Button>
        ) : (
          <AsyncButton variant="primary" action={() => run(false)} disabled={!!problem}>
            {def.readOnly ? 'Check live' : 'Apply'}
          </AsyncButton>
        ))
      )}
    </>
  );

  return (
    <Modal title={def.label} onClose={props.onClose} footer={footer} wide>
      <div className="stack-sm">
        <p>{def.text}</p>
        {def.args.map((a) => (
          <Field key={a.name} label={a.label + (a.optional ? ' (optional)' : '')}>
            <TextInput
              value={form.args[a.name] ?? ''}
              placeholder={a.placeholder}
              onChange={(v) => edit({ ...form, args: { ...form.args, [a.name]: v } })}
            />
          </Field>
        ))}
        {def.options.map((o) =>
          o.kind === 'flag' ? (
            <Checkbox
              key={o.name}
              checked={form.options[o.name] === 'true'}
              label={o.label}
              onChange={(c) => edit({ ...form, options: { ...form.options, [o.name]: c ? 'true' : '' } })}
            />
          ) : o.kind === 'choice' ? (
            <Field key={o.name} label={o.label} hint={o.hint}>
              <Select
                value={form.options[o.name] ?? ''}
                options={[{ value: '', label: '(decide later)' }, ...(o.choices ?? []).map((c) => ({ value: c, label: c }))]}
                onChange={(v) => edit({ ...form, options: { ...form.options, [o.name]: v } })}
              />
            </Field>
          ) : (
            <Field key={o.name} label={`${o.label} (optional)`} hint={o.hint}>
              <TextInput value={form.options[o.name] ?? ''} onChange={(v) => edit({ ...form, options: { ...form.options, [o.name]: v } })} />
            </Field>
          ),
        )}
        {problem && <p className="hint">{problem}</p>}
        {error && <ErrorNote>{error}</ErrorNote>}
        {result && (
          <div className="stack-sm">
            <strong>
              {result.applied ? 'Result' : 'Preview'} <Badge tone={result.ok ? 'ok' : 'bad'}>{result.ok ? 'ok' : 'failed'}</Badge>
            </strong>
            <pre className="syw-code" style={{ whiteSpace: 'pre-wrap', maxHeight: '18rem', overflow: 'auto' }}>
              {result.output.join('\n') || '(no output)'}
            </pre>
          </div>
        )}
      </div>
    </Modal>
  );
}
